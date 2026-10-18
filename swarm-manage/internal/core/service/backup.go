package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

// Backups de bases (v9, #166).
//
// El agente entra en el contenedor de la base con `docker exec` y hace el
// backup ahí, con la herramienta de la propia base y **la contraseña que ese
// contenedor ya tiene en su entorno**: la orden sólo nombra la variable
// (`"$MSSQL_SA_PASSWORD"`) y la expande el shell del contenedor. Ni cac ni
// este agente ven nunca su valor.
//
// Lo cifra con age para los destinatarios que manda el backend (la llave de
// la organización y la de restauración de este servidor), lo guarda cifrado en
// el temporal del agente, y lo sube con la URL firmada que da el backend. Lo
// temporal se borra salga como salga.

// BackupJob: lo que manda el backend. Tiene que casar con `domain.BackupJob`.
type BackupJob struct {
	BackupID       string   `json:"backupId"`
	Kind           string   `json:"kind"`
	ServiceName    string   `json:"serviceName"`
	Engine         string   `json:"engine"`
	Database       string   `json:"database"`
	CredentialEnv  string   `json:"credentialEnv"`
	Recipients     []string `json:"recipients"`
	SourceBackupID string   `json:"sourceBackupId,omitempty"`
	SourceSha256   string   `json:"sourceSha256,omitempty"`
}

// Presigned: una petición firmada a S3. Casa con `domain.PresignedRequest`.
type Presigned struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// Las mismas formas que valida el backend: esto va a una shell.
var (
	backupDBPattern      = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	backupEnvPattern     = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	backupServicePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
)

// RestoreTestPrefix: el agente sólo borra bases con este nombre.
const RestoreTestPrefix = "cac_restore_test_"

// mssqlBackupDir: dentro del volumen de datos de SQL Server, que es donde hay
// sitio y donde el usuario `mssql` puede escribir.
const mssqlBackupDir = "/var/opt/mssql/data/cac-backups"

// maxSinglePut: el tope de S3 para una sola subida.
const maxSinglePut = 5 << 30

func (j BackupJob) Validate() error {
	switch {
	case j.BackupID == "":
		return errors.New("the job has no backup id")
	case j.Engine != "mssql" && j.Engine != "postgres":
		return fmt.Errorf("engine %q is not supported", j.Engine)
	case !backupServicePattern.MatchString(j.ServiceName):
		return fmt.Errorf("%q is not a service name", j.ServiceName)
	case !backupDBPattern.MatchString(j.Database):
		return fmt.Errorf("%q is not a database name", j.Database)
	case !backupEnvPattern.MatchString(j.CredentialEnv):
		return fmt.Errorf("%q is not an environment variable name", j.CredentialEnv)
	case j.Kind != "restore_test" && len(j.Recipients) == 0:
		return errors.New("nobody to encrypt for")
	}
	return nil
}

// BackupDocker: lo que el runner necesita de Docker.
type BackupDocker interface {
	ContainerForService(ctx context.Context, service string) (string, error)
	Exec(ctx context.Context, container string, cmd []string, env []string, stdout io.Writer) (repository.ExecResult, error)
	CopyFrom(ctx context.Context, container, file string) (io.ReadCloser, int64, error)
	CopyTo(ctx context.Context, container, dir, name string, size int64, content io.Reader) error
}

// BackupBackend: lo que el runner le cuenta y le pide al backend.
type BackupBackend interface {
	BackupLog(ctx context.Context, id, line string)
	BackupUploadURL(ctx context.Context, id string, size int64, sha string) (*Presigned, error)
	BackupDownloadURL(ctx context.Context, id string) (*Presigned, error)
	BackupFinish(ctx context.Context, id, status, errMsg string) error
}

type BackupRunner struct {
	Docker  BackupDocker
	Backend BackupBackend
	// HTTP para hablar con S3. **Sin** el token de cac: la URL firmada es la
	// única credencial que hace falta, y mandarle a AWS el token del agente
	// sería regalarlo.
	S3 *http.Client
	// TempDir y FreeBytes: dónde se deja el cifrado y cuánto sitio hay.
	TempDir   string
	FreeBytes func(dir string) (int64, error)
	// Identity: la llave privada de restauración de este servidor, para la
	// prueba. nil = este agente no puede probar restauraciones.
	Identity age.Identity
}

func NewBackupRunner(docker BackupDocker, backend BackupBackend, identity age.Identity) *BackupRunner {
	return &BackupRunner{
		Docker: docker, Backend: backend, S3: &http.Client{},
		TempDir: repository.TempDir(), FreeBytes: repository.FreeBytes, Identity: identity,
	}
}

// Run hace el trabajo y siempre lo cierra con un Finish.
func (r *BackupRunner) Run(ctx context.Context, raw json.RawMessage) {
	var job BackupJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return
	}
	log := func(format string, a ...any) { r.Backend.BackupLog(ctx, job.BackupID, fmt.Sprintf(format, a...)) }
	err := job.Validate()
	if err == nil {
		if job.Kind == "restore_test" {
			err = r.restoreTest(ctx, job, log)
		} else {
			err = r.backup(ctx, job, log)
		}
	}
	status, msg := "succeeded", ""
	if err != nil {
		status, msg = "failed", err.Error()
		log("✗ %s", msg)
	}
	for i := 0; i < 5; i++ {
		if r.Backend.BackupFinish(ctx, job.BackupID, status, msg) == nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(i+1) * 2 * time.Second):
		}
	}
}

// ─── El backup ────────────────────────────────────────────────────────────────

func (r *BackupRunner) backup(ctx context.Context, job BackupJob, log func(string, ...any)) error {
	recipients := make([]age.Recipient, 0, len(job.Recipients))
	for _, k := range job.Recipients {
		rc, err := age.ParseX25519Recipient(k)
		if err != nil {
			return fmt.Errorf("bad recipient key: %w", err)
		}
		recipients = append(recipients, rc)
	}
	container, err := r.Docker.ContainerForService(ctx, job.ServiceName)
	if err != nil {
		return err
	}
	size, err := r.databaseSize(ctx, container, job)
	if err != nil {
		return fmt.Errorf("could not measure the database: %w", err)
	}
	log("%s %s: %d MB", job.Engine, job.Database, size>>20)
	// El doble y un margen: el cifrado vive aquí hasta que sube, y en SQL
	// Server el `.bak` vive además un rato en el volumen de la base.
	if free, err := r.FreeBytes(r.TempDir); err == nil && free < 2*size+(256<<20) {
		return fmt.Errorf("not enough disk: %d MB free, %d MB needed", free>>20, (2*size+(256<<20))>>20)
	}

	f, err := os.CreateTemp(r.TempDir, "cac-backup-*.age")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	sum := sha256.New()
	enc, err := age.Encrypt(io.MultiWriter(f, sum), recipients...)
	if err != nil {
		return err
	}
	switch job.Engine {
	case "mssql":
		err = r.dumpMSSQL(ctx, container, job, enc, log)
	case "postgres":
		err = r.dumpPostgres(ctx, container, job, enc, log)
	}
	if err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maxSinglePut {
		return fmt.Errorf("the encrypted backup is %d MB; a single upload takes up to 5 GB", info.Size()>>20)
	}
	sha := hex.EncodeToString(sum.Sum(nil))
	log("cifrado para %d destinatarios: %d MB, sha256 %s…", len(recipients), info.Size()>>20, sha[:12])

	put, err := r.Backend.BackupUploadURL(ctx, job.BackupID, info.Size(), sha)
	if err != nil {
		return fmt.Errorf("upload url: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	start := time.Now()
	if err := r.upload(ctx, put, f, info.Size()); err != nil {
		return err
	}
	log("subido en %s", time.Since(start).Round(time.Second))
	return nil
}

// databaseSize: cuánto ocupa la base, para saber si cabe antes de empezar.
func (r *BackupRunner) databaseSize(ctx context.Context, container string, job BackupJob) (int64, error) {
	var out bytes.Buffer
	var res repository.ExecResult
	var err error
	switch job.Engine {
	case "mssql":
		q := "SET NOCOUNT ON; SELECT CAST(SUM(CAST(size AS bigint))*8*1024 AS bigint) FROM sys.master_files WHERE database_id = DB_ID(N'" + job.Database + "')"
		res, err = r.Docker.Exec(ctx, container, []string{"sh", "-c", sqlcmd(job.CredentialEnv) + ` -h -1 -W -Q "$Q"`}, []string{"Q=" + q}, &out)
	case "postgres":
		res, err = r.Docker.Exec(ctx, container, []string{"sh", "-c",
			`psql -U "$` + job.CredentialEnv + `" -d postgres -tAc "SELECT pg_database_size('$DB')"`}, []string{"DB=" + job.Database}, &out)
	}
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, fmt.Errorf("exit %d: %s", res.ExitCode, firstLines(res.Stderr+out.String(), 5))
	}
	n, err := strconv.ParseInt(strings.TrimSpace(out.String()), 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("the database %q does not exist or is empty", job.Database)
	}
	return n, nil
}

// sqlcmd: la orden de sqlcmd con la contraseña **por nombre**. La imagen de
// SQL Server 2022 la trae en mssql-tools18; las anteriores, en mssql-tools.
func sqlcmd(credentialEnv string) string {
	return `"$(command -v /opt/mssql-tools18/bin/sqlcmd || command -v /opt/mssql-tools/bin/sqlcmd)" -S localhost -U sa -P "$` +
		credentialEnv + `" -C -b`
}

// dumpMSSQL: `BACKUP` a un fichero dentro del volumen de la base, verificado,
// y de ahí al cifrado. El guion va por fichero (sin comillas que escapar en
// tres capas de shell) y la ruta como variable de sqlcmd.
func (r *BackupRunner) dumpMSSQL(ctx context.Context, container string, job BackupJob, enc io.Writer, log func(string, ...any)) error {
	bak := mssqlBackupDir + "/" + job.BackupID + ".bak"
	script := mssqlBackupDir + "/" + job.BackupID + ".sql"
	defer r.Docker.Exec(context.Background(), container, []string{"rm", "-f", bak, script}, nil, nil)
	if res, err := r.Docker.Exec(ctx, container, []string{"mkdir", "-p", mssqlBackupDir}, nil, nil); err != nil || res.ExitCode != 0 {
		return fmt.Errorf("could not create %s: %v %s", mssqlBackupDir, err, res.Stderr)
	}
	sql := MSSQLBackupScript(job.Database)
	if err := r.Docker.CopyTo(ctx, container, mssqlBackupDir, job.BackupID+".sql", int64(len(sql)), strings.NewReader(sql)); err != nil {
		return err
	}
	var out bytes.Buffer
	res, err := r.Docker.Exec(ctx, container, []string{"sh", "-c", sqlcmd(job.CredentialEnv) + ` -v F="$F" -i "$S"`},
		[]string{"F=" + bak, "S=" + script}, &out)
	if err != nil {
		return err
	}
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			log("  %s", l)
		}
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("BACKUP failed (exit %d): %s", res.ExitCode, firstLines(res.Stderr+out.String(), 8))
	}
	rd, _, err := r.Docker.CopyFrom(ctx, container, bak)
	if err != nil {
		return err
	}
	defer rd.Close()
	_, err = io.Copy(enc, rd)
	return err
}

// MSSQLBackupScript: el guion del backup. La base va entre corchetes (su
// nombre ya pasó por la forma: no lleva `]`), la ruta como `$(F)`.
func MSSQLBackupScript(database string) string {
	return "BACKUP DATABASE [" + database + "] TO DISK = N'$(F)' WITH COPY_ONLY, COMPRESSION, CHECKSUM;\n" +
		"RESTORE VERIFYONLY FROM DISK = N'$(F)' WITH CHECKSUM;\n"
}

// dumpPostgres: `pg_dump` en formato custom, en streaming hasta el cifrado.
func (r *BackupRunner) dumpPostgres(ctx context.Context, container string, job BackupJob, enc io.Writer, log func(string, ...any)) error {
	res, err := r.Docker.Exec(ctx, container, []string{"sh", "-c",
		`pg_dump -Fc --no-owner -U "$` + job.CredentialEnv + `" -d "$DB"`}, []string{"DB=" + job.Database}, enc)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("pg_dump failed (exit %d): %s", res.ExitCode, firstLines(res.Stderr, 8))
	}
	log("  pg_dump terminó")
	return nil
}

// upload sube el fichero con la URL firmada y sus cabeceras, tal cual.
func (r *BackupRunner) upload(ctx context.Context, p *Presigned, f io.Reader, size int64) error {
	req, err := http.NewRequestWithContext(ctx, p.Method, p.URL, f)
	if err != nil {
		return err
	}
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	req.ContentLength = size
	res, err := r.S3.Do(req)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("upload refused: %s %s", res.Status, s3ErrorText(body))
	}
	return nil
}

// s3ErrorText saca el código y el mensaje del XML de S3, sin el resto.
func s3ErrorText(body []byte) string {
	code := between(string(body), "<Code>", "</Code>")
	msg := between(string(body), "<Message>", "</Message>")
	if code == "" {
		return firstLines(string(body), 2)
	}
	return code + ": " + msg
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	if j := strings.Index(s, b); j >= 0 {
		return s[:j]
	}
	return ""
}

func firstLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, " / ")
}

// ─── La prueba de restauración ────────────────────────────────────────────────

// RestoreTestName: la base temporal de una prueba. Sólo letras, números y
// guiones bajos del id, detrás del prefijo que la guarda reconoce.
func RestoreTestName(backupID string) string {
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.ToLower(backupID))
	if len(clean) > 32 {
		clean = clean[:32]
	}
	return RestoreTestPrefix + clean
}

// guardDrop: la única puerta para borrar una base. Si el nombre no lleva el
// prefijo de las pruebas, no se borra nada, venga de donde venga.
func guardDrop(name string) error {
	if !strings.HasPrefix(name, RestoreTestPrefix) || !backupDBPattern.MatchString(name) {
		return fmt.Errorf("refusing to drop %q: only %s* databases", name, RestoreTestPrefix)
	}
	return nil
}

func (r *BackupRunner) restoreTest(ctx context.Context, job BackupJob, log func(string, ...any)) error {
	if r.Identity == nil {
		return errors.New("this agent has no restore key yet")
	}
	container, err := r.Docker.ContainerForService(ctx, job.ServiceName)
	if err != nil {
		return err
	}
	get, err := r.Backend.BackupDownloadURL(ctx, job.BackupID)
	if err != nil {
		return fmt.Errorf("download url: %w", err)
	}
	enc, err := os.CreateTemp(r.TempDir, "cac-restore-*.age")
	if err != nil {
		return err
	}
	defer os.Remove(enc.Name())
	defer enc.Close()
	sum := sha256.New()
	n, err := r.download(ctx, get, io.MultiWriter(enc, sum))
	if err != nil {
		return err
	}
	if job.SourceSha256 != "" && hex.EncodeToString(sum.Sum(nil)) != job.SourceSha256 {
		return errors.New("the downloaded backup does not match its sha256")
	}
	log("descargado: %d MB, sha256 correcto", n>>20)
	if free, err := r.FreeBytes(r.TempDir); err == nil && free < 3*n+(256<<20) {
		return fmt.Errorf("not enough disk to restore: %d MB free", free>>20)
	}
	if _, err := enc.Seek(0, io.SeekStart); err != nil {
		return err
	}
	plain, err := age.Decrypt(enc, r.Identity)
	if err != nil {
		return fmt.Errorf("could not decrypt with this server's restore key: %w", err)
	}
	dec, err := os.CreateTemp(r.TempDir, "cac-restore-*.raw")
	if err != nil {
		return err
	}
	defer os.Remove(dec.Name())
	defer dec.Close()
	size, err := io.Copy(dec, plain)
	if err != nil {
		return fmt.Errorf("decrypt: %w", err)
	}
	if _, err := dec.Seek(0, io.SeekStart); err != nil {
		return err
	}
	name := RestoreTestName(job.BackupID)
	var tables int
	switch job.Engine {
	case "mssql":
		tables, err = r.restoreMSSQL(ctx, container, job, name, dec, size, log)
	case "postgres":
		tables, err = r.restorePostgres(ctx, container, job, name, dec, size, log)
	}
	if err != nil {
		return err
	}
	if tables == 0 {
		return errors.New("the restored database has no tables")
	}
	log("✓ restaurada con %d tablas, y borrada", tables)
	return nil
}

func (r *BackupRunner) download(ctx context.Context, p *Presigned, w io.Writer) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	res, err := r.S3.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return 0, fmt.Errorf("download refused: %s %s", res.Status, s3ErrorText(body))
	}
	return io.Copy(w, res.Body)
}

// restoreMSSQL restaura en la misma instancia como `name`, comprueba con
// CHECKDB, cuenta tablas y la borra. Los nombres lógicos de los ficheros se
// leen del propio backup (FILELISTONLY) para moverlos a ficheros nuevos.
func (r *BackupRunner) restoreMSSQL(ctx context.Context, container string, job BackupJob, name string, f io.Reader, size int64, log func(string, ...any)) (int, error) {
	if err := guardDrop(name); err != nil {
		return 0, err
	}
	bak := mssqlBackupDir + "/" + name + ".bak"
	script := mssqlBackupDir + "/" + name + ".sql"
	run := func(sql string, out io.Writer) (repository.ExecResult, error) {
		if err := r.Docker.CopyTo(ctx, container, mssqlBackupDir, name+".sql", int64(len(sql)), strings.NewReader(sql)); err != nil {
			return repository.ExecResult{}, err
		}
		return r.Docker.Exec(ctx, container, []string{"sh", "-c", sqlcmd(job.CredentialEnv) + ` -h -1 -W -s "|" -v F="$F" -i "$S"`},
			[]string{"F=" + bak, "S=" + script}, out)
	}
	defer func() {
		drop := "IF DB_ID(N'" + name + "') IS NOT NULL BEGIN ALTER DATABASE [" + name + "] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [" + name + "]; END\n"
		if guardDrop(name) == nil {
			run(drop, nil)
		}
		r.Docker.Exec(context.Background(), container, []string{"rm", "-f", bak, script}, nil, nil)
	}()
	if res, err := r.Docker.Exec(ctx, container, []string{"mkdir", "-p", mssqlBackupDir}, nil, nil); err != nil || res.ExitCode != 0 {
		return 0, fmt.Errorf("could not create %s", mssqlBackupDir)
	}
	if err := r.Docker.CopyTo(ctx, container, mssqlBackupDir, name+".bak", size, f); err != nil {
		return 0, err
	}
	var files bytes.Buffer
	res, err := run("SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = N'$(F)';\n", &files)
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, fmt.Errorf("FILELISTONLY failed: %s", firstLines(res.Stderr+files.String(), 5))
	}
	restore, err := MSSQLRestoreScript(name, files.String())
	if err != nil {
		return 0, err
	}
	var out bytes.Buffer
	res, err = run(restore, &out)
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, fmt.Errorf("RESTORE failed: %s", firstLines(res.Stderr+out.String(), 8))
	}
	return lastNumber(out.String())
}

// MSSQLRestoreScript arma el RESTORE con un MOVE por fichero lógico (de la
// salida de FILELISTONLY, columnas separadas por `|`), seguido de CHECKDB y
// del recuento de tablas.
func MSSQLRestoreScript(name, fileList string) (string, error) {
	if err := guardDrop(name); err != nil {
		return "", err
	}
	var moves []string
	sc := bufio.NewScanner(strings.NewReader(fileList))
	i := 0
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "|")
		if len(cols) < 3 || strings.TrimSpace(cols[0]) == "" {
			continue
		}
		logical := strings.ReplaceAll(strings.TrimSpace(cols[0]), "'", "''")
		ext := ".mdf"
		if strings.TrimSpace(cols[2]) == "L" {
			ext = ".ldf"
		}
		moves = append(moves, fmt.Sprintf("MOVE N'%s' TO N'/var/opt/mssql/data/%s_%d%s'", logical, name, i, ext))
		i++
	}
	if len(moves) == 0 {
		return "", errors.New("the backup lists no files")
	}
	return "RESTORE DATABASE [" + name + "] FROM DISK = N'$(F)' WITH " + strings.Join(moves, ", ") + ", RECOVERY;\n" +
		"DBCC CHECKDB ([" + name + "]) WITH NO_INFOMSGS;\n" +
		"SET NOCOUNT ON; SELECT COUNT(*) FROM [" + name + "].sys.tables;\n", nil
}

// restorePostgres crea la base temporal, restaura con pg_restore, cuenta
// tablas y la borra.
func (r *BackupRunner) restorePostgres(ctx context.Context, container string, job BackupJob, name string, f io.Reader, size int64, log func(string, ...any)) (int, error) {
	if err := guardDrop(name); err != nil {
		return 0, err
	}
	user := `"$` + job.CredentialEnv + `"`
	dump := "/tmp/" + name + ".dump"
	psql := func(db, sql string, out io.Writer) (repository.ExecResult, error) {
		return r.Docker.Exec(ctx, container, []string{"sh", "-c", `psql -U ` + user + ` -d "$D" -v ON_ERROR_STOP=1 -tAc "$Q"`},
			[]string{"D=" + db, "Q=" + sql}, out)
	}
	defer func() {
		if guardDrop(name) == nil {
			psql("postgres", `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`, nil)
		}
		r.Docker.Exec(context.Background(), container, []string{"rm", "-f", dump}, nil, nil)
	}()
	if res, err := psql("postgres", `CREATE DATABASE "`+name+`"`, nil); err != nil || res.ExitCode != 0 {
		return 0, fmt.Errorf("CREATE DATABASE failed: %v %s", err, firstLines(res.Stderr, 4))
	}
	if err := r.Docker.CopyTo(ctx, container, "/tmp", name+".dump", size, f); err != nil {
		return 0, err
	}
	res, err := r.Docker.Exec(ctx, container, []string{"sh", "-c", `pg_restore --no-owner -U ` + user + ` -d "$D" "$F"`},
		[]string{"D=" + name, "F=" + dump}, nil)
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, fmt.Errorf("pg_restore failed: %s", firstLines(res.Stderr, 8))
	}
	var out bytes.Buffer
	if res, err := psql(name, "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')", &out); err != nil || res.ExitCode != 0 {
		return 0, fmt.Errorf("counting tables failed: %v %s", err, firstLines(res.Stderr, 4))
	}
	return lastNumber(out.String())
}

// lastNumber: el último número de una salida (el recuento que cierra el
// guion).
func lastNumber(s string) (int, error) {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if n, err := strconv.Atoi(strings.TrimSpace(lines[i])); err == nil {
			return n, nil
		}
	}
	return 0, fmt.Errorf("no table count in the output: %s", firstLines(s, 4))
}
