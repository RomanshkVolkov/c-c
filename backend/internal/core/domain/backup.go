package domain

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Backups de bases de datos (#166).
//
// Una BackupTarget es una base de un servidor que se respalda con su horario y
// su retención. Cada ejecución es un Backup. Lo hace el agente del servidor
// dentro del contenedor de la base —con la contraseña que ese contenedor ya
// tiene en su entorno: aquí sólo se guarda **el nombre** de la variable—, lo
// cifra con age para los destinatarios de la organización y lo sube a S3 con
// una URL firmada que lleva el Object Lock hasta `RetainUntil`.

const (
	BackupEngineMSSQL    = "mssql"
	BackupEnginePostgres = "postgres"

	BackupQueued    = "queued"
	BackupRunning   = "running"
	BackupSucceeded = "succeeded"
	BackupFailed    = "failed"

	BackupKindScheduled   = "scheduled"
	BackupKindManual      = "manual"
	BackupKindRestoreTest = "restore_test"

	RetentionRegular = "regular"
	RetentionWeekly  = "weekly"
	RetentionMonthly = "monthly"

	// Lo más que se guarda del log de un backup.
	BackupLogMax = 256 << 10
	// Un backup «en curso» sin que el agente cierre en este tiempo se da por
	// perdido: si no, la base quedaría bloqueada para siempre por el índice de
	// un solo backup vivo.
	BackupStaleAfter = 60 * time.Minute
	// AgentVersionBackups: la primera versión del agente que sabe hacerlos.
	AgentVersionBackups = 9
)

type BackupTarget struct {
	BaseModel
	OrgID    string `gorm:"type:varchar(36);not null;index" json:"orgId"`
	ServerID string `gorm:"type:varchar(36);not null;index" json:"serverId"`
	// ServiceName: el servicio de Swarm de la base (`sqlserver-prod_db`).
	ServiceName string `gorm:"type:varchar(200);not null" json:"serviceName"`
	Engine      string `gorm:"type:varchar(20);not null" json:"engine"`
	Database    string `gorm:"type:varchar(128);not null" json:"database"`
	// CredentialEnv: el **nombre** de la variable de entorno del contenedor con
	// la credencial (`MSSQL_SA_PASSWORD`, `POSTGRES_USER`). Nunca su valor:
	// el agente la lee dentro del contenedor y no sale de ahí.
	CredentialEnv string `gorm:"type:varchar(64);not null" json:"credentialEnv"`

	// El horario: cada `EveryHours` horas a partir de `AnchorTime` (HH:MM) en
	// `Timezone`. Ver NextBackupRun.
	EveryHours int    `gorm:"not null;default:24" json:"everyHours"`
	AnchorTime string `gorm:"type:varchar(5);not null;default:'03:30'" json:"anchorTime"`
	Timezone   string `gorm:"type:varchar(64);not null;default:'America/Mexico_City'" json:"timezone"`

	// La retención. Ver RetentionFor.
	KeepDays    int `gorm:"not null;default:7" json:"keepDays"`
	KeepWeekly  int `gorm:"not null;default:4" json:"keepWeekly"`
	KeepMonthly int `gorm:"not null;default:6" json:"keepMonthly"`

	// Cada cuántos días se prueba restaurar el último bueno; 0 lo apaga.
	RestoreTestEveryDays int `gorm:"not null;default:7" json:"restoreTestEveryDays"`

	Enabled           bool       `gorm:"not null;default:true" json:"enabled"`
	NextRunAt         *time.Time `gorm:"index" json:"nextRunAt,omitempty"`
	LastSuccessAt     *time.Time `json:"lastSuccessAt,omitempty"`
	NextRestoreTestAt *time.Time `json:"nextRestoreTestAt,omitempty"`
	LastRestoreTestAt *time.Time `json:"lastRestoreTestAt,omitempty"`
	LastRestoreTestOK *bool      `json:"lastRestoreTestOk,omitempty"`
	// StaleNotifiedAt: cuándo se avisó de que se quedó sin backup. Se borra
	// con el siguiente bueno, para avisar una vez por racha y no en cada vuelta
	// del reloj.
	StaleNotifiedAt *time.Time `json:"-"`
}

type Backup struct {
	BaseModel
	OrgID          string `gorm:"type:varchar(36);not null;index" json:"orgId"`
	ServerID       string `gorm:"type:varchar(36);not null;index" json:"serverId"`
	TargetID       string `gorm:"type:varchar(36);not null;index" json:"targetId"`
	Kind           string `gorm:"type:varchar(20);not null" json:"kind"`
	Status         string `gorm:"type:varchar(20);not null;index" json:"status"`
	RetentionClass string `gorm:"type:varchar(20);not null;default:''" json:"retentionClass"`
	// RequestedBy: quién lo pidió a mano; vacío = el reloj.
	RequestedBy string `gorm:"type:varchar(36);not null;default:''" json:"requestedBy,omitempty"`
	// SourceBackupID: en una prueba de restauración, el backup que se probó.
	SourceBackupID string     `gorm:"type:varchar(36);not null;default:''" json:"sourceBackupId,omitempty"`
	ObjectKey      string     `gorm:"type:varchar(400);not null;default:''" json:"objectKey,omitempty"`
	ObjectVersion  string     `gorm:"type:varchar(200);not null;default:''" json:"-"`
	SizeBytes      int64      `gorm:"not null;default:0" json:"sizeBytes"`
	Sha256         string     `gorm:"type:varchar(64);not null;default:''" json:"sha256,omitempty"`
	RetainUntil    *time.Time `json:"retainUntil,omitempty"`
	Log            string     `gorm:"type:text" json:"log,omitempty"`
	Error          string     `gorm:"type:text" json:"error"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	FinishedAt     *time.Time `json:"finishedAt,omitempty"`
	// PurgedAt: cuándo lo borró el conserje de S3, vencido. La fila se queda
	// como historia.
	PurgedAt *time.Time `json:"purgedAt,omitempty"`
}

// BackupRecipient: una llave pública age para la que se cifran los backups de
// una organización (la de jose), o de un solo servidor (la de restauración que
// genera su agente: `ServerID` puesto).
type BackupRecipient struct {
	BaseModel
	OrgID     string `gorm:"type:varchar(36);not null;index" json:"orgId"`
	ServerID  string `gorm:"type:varchar(36);not null;default:''" json:"serverId,omitempty"`
	Label     string `gorm:"type:varchar(120);not null" json:"label"`
	PublicKey string `gorm:"type:varchar(80);not null" json:"publicKey"`
}

// ─── Reglas ───────────────────────────────────────────────────────────────────

var (
	backupDatabasePattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	backupEnvPattern      = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	backupServicePattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
	anchorPattern         = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	// Una llave pública age X25519: `age1` y 58 caracteres de bech32.
	agePublicKeyPattern = regexp.MustCompile(`^age1[02-9ac-hj-np-z]{58}$`)
)

// BackupEveryHours: los intervalos que se pueden elegir. Los que dividen el
// día o son días enteros, para que «a las 03:30» sea siempre las 03:30 de la
// pared, también el día que se cambia la hora.
var BackupEveryHours = []int{1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168}

// ValidAgePublicKey: una llave pública age bien formada.
func ValidAgePublicKey(s string) bool { return agePublicKeyPattern.MatchString(s) }

// Validate comprueba lo que va a acabar en una shell del servidor (la base, la
// variable, el servicio) y que el horario y la retención tienen sentido.
func (t *BackupTarget) Validate() error {
	switch {
	case t.Engine != BackupEngineMSSQL && t.Engine != BackupEnginePostgres:
		return fmt.Errorf("engine %q: only mssql or postgres", t.Engine)
	case !backupServicePattern.MatchString(t.ServiceName):
		return fmt.Errorf("%q is not a Swarm service name", t.ServiceName)
	case !backupDatabasePattern.MatchString(t.Database):
		return fmt.Errorf("%q is not a valid database name", t.Database)
	case strings.HasPrefix(t.Database, RestoreTestPrefix):
		// La guarda de la prueba de restauración borra lo que lleva ese prefijo.
		return fmt.Errorf("a database cannot be named %q*: that prefix is reserved for restore tests", RestoreTestPrefix)
	case !backupEnvPattern.MatchString(t.CredentialEnv):
		return fmt.Errorf("%q is not an environment variable name", t.CredentialEnv)
	case !validEveryHours(t.EveryHours):
		return fmt.Errorf("every %d hours is not allowed: pick 1, 2, 3, 4, 6, 8, 12, 24, 48, 72 or 168", t.EveryHours)
	case !anchorPattern.MatchString(t.AnchorTime):
		return fmt.Errorf("time %q is not HH:MM", t.AnchorTime)
	case t.KeepDays < 1 || t.KeepDays > 365:
		return fmt.Errorf("days to keep must be between 1 and 365")
	case t.KeepWeekly < 0 || t.KeepWeekly > 104:
		return fmt.Errorf("weeks to keep must be between 0 and 104")
	case t.KeepMonthly < 0 || t.KeepMonthly > 120:
		return fmt.Errorf("months to keep must be between 0 and 120")
	case t.RestoreTestEveryDays < 0 || t.RestoreTestEveryDays > 90:
		return fmt.Errorf("restore test interval must be between 0 (off) and 90 days")
	}
	if _, err := time.LoadLocation(t.Timezone); err != nil {
		return fmt.Errorf("unknown time zone %q", t.Timezone)
	}
	return nil
}

func validEveryHours(h int) bool {
	for _, v := range BackupEveryHours {
		if v == h {
			return true
		}
	}
	return false
}

// RestoreTestPrefix: el nombre de las bases temporales de una prueba de
// restauración. El agente sólo borra bases con este prefijo.
const RestoreTestPrefix = "cac_restore_test_"

// NextBackupRun: la primera hora del horario estrictamente después de `after`.
//
// Las horas se arman con `time.Date` en la zona de la base, así que son horas
// **de pared**: «cada 6 h desde las 03:30» son las 03:30, 09:30, 15:30 y
// 21:30 de Ciudad de México también el día del cambio de horario. Calcularlo
// sumando horas a un instante en UTC correría el horario una hora dos veces al
// año. Con más de 24 h, cuenta días enteros desde una fecha fija, para que
// «cada 3 días» no dependa de cuándo se creó la base.
func NextBackupRun(t BackupTarget, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(t.Timezone)
	if err != nil {
		return time.Time{}, err
	}
	var hh, mm int
	if _, err := fmt.Sscanf(t.AnchorTime, "%d:%d", &hh, &mm); err != nil {
		return time.Time{}, err
	}
	if !validEveryHours(t.EveryHours) {
		return time.Time{}, fmt.Errorf("invalid interval %d", t.EveryHours)
	}
	local := after.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)

	if t.EveryHours <= 24 {
		// Las horas del día: el ancla y cada `EveryHours` desde ella, dando la
		// vuelta (ancla 21:00 cada 6 h → 03:00, 09:00, 15:00, 21:00). Se
		// prueban hoy, mañana y pasado —el hueco más grande es un día— y gana
		// la primera que pasa.
		var best time.Time
		for d := 0; d < 3; d++ {
			base := day.AddDate(0, 0, d)
			for i := 0; i < 24/t.EveryHours; i++ {
				c := time.Date(base.Year(), base.Month(), base.Day(), (hh+i*t.EveryHours)%24, mm, 0, 0, loc)
				if c.After(after) && (best.IsZero() || c.Before(best)) {
					best = c
				}
			}
		}
		if best.IsZero() {
			return time.Time{}, fmt.Errorf("no next run time")
		}
		return best, nil
	}

	every := t.EveryHours / 24
	epoch := time.Date(2000, 1, 1, 0, 0, 0, 0, loc)
	for d := 0; d <= every+1; d++ {
		base := day.AddDate(0, 0, d)
		days := daysBetween(epoch, base)
		if days%every != 0 {
			continue
		}
		c := time.Date(base.Year(), base.Month(), base.Day(), hh, mm, 0, 0, loc)
		if c.After(after) {
			return c, nil
		}
	}
	return time.Time{}, fmt.Errorf("no next run day")
}

// daysBetween cuenta días de calendario, no bloques de 24 h: un día con
// cambio de horario dura 23 o 25.
func daysBetween(a, b time.Time) int {
	ua := time.Date(a.Year(), a.Month(), a.Day(), 0, 0, 0, 0, time.UTC)
	ub := time.Date(b.Year(), b.Month(), b.Day(), 0, 0, 0, 0, time.UTC)
	return int(ub.Sub(ua).Hours() / 24)
}

// RetentionFor: la clase de un backup que se hace ahora y hasta cuándo se
// guarda (la fecha que viaja como Object Lock).
//
// El primero de un mes nuevo —en la zona de la base— es `monthly`; el primero
// de una semana ISO nueva, `weekly`; el resto, `regular`. «Primero» respecto
// al último bueno: si el del día 1 falló, el del día 2 se queda como el del
// mes. Una clase con 0 a guardar cae a la siguiente.
func RetentionFor(t BackupTarget, now time.Time, lastSuccess *time.Time) (string, time.Time) {
	loc, err := time.LoadLocation(t.Timezone)
	if err != nil {
		loc = time.UTC
	}
	n := now.In(loc)
	newMonth, newWeek := true, true
	if lastSuccess != nil {
		l := lastSuccess.In(loc)
		newMonth = l.Year() != n.Year() || l.Month() != n.Month()
		ly, lw := l.ISOWeek()
		ny, nw := n.ISOWeek()
		newWeek = ly != ny || lw != nw
	}
	day := 24 * time.Hour
	switch {
	case newMonth && t.KeepMonthly > 0:
		return RetentionMonthly, now.Add(time.Duration(t.KeepMonthly) * 31 * day)
	case (newMonth || newWeek) && t.KeepWeekly > 0:
		return RetentionWeekly, now.Add(time.Duration(t.KeepWeekly) * 7 * day)
	}
	keep := t.KeepDays
	if keep < 1 {
		keep = 1
	}
	return RetentionRegular, now.Add(time.Duration(keep) * day)
}

// BackupStaleAfterFor: cuánto puede pasar sin un backup bueno antes de avisar.
// El doble del intervalo, y nunca menos del intervalo más dos horas: con uno
// cada hora, avisar a las dos horas de silencio sería avisar de un hipo.
func BackupStaleAfterFor(t BackupTarget) time.Duration {
	every := time.Duration(t.EveryHours) * time.Hour
	if d := every + 2*time.Hour; d > 2*every {
		return d
	}
	return 2 * every
}

// BackupObjectKey: dónde vive en el bucket. Por organización, servidor y base,
// con la fecha delante del id para que listar salga en orden.
func BackupObjectKey(prefix string, b *Backup, t *BackupTarget, at time.Time) string {
	return fmt.Sprintf("%s/%s/%s/%s/%s-%s.%s.age",
		strings.Trim(prefix, "/"), b.OrgID, b.ServerID, t.ID,
		at.UTC().Format("20060102T150405Z"), b.ID, backupExtension(t.Engine))
}

func backupExtension(engine string) string {
	if engine == BackupEnginePostgres {
		return "dump"
	}
	return "bak"
}

// BackupFailedKind: la clase de aviso de un fallo, según lo que falló.
func BackupFailedKind(kind string) string {
	if kind == BackupKindRestoreTest {
		return "backup:restore_failed"
	}
	return "backup:failed"
}

// ─── Trabajos del agente y DTOs ───────────────────────────────────────────────

// BackupJob: lo que recibe el agente. Las llaves públicas para cifrar van
// dentro: el agente no tiene por qué preguntar a quién.
type BackupJob struct {
	BackupID      string   `json:"backupId"`
	Kind          string   `json:"kind"`
	ServiceName   string   `json:"serviceName"`
	Engine        string   `json:"engine"`
	Database      string   `json:"database"`
	CredentialEnv string   `json:"credentialEnv"`
	Recipients    []string `json:"recipients"`
	// En una prueba de restauración: el backup a restaurar.
	SourceBackupID string `json:"sourceBackupId,omitempty"`
	SourceSha256   string `json:"sourceSha256,omitempty"`
}

// AgentUploadURLRequest: el agente ya tiene el fichero cifrado y pide dónde
// subirlo. El tamaño y el sha256 entran en la firma: S3 rechaza un fichero
// que no sea exactamente ése.
type AgentUploadURLRequest struct {
	SizeBytes int64  `json:"sizeBytes" validate:"required,min=1"`
	Sha256    string `json:"sha256"    validate:"required,len=64,hexadecimal"`
}

// PresignedRequest: una petición firmada a S3, con las cabeceras que hay que
// mandar tal cual.
type PresignedRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

type AgentBackupFinishRequest struct {
	Status string `json:"status" validate:"required,oneof=succeeded failed"`
	Error  string `json:"error"`
}

type BackupTargetRequest struct {
	ServiceName          string `json:"serviceName"          validate:"required,max=200"`
	Engine               string `json:"engine"               validate:"required,oneof=mssql postgres"`
	Database             string `json:"database"             validate:"required,max=128"`
	CredentialEnv        string `json:"credentialEnv"        validate:"required,max=64"`
	EveryHours           int    `json:"everyHours"           validate:"required"`
	AnchorTime           string `json:"anchorTime"           validate:"required,len=5"`
	Timezone             string `json:"timezone"             validate:"required,max=64"`
	KeepDays             int    `json:"keepDays"`
	KeepWeekly           int    `json:"keepWeekly"`
	KeepMonthly          int    `json:"keepMonthly"`
	RestoreTestEveryDays int    `json:"restoreTestEveryDays"`
	Enabled              *bool  `json:"enabled"`
}

type BackupRecipientRequest struct {
	Label     string `json:"label"     validate:"required,max=120"`
	PublicKey string `json:"publicKey" validate:"required,max=80"`
}
