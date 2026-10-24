package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

// De punta a punta contra bases de verdad, sólo con CAC_DOCKER_IT=1 (y
// CAC_DOCKER_IT_MSSQL=1 para SQL Server, cuya imagen pesa 1,5 GB): lo que hacen
// pg_dump, pg_restore, BACKUP y RESTORE … FILELISTONLY no lo contesta un
// doble. Un servidor HTTP hace de S3.
//
// Para cada motor: una base con una tabla y filas → backup → la llave «de
// jose» lo abre → prueba de restauración con la llave del servidor → la base
// temporal ya no existe.

// realContainer: el Docker de verdad, salvo encontrar el contenedor (aquí no
// hay Swarm).
type realContainer struct {
	*repository.DockerClient
	id string
}

func (r realContainer) ContainerForService(context.Context, string) (string, error) { return r.id, nil }

// fakeS3 guarda lo que se sube y lo devuelve al bajarlo.
type fakeS3 struct {
	mu   sync.Mutex
	body []byte
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == http.MethodPut {
		f.body, _ = io.ReadAll(r.Body)
		return
	}
	w.Write(f.body)
}

type e2eBackend struct {
	fakeBackupBackend
	s3 string
}

func (b *e2eBackend) BackupDownloadURL(context.Context, string) (*Presigned, error) {
	return &Presigned{Method: "GET", URL: b.s3 + "/obj"}, nil
}

func startContainer(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", append([]string{"run", "-d", "--rm"}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run: %v %s", err, out)
	}
	id := strings.TrimSpace(string(out))
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", id).Run() })
	return id
}

func dockerExec(t *testing.T, id string, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", append([]string{"exec", id}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker exec %v: %v %s", args, err, out)
	}
	return string(out)
}

func waitFor(t *testing.T, what string, try func() bool) {
	t.Helper()
	for i := 0; i < 90; i++ {
		if try() {
			return
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("%s no arrancó", what)
}

func roundTrip(t *testing.T, id, engine, env string, opts ...func(*BackupJob)) {
	t.Helper()
	roundTripWith(t, realContainer{repository.NewDockerClient(), id}, engine, env, opts...)
}

func roundTripWith(t *testing.T, docker BackupDocker, engine, env string, opts ...func(*BackupJob)) {
	t.Helper()
	jose, _ := age.GenerateX25519Identity()
	server, _ := age.GenerateX25519Identity()
	s3 := &fakeS3{}
	srv := httptest.NewServer(s3)
	defer srv.Close()
	backend := &e2eBackend{s3: srv.URL}
	backend.put = &Presigned{Method: "PUT", URL: srv.URL + "/obj"}
	r := NewBackupRunner(docker, backend, server)
	r.TempDir = t.TempDir()

	job := BackupJob{BackupID: "b-e2e-1", Kind: "scheduled", ServiceName: "db", Engine: engine, Database: "boaty",
		CredentialEnv: env, Recipients: []string{jose.Recipient().String(), server.Recipient().String()}}
	for _, o := range opts {
		o(&job)
	}
	r.Run(context.Background(), mustJSON(t, job))
	if backend.status != "succeeded" {
		t.Fatalf("backup %s: %s\n%s", backend.status, backend.errMsg, strings.Join(backend.lines, "\n"))
	}
	if _, err := age.Decrypt(bytes.NewReader(s3.body), jose); err != nil {
		t.Fatalf("la llave de jose no abre el backup: %v", err)
	}

	t.Logf("log del backup:\n%s", strings.Join(backend.lines, "\n"))
	backend.status, backend.lines = "", nil
	test := BackupJob{BackupID: "b-e2e-2", Kind: "restore_test", ServiceName: "db", Engine: engine, Database: "boaty", CredentialEnv: env}
	for _, o := range opts {
		o(&test)
	}
	r.Run(context.Background(), mustJSON(t, test))
	if backend.status != "succeeded" {
		t.Fatalf("prueba de restauración %s: %s\n%s", backend.status, backend.errMsg, strings.Join(backend.lines, "\n"))
	}
	if !strings.Contains(strings.Join(backend.lines, "\n"), "contenido: 1 tabla, 500 filas") {
		t.Errorf("el log no dice que restauró la tabla:\n%s", strings.Join(backend.lines, "\n"))
	}
	t.Logf("log de la prueba:\n%s", strings.Join(backend.lines, "\n"))
	left, _ := os.ReadDir(r.TempDir)
	if len(left) != 0 {
		t.Errorf("quedó en el temporal: %v", left)
	}
}

func TestPostgresBackupAndRestoreForReal(t *testing.T) {
	if os.Getenv("CAC_DOCKER_IT") != "1" {
		t.Skip("CAC_DOCKER_IT no está puesto")
	}
	id := startContainer(t, "-e", "POSTGRES_USER=app", "-e", "POSTGRES_PASSWORD=s3cr3t", "-e", "POSTGRES_DB=boaty", "postgres:16-alpine")
	waitFor(t, "postgres", func() bool {
		return exec.Command("docker", "exec", id, "psql", "-U", "app", "-d", "boaty", "-c", "select 1").Run() == nil
	})
	dockerExec(t, id, "psql", "-U", "app", "-d", "boaty", "-c",
		"CREATE TABLE trips (id serial primary key, name text); INSERT INTO trips (name) SELECT 'viaje ' || g FROM generate_series(1,500) g;")
	roundTrip(t, id, "postgres", "POSTGRES_USER")
	if out := dockerExec(t, id, "psql", "-U", "app", "-d", "postgres", "-tAc", "SELECT count(*) FROM pg_database WHERE datname LIKE 'cac_restore_test_%'"); strings.TrimSpace(out) != "0" {
		t.Errorf("quedó la base temporal: %s", out)
	}
}

// Como boaty-postgres (23-oct-2026): un contenedor suelto, no de Swarm,
// buscado por su nombre; el usuario `postgres` tal cual; la contraseña en un
// fichero (`POSTGRES_PASSWORD_FILE`). El socket local también pide contraseña
// (`--auth-local`), así que sin leer el fichero no entra nadie.
// Roturas que atrapa: no leer el `_FILE`; usar la variable como usuario
// teniendo `Username`; no buscar el contenedor por nombre.
func TestAPostgresContainerWithAPasswordFileForReal(t *testing.T) {
	if os.Getenv("CAC_DOCKER_IT") != "1" {
		t.Skip("CAC_DOCKER_IT no está puesto")
	}
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/pg", []byte("s3cr3t-del-fichero"), 0o644); err != nil {
		t.Fatal(err)
	}
	name := "cac-it-boaty-postgres"
	exec.Command("docker", "rm", "-f", name).Run()
	id := startContainer(t, "--name", name, "-v", dir+"/pg:/run/secrets/pg:ro",
		"-e", "POSTGRES_PASSWORD_FILE=/run/secrets/pg", "-e", "POSTGRES_DB=boaty",
		"-e", "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256", "postgres:17-alpine")
	asPostgres := func(args ...string) *exec.Cmd {
		return exec.Command("docker", append([]string{"exec", "-e", "PGPASSWORD=s3cr3t-del-fichero", id, "psql", "-U", "postgres"}, args...)...)
	}
	waitFor(t, "postgres", func() bool { return asPostgres("-d", "boaty", "-c", "select 1").Run() == nil })
	if exec.Command("docker", "exec", id, "psql", "-U", "postgres", "-d", "boaty", "-c", "select 1").Run() == nil {
		t.Fatal("el socket entra sin contraseña: la prueba no probaría el fichero")
	}
	if out, err := asPostgres("-d", "boaty", "-c",
		"CREATE TABLE trips (id serial primary key, name text); INSERT INTO trips (name) SELECT 'viaje ' || g FROM generate_series(1,500) g;").CombinedOutput(); err != nil {
		t.Fatalf("datos: %v %s", err, out)
	}
	roundTripWith(t, repository.NewDockerClient(), "postgres", "POSTGRES_PASSWORD_FILE", func(j *BackupJob) {
		j.ServiceName, j.Username = name, "postgres"
	})
}

func TestMSSQLBackupAndRestoreForReal(t *testing.T) {
	if os.Getenv("CAC_DOCKER_IT_MSSQL") != "1" {
		t.Skip("CAC_DOCKER_IT_MSSQL no está puesto")
	}
	id := startContainer(t, "-e", "ACCEPT_EULA=Y", "-e", "MSSQL_SA_PASSWORD=Str0ng!Passw0rd", "-e", "MSSQL_PID=Developer",
		"mcr.microsoft.com/mssql/server:2022-latest")
	sq := func(q string) (string, error) {
		out, err := exec.Command("docker", "exec", id, "/opt/mssql-tools18/bin/sqlcmd", "-S", "localhost", "-U", "sa",
			"-P", "Str0ng!Passw0rd", "-C", "-b", "-h", "-1", "-W", "-Q", q).CombinedOutput()
		return string(out), err
	}
	waitFor(t, "sql server", func() bool { _, err := sq("SELECT 1"); return err == nil })
	if out, err := sq("CREATE DATABASE boaty"); err != nil {
		t.Fatal(out)
	}
	if out, err := sq("USE boaty; CREATE TABLE trips (id int identity primary key, name nvarchar(100)); INSERT INTO trips (name) SELECT TOP 500 'viaje' FROM sys.all_objects;"); err != nil {
		t.Fatal(out)
	}
	roundTrip(t, id, "mssql", "MSSQL_SA_PASSWORD")
	out, _ := sq("SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name LIKE 'cac_restore_test_%'")
	if strings.TrimSpace(out) != "0" {
		t.Errorf("quedó la base temporal: %s", out)
	}
	if out := dockerExec(t, id, "sh", "-c", "ls /var/opt/mssql/data/cac-backups/ 2>/dev/null | wc -l"); strings.TrimSpace(out) != "0" {
		t.Errorf("quedaron ficheros en el volumen de la base: %s", out)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := jsonMarshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var jsonMarshal = func(v any) ([]byte, error) { return json.Marshal(v) }
