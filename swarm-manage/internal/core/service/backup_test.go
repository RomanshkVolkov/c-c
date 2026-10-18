package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"filippo.io/age"

	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

// fakeBackupDocker hace de Docker: apunta cada orden y contesta lo que toca.
type fakeBackupDocker struct {
	mu      sync.Mutex
	cmds    []string
	copied  map[string][]byte
	dump    []byte // lo que «sale» del contenedor (pg_dump o el .bak)
	sizeOut string // lo que contesta la consulta de tamaño
}

func (f *fakeBackupDocker) ContainerForService(context.Context, string) (string, error) {
	return "c1", nil
}
func (f *fakeBackupDocker) Exec(_ context.Context, _ string, cmd, env []string, stdout io.Writer) (repository.ExecResult, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, strings.Join(cmd, " ")+" ENV "+strings.Join(env, ","))
	f.mu.Unlock()
	joined := strings.Join(cmd, " ")
	switch {
	case strings.Contains(joined, "pg_database_size") || strings.Contains(joined, `-h -1 -W -Q "$Q"`):
		io.WriteString(stdout, f.sizeOut)
	case strings.Contains(joined, "pg_dump"):
		stdout.Write(f.dump)
	}
	return repository.ExecResult{}, nil
}
func (f *fakeBackupDocker) CopyFrom(context.Context, string, string) (io.ReadCloser, int64, error) {
	return io.NopCloser(bytes.NewReader(f.dump)), int64(len(f.dump)), nil
}
func (f *fakeBackupDocker) CopyTo(_ context.Context, _, dir, name string, _ int64, r io.Reader) error {
	b, _ := io.ReadAll(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.copied == nil {
		f.copied = map[string][]byte{}
	}
	f.copied[dir+"/"+name] = b
	return nil
}
func (f *fakeBackupDocker) ran(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.cmds {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

type fakeBackupBackend struct {
	mu        sync.Mutex
	put       *Presigned
	putErr    error
	status    string
	errMsg    string
	lines     []string
	sha, size string
}

func (b *fakeBackupBackend) BackupLog(_ context.Context, _, line string) {
	b.mu.Lock()
	b.lines = append(b.lines, line)
	b.mu.Unlock()
}
func (b *fakeBackupBackend) BackupUploadURL(_ context.Context, _ string, _ int64, _ string) (*Presigned, error) {
	return b.put, b.putErr
}
func (b *fakeBackupBackend) BackupDownloadURL(context.Context, string) (*Presigned, error) {
	return nil, errors.New("no")
}
func (b *fakeBackupBackend) BackupFinish(_ context.Context, _, status, errMsg string) error {
	b.status, b.errMsg = status, errMsg
	return nil
}

func backupJob(t *testing.T, engine string, recipients ...string) json.RawMessage {
	t.Helper()
	env := "MSSQL_SA_PASSWORD"
	if engine == "postgres" {
		env = "POSTGRES_USER"
	}
	raw, _ := json.Marshal(BackupJob{BackupID: "b-1", Kind: "scheduled", ServiceName: "db", Engine: engine,
		Database: "boaty", CredentialEnv: env, Recipients: recipients})
	return raw
}

func runner(t *testing.T, d *fakeBackupDocker, b *fakeBackupBackend, free int64) *BackupRunner {
	r := NewBackupRunner(d, b, nil)
	r.TempDir = t.TempDir()
	r.FreeBytes = func(string) (int64, error) { return free, nil }
	return r
}

// Lo cifrado se abre con las llaves a las que va dirigido y con ninguna otra,
// y llega a «S3» sin el token de cac.
// Mutantes: cifrar sólo para el primero; mandar la cabecera Authorization.
func TestABackupIsEncryptedForItsRecipientsAndUploadedWithoutTheAgentToken(t *testing.T) {
	jose, _ := age.GenerateX25519Identity()
	server, _ := age.GenerateX25519Identity()
	stranger, _ := age.GenerateX25519Identity()

	var got []byte
	var auth string
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		got, _ = io.ReadAll(r.Body)
	}))
	defer s3.Close()

	d := &fakeBackupDocker{dump: []byte("PGDMP datos de la base"), sizeOut: "1048576\n"}
	b := &fakeBackupBackend{put: &Presigned{Method: "PUT", URL: s3.URL + "/obj", Headers: map[string]string{"X-Amz-Checksum-Sha256": "x"}}}
	runner(t, d, b, 10<<30).Run(context.Background(), backupJob(t, "postgres", jose.Recipient().String(), server.Recipient().String()))

	if b.status != "succeeded" {
		t.Fatalf("acabó %s: %s\n%s", b.status, b.errMsg, strings.Join(b.lines, "\n"))
	}
	if auth != "" {
		t.Errorf("la subida a S3 llevó Authorization: %q", auth)
	}
	for name, id := range map[string]age.Identity{"jose": jose, "servidor": server} {
		r, err := age.Decrypt(bytes.NewReader(got), id)
		if err != nil {
			t.Fatalf("%s no lo abre: %v", name, err)
		}
		plain, _ := io.ReadAll(r)
		if string(plain) != string(d.dump) {
			t.Errorf("%s abrió otra cosa: %q", name, plain)
		}
	}
	if _, err := age.Decrypt(bytes.NewReader(got), stranger); err == nil {
		t.Error("una tercera llave lo abrió")
	}
}

// La contraseña va **por nombre**: el shell del contenedor la expande. El
// agente no la conoce, así que lo que se comprueba es que la orden la pide
// así, entre comillas dobles, y que el guion no la lleva.
// Mutante: pasarle a sqlcmd el nombre de la variable como si fuera la
// contraseña.
func TestTheMSSQLPasswordIsReadInsideTheContainer(t *testing.T) {
	d := &fakeBackupDocker{dump: []byte("bak"), sizeOut: "1048576"}
	b := &fakeBackupBackend{put: &Presigned{Method: "PUT", URL: "http://127.0.0.1:1/x"}}
	runner(t, d, b, 10<<30).Run(context.Background(), backupJob(t, "mssql", mustRecipient(t)))
	if !d.ran(`-P "$MSSQL_SA_PASSWORD"`) {
		t.Errorf("sqlcmd no lee la variable del contenedor:\n%s", strings.Join(d.cmds, "\n"))
	}
	for path, content := range d.copied {
		if strings.Contains(string(content), "MSSQL_SA_PASSWORD") {
			t.Errorf("el guion %s nombra la credencial", path)
		}
	}
}

// Lo temporal se borra también cuando falla la subida: el .bak y el .sql
// dentro del contenedor y el cifrado del agente.
// Mutante: limpiar sólo al ir bien.
func TestABackupCleansUpEvenWhenTheUploadFails(t *testing.T) {
	d := &fakeBackupDocker{dump: []byte("bak"), sizeOut: "1048576"}
	b := &fakeBackupBackend{putErr: errors.New("backend caído")}
	r := runner(t, d, b, 10<<30)
	r.Run(context.Background(), backupJob(t, "mssql", mustRecipient(t)))
	if b.status != "failed" {
		t.Fatalf("acabó %s", b.status)
	}
	if !d.ran("rm -f /var/opt/mssql/data/cac-backups/b-1.bak /var/opt/mssql/data/cac-backups/b-1.sql") {
		t.Errorf("no borró lo de dentro del contenedor:\n%s", strings.Join(d.cmds, "\n"))
	}
	left, _ := filepath.Glob(filepath.Join(r.TempDir, "cac-backup-*"))
	if len(left) != 0 {
		t.Errorf("quedó en el temporal: %v", left)
	}
}

// Sin sitio no empieza: ni un BACKUP a medias llenando el disco del servidor.
// Mutante: no mirar el disco.
func TestABackupWithoutRoomDoesNotStart(t *testing.T) {
	d := &fakeBackupDocker{dump: []byte("bak"), sizeOut: "1073741824"} // 1 GB
	b := &fakeBackupBackend{}
	runner(t, d, b, 512<<20).Run(context.Background(), backupJob(t, "mssql", mustRecipient(t)))
	if b.status != "failed" || !strings.Contains(b.errMsg, "not enough disk") {
		t.Fatalf("acabó %s: %s", b.status, b.errMsg)
	}
	if d.ran("BACKUP") || len(d.copied) != 0 {
		t.Errorf("empezó igual:\n%s", strings.Join(d.cmds, "\n"))
	}
}

// La única puerta para borrar una base sólo deja pasar las de las pruebas.
// Mutante: quitar la guarda (y con ella, un nombre ajeno llega al DROP).
func TestOnlyRestoreTestDatabasesCanBeDropped(t *testing.T) {
	if guardDrop("boaty") == nil || guardDrop("master") == nil || guardDrop(RestoreTestPrefix+"x; DROP") == nil {
		t.Error("la guarda dejó pasar una base ajena")
	}
	if name := RestoreTestName("A1-b2/../x"); guardDrop(name) != nil || !strings.HasPrefix(name, RestoreTestPrefix) {
		t.Errorf("el nombre de la prueba %q no pasa su propia guarda", name)
	}
	if _, err := MSSQLRestoreScript("boaty", "boaty_lts|/x.mdf|D\n"); err == nil {
		t.Error("el guion de restauración aceptó restaurar sobre una base ajena")
	}
	s, err := MSSQLRestoreScript(RestoreTestName("b-1"), "boaty_lts|/var/opt/mssql/data/boaty.mdf|D|PRIMARY\nboaty_lts_log|/x.ldf|L|NULL\n")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "MOVE N'boaty_lts' TO") || !strings.Contains(s, "_1.ldf'") || !strings.Contains(s, "DBCC CHECKDB") {
		t.Errorf("el guion:\n%s", s)
	}
}

func mustRecipient(t *testing.T) string {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id.Recipient().String()
}

var _ = os.Remove
