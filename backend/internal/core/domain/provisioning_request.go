package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

/*
Una petición de ejecución: un agente (o una persona) pide aplicar un playbook a
un servidor, y cac decide si se puede, con el protocolo del diseño «Ejecución
por agentes con riesgo evaluado y protocolo» (aprobado por jose el 31-oct-2026,
decisión 4d28f4ab):

 1. ensayo (`--check --diff`, lo corre la máquina de quien pide);
 2. evaluación del ensayo aquí, con `EvaluateCheck`;
 3. aprobación de una persona **en persona** (nunca con un token);
 4. ejecución con una autorización de un solo uso que caduca;
 5. verificación con el playbook `verify`;
 6. registro de cada paso.

La política es fija y no la cambia ninguna configuración ni ningún token: sólo
lo de lectura (`read`) va pre-autorizado, y sólo si el ensayo dice que no
cambiaría nada y no levanta ninguna bandera. Todo lo demás espera a una
persona. **También en un servidor de pruebas**: allí es un simulacro, y el
protocolo es el mismo (jose: «aunque sean de pruebas se debe seguir el
protocolo a modo de simulacro, es importante siempre»). Por eso aquí no hay
ningún campo que distinga un servidor de pruebas: no hay nada que relajar.

Lo que no protege, y por qué no hace falta que lo haga: el riesgo lo declara el
manifiesto del repo, y lo manda quien pide. Un agente que mintiera («swarm es
read») chocaría con tres cosas: el ensayo diría que cambia algo (bandera roja,
no se pre-autoriza), `cac provision run` compara el riesgo con el manifiesto
antes de correr, y si aun así una ejecución de lectura cambiara algo, su recap
la delata al cerrar (`ProvisioningRequestViolated`). Y el último candado es el
1Password de la persona, que pide su huella para cada lectura de un secreto.
*/

// El riesgo que declara un playbook en `cac.playbooks.yml`.
const (
	RiskRead        = "read"
	RiskChange      = "change"
	RiskDestructive = "destructive"
)

// Los estados de una petición.
const (
	// Abierta, esperando el ensayo.
	ProvisioningRequestChecking = "checking"
	// Ensayada; espera a una persona.
	ProvisioningRequestAwaiting = "awaiting_approval"
	// Autorizada (por una persona o, si es de lectura y limpia, por la
	// política). Se puede correr una vez, antes de `GrantExpiresAt`.
	ProvisioningRequestApproved = "approved"
	ProvisioningRequestRejected = "rejected"
	// La autorización se gastó: está corriendo.
	ProvisioningRequestRunning = "running"
	// Corrió bien; falta su `verify`.
	ProvisioningRequestVerifying    = "verifying"
	ProvisioningRequestSucceeded    = "succeeded"
	ProvisioningRequestFailed       = "failed"
	ProvisioningRequestVerifyFailed = "verify_failed"
	// Una ejecución autorizada como lectura cambió algo según su recap.
	ProvisioningRequestViolated = "violated"
	// Se pasó su plazo sin correr, o sin decidir. No se guarda: se calcula al
	// leer (`Expired`), y la condición de gastar la autorización ya mira la
	// hora en la misma sentencia.
	ProvisioningRequestExpired = "expired"
)

const (
	// Lo que dura una autorización. Corta a propósito: lo aprobado es el
	// ensayo de ahora, y una máquina cambia.
	ProvisioningGrantTTL = 15 * time.Minute
	// Lo que una petición ensayada espera a que alguien decida. Pasado eso
	// el ensayo ya no dice nada de la máquina: se pide otra.
	ProvisioningDecisionTTL = 24 * time.Hour

	provisioningDiffBytes = 32 << 10
)

// Banderas: lo que la evaluación del ensayo encuentra.
const (
	FlagRed   = "red"
	FlagAmber = "amber"
	FlagInfo  = "info"

	FlagCheckFailed     = "check-failed"
	FlagUnreachable     = "unreachable"
	FlagHostCount       = "host-count"
	FlagReadWouldChange = "read-would-change"
	FlagTouchesAccess   = "touches-access"
	FlagDestructive     = "destructive"
	FlagChanges         = "changes"
)

var (
	ErrBadRisk             = errors.New("bad-risk")
	ErrVerifyRequired      = errors.New("verify-required")
	ErrRollbackRequired    = errors.New("rollback-required")
	ErrRequestNotFound     = errors.New("provisioning-request-not-found")
	ErrRequestState        = errors.New("provisioning-request-state")
	ErrRequestExpired      = errors.New("provisioning-request-expired")
	ErrInPersonOnly        = errors.New("in-person-only")
	ErrConfirmServerName   = errors.New("confirm-server-name")
	ErrAcknowledgeFlags    = errors.New("acknowledge-flags")
	ErrGrantRequired       = errors.New("grant-required")
	ErrGrantMismatch       = errors.New("grant-mismatch")
	ErrConfigSeqRequired   = errors.New("config-seq-required")
	ErrPlaybookNotInConfig = errors.New("playbook-not-in-config")
)

// ProvisioningCheck es lo que dijo el ensayo (`--check --diff`). Sin valores:
// la salida ya pasó por el tachado de la máquina que lo corrió, y aquí se
// acota otra vez.
type ProvisioningCheck struct {
	Hosts       []string `json:"hosts"       validate:"max=50,dive,max=200"`
	Ok          int      `json:"ok"          validate:"min=0"`
	Changed     int      `json:"changed"     validate:"min=0"`
	Unreachable int      `json:"unreachable" validate:"min=0"`
	Failed      int      `json:"failed"      validate:"min=0"`
	// Las tareas que cambiarían, por su nombre.
	ChangedTasks []string `json:"changedTasks" validate:"max=500,dive,max=300"`
	// Los ficheros que tocaría el diff (las cabeceras `--- before: /etc/…`).
	Paths    []string `json:"paths"    validate:"max=500,dive,max=500"`
	Diff     string   `json:"diff"`
	ExitCode int      `json:"exitCode"`
}

// RiskFlag es una cosa que la evaluación encontró. `red` pide que quien
// aprueba la reconozca a propósito; `amber` e `info` sólo se enseñan, y
// cualquiera de las tres quita la pre-autorización de una lectura.
type RiskFlag struct {
	Code   string `json:"code"`
	Level  string `json:"level"`
	Detail string `json:"detail,omitempty"`
}

// ProvisioningRequest: ver el comentario de arriba.
type ProvisioningRequest struct {
	BaseModel
	OrgID    string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	ServerID string `gorm:"type:varchar(36);index;not null" json:"serverId"`
	// El id del playbook en el manifiesto (`swarm`), y el repo de donde sale.
	Playbook string `gorm:"type:varchar(64);not null" json:"playbook"`
	Project  string `gorm:"type:varchar(200)" json:"project"`
	Risk     string `gorm:"type:varchar(12);not null" json:"risk"`
	// Lo que comprueba que salió bien, y lo que lo deshace. El rollback nunca
	// corre solo: si la verificación falla, se propone como otra petición.
	Verify   string `gorm:"type:varchar(64)" json:"verify,omitempty"`
	Rollback string `gorm:"type:varchar(64)" json:"rollback,omitempty"`
	// La versión de la config con la que se ensayó y con la que correrá.
	ConfigSeq int `gorm:"not null" json:"configSeq"`
	// Por qué lo pide quien lo pide, en sus palabras.
	Reason      string `gorm:"type:text" json:"reason"`
	RequestedBy string `gorm:"type:varchar(36);not null" json:"requestedBy"`
	// mcp | app: por dónde entró.
	Source string `gorm:"type:varchar(10);not null" json:"source"`
	Status string `gorm:"type:varchar(20);index;not null" json:"status"`

	Check     *ProvisioningCheck `gorm:"column:dry_run;type:jsonb;serializer:json" json:"check,omitempty"`
	Flags     []RiskFlag         `gorm:"type:jsonb;serializer:json" json:"flags"`
	CheckedAt *time.Time         `json:"checkedAt,omitempty"`

	// Quién decidió y cuándo. Vacío con `AutoApproved`: la política.
	DecidedBy    string     `gorm:"type:varchar(36)" json:"decidedBy,omitempty"`
	DecidedAt    *time.Time `json:"decidedAt,omitempty"`
	DecisionNote string     `gorm:"type:text" json:"decisionNote,omitempty"`
	AutoApproved bool       `json:"autoApproved"`

	GrantExpiresAt *time.Time `json:"grantExpiresAt,omitempty"`
	// Las ejecuciones que gastaron la autorización: la del playbook y la de
	// su verificación.
	RunID       string `gorm:"type:varchar(36)" json:"runId,omitempty"`
	VerifyRunID string `gorm:"type:varchar(36)" json:"verifyRunId,omitempty"`
}

// ProvisioningRequestResponse añade los nombres, para pintarlos, y el estado
// tal como se lee ahora (una autorización pasada de hora dice `expired`).
type ProvisioningRequestResponse struct {
	ProvisioningRequest
	RequestedByName string `json:"requestedByName"`
	DecidedByName   string `json:"decidedByName,omitempty"`
}

// Expired: si ya no se puede ni decidir ni correr por el tiempo.
func (p *ProvisioningRequest) Expired(now time.Time) bool {
	switch p.Status {
	case ProvisioningRequestApproved:
		return p.GrantExpiresAt == nil || !now.Before(*p.GrantExpiresAt)
	case ProvisioningRequestAwaiting, ProvisioningRequestChecking:
		return !now.Before(p.CreatedAt.Add(ProvisioningDecisionTTL))
	}
	return false
}

// CreateProvisioningRequest es lo que manda quien pide.
type CreateProvisioningRequest struct {
	Playbook  string `json:"playbook"  validate:"required,max=64"`
	Project   string `json:"project"   validate:"max=200"`
	Risk      string `json:"risk"      validate:"required"`
	Verify    string `json:"verify"    validate:"max=64"`
	Rollback  string `json:"rollback"  validate:"max=64"`
	ConfigSeq int    `json:"configSeq" validate:"min=0"`
	Reason    string `json:"reason"    validate:"max=2000"`
}

// DecideProvisioningRequest: aprobar o rechazar.
type DecideProvisioningRequest struct {
	Approve bool   `json:"approve"`
	Note    string `json:"note" validate:"max=2000"`
	// Para `destructive`: el nombre del servidor, escrito a mano.
	ConfirmServer string `json:"confirmServer" validate:"max=200"`
	// Con alguna bandera roja: que quien aprueba diga que la vio.
	AcknowledgeFlags bool `json:"acknowledgeFlags"`
}

// ValidateProvisioningRequest: el riesgo es uno de los tres, los ids de
// playbook tienen la forma del manifiesto, y lo que cambia o destruye trae con
// qué se comprueba y con qué se deshace (el diseño, §1).
func ValidateProvisioningRequest(req CreateProvisioningRequest) error {
	switch req.Risk {
	case RiskRead, RiskChange, RiskDestructive:
	default:
		return ErrBadRisk
	}
	for _, id := range []string{req.Playbook, req.Verify, req.Rollback} {
		if id != "" && !PlaybookIDPattern.MatchString(id) {
			return ErrBadPlaybookID
		}
	}
	if req.ConfigSeq < 1 {
		return ErrConfigSeqRequired
	}
	if req.Risk != RiskRead {
		if req.Verify == "" {
			return ErrVerifyRequired
		}
		if req.Rollback == "" {
			return ErrRollbackRequired
		}
	}
	return nil
}

// Lo que toca el acceso a la máquina: la llave para entrar y la pared. Eso lo
// hace `baseline` y nada más; en cualquier otro playbook es bandera roja,
// porque un error ahí deja a todos fuera.
var accessMarkers = []string{"/etc/ssh", "sshd", "authorized_keys", "ufw", "iptables", "nftables", "firewall", "fail2ban"}

const accessPlaybook = "baseline"

// EvaluateCheck es el paso 2 del protocolo: compara el ensayo con lo que
// debería ser, y devuelve las banderas y si la política lo pre-autoriza.
//
// Pre-autorizado = de lectura, el ensayo no cambiaría nada y no hay ninguna
// bandera. Cualquier otra cosa espera a una persona: un `change` nunca se
// pre-autoriza, por limpio que salga su ensayo, y tampoco en pruebas.
func EvaluateCheck(risk, playbook string, c ProvisioningCheck) (flags []RiskFlag, preAuthorized bool) {
	flags = []RiskFlag{}
	add := func(code, level, detail string) {
		flags = append(flags, RiskFlag{Code: code, Level: level, Detail: detail})
	}
	if c.ExitCode != 0 || c.Failed > 0 {
		add(FlagCheckFailed, FlagRed, fmt.Sprintf("exit %d, failed=%d", c.ExitCode, c.Failed))
	}
	if c.Unreachable > 0 {
		add(FlagUnreachable, FlagRed, fmt.Sprintf("unreachable=%d", c.Unreachable))
	}
	if len(c.Hosts) != 1 {
		add(FlagHostCount, FlagRed, fmt.Sprintf("%d hosts", len(c.Hosts)))
	}
	if risk == RiskRead && c.Changed > 0 {
		add(FlagReadWouldChange, FlagRed, fmt.Sprintf("changed=%d", c.Changed))
	}
	if playbook != accessPlaybook {
		if hit := touchesAccess(c); hit != "" {
			add(FlagTouchesAccess, FlagRed, hit)
		}
	}
	if risk == RiskDestructive {
		add(FlagDestructive, FlagAmber, "")
	}
	if risk != RiskRead && c.Changed > 0 {
		add(FlagChanges, FlagInfo, fmt.Sprintf("changed=%d", c.Changed))
	}
	return flags, risk == RiskRead && len(flags) == 0
}

func touchesAccess(c ProvisioningCheck) string {
	for _, list := range [][]string{c.Paths, c.ChangedTasks} {
		for _, item := range list {
			low := strings.ToLower(item)
			for _, m := range accessMarkers {
				if strings.Contains(low, m) {
					return item
				}
			}
		}
	}
	return ""
}

// HasRedFlag: si alguna bandera pide reconocerse al aprobar.
func HasRedFlag(flags []RiskFlag) bool {
	for _, f := range flags {
		if f.Level == FlagRed {
			return true
		}
	}
	return false
}

// BoundCheck acota lo que se guarda del ensayo: el diff entero de un playbook
// grande no cabe en una pantalla ni hace falta. Se queda el principio, que es
// donde están los primeros cambios.
func BoundCheck(c ProvisioningCheck) ProvisioningCheck {
	if len(c.Diff) > provisioningDiffBytes {
		// Cortar por bytes puede partir un carácter: se retrocede hasta que
		// el texto vuelva a ser UTF-8 válido, o Postgres rechaza la fila.
		cut := c.Diff[:provisioningDiffBytes]
		for len(cut) > 0 && !utf8.ValidString(cut) {
			cut = cut[:len(cut)-1]
		}
		c.Diff = cut + "\n…"
	}
	if c.Hosts == nil {
		c.Hosts = []string{}
	}
	return c
}

// RecapChanged lee del PLAY RECAP cuántas tareas cambiaron, sumando hosts.
// -1 si no hay recap que leer.
func RecapChanged(summary string) int {
	total, found := 0, false
	for _, line := range strings.Split(summary, "\n") {
		i := strings.Index(line, "changed=")
		if i < 0 {
			continue
		}
		n := 0
		digits := 0
		for _, ch := range line[i+len("changed="):] {
			if ch < '0' || ch > '9' {
				break
			}
			n = n*10 + int(ch-'0')
			digits++
		}
		if digits > 0 {
			total += n
			found = true
		}
	}
	if !found {
		return -1
	}
	return total
}
