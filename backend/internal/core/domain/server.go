package domain

import "time"

// ServerType represents the orchestrator type on the server.
type ServerType string

const (
	ServerTypeDockerSwarm ServerType = "docker-swarm"
	ServerTypeKubernetes  ServerType = "kubernetes"
)

// Server holds connection metadata for a VPS. SSH credentials live on the
// user's machine (1Password / OS SSH agent) and never reach this service.
type Server struct {
	BaseModel
	// OrgID scopes the server to an organization. Kept nullable at the DB level
	// so AutoMigrate can add it to existing rows (seedDefaultOrg backfills it);
	// the API always sets it on create. See organizations proposal, Fase 1.
	OrgID     string     `gorm:"type:varchar(36);index" json:"orgId"`
	Name      string     `gorm:"type:varchar(100);not null" json:"name"`
	Host      string     `gorm:"type:varchar(255);not null" json:"host"`
	SSHPort   int        `gorm:"default:22" json:"sshPort"`
	SSHUser   string     `gorm:"type:varchar(100);not null" json:"sshUser"`
	Type      ServerType `gorm:"type:varchar(50);not null" json:"type"`
	AgentPort int        `gorm:"default:9090" json:"agentPort"`
	Status    string     `gorm:"type:varchar(50);default:'pending'" json:"status"`

	// La identidad del agente. Sin token, el servidor es de los de antes: el
	// agente no tiene auth y su estado lo cuenta la app que lo mira.
	//
	// Del token sólo se guarda el HMAC (como un PAT): una fuga de la base no da
	// una credencial usable. La sal no es secreta: con el secreto del backend
	// deriva la llave con la que se firman las sesiones de escritorio, así que
	// el backend puede firmarlas sin guardar nada descifrable. Reacuñar cambia
	// las dos cosas, y con eso caduca todo lo anterior.
	AgentTokenHash    []byte     `gorm:"type:bytea;index" json:"-"`
	AgentTokenSalt    string     `gorm:"type:varchar(64)" json:"-"`
	AgentTokenPreview string     `gorm:"type:varchar(40)" json:"-"`
	AgentSeenAt       *time.Time `json:"-"`
	// La versión del agente, tal como la dice en cada pregunta
	// (`X-Agent-Version`). 0 = uno de antes de decirla (v2 o anterior).
	AgentVersion int `gorm:"default:0" json:"-"`
}

// AgentVersionDeploys: la primera versión del agente que sabe desplegar. Un
// deploy para un agente más viejo se rechaza al pedirlo, en vez de quedarse
// «en curso» hasta caducar porque el agente no sabe qué hacer con él.
const AgentVersionDeploys = 3

// AgentVersionMigrates: la primera que corre las migraciones de un deploy
// (un job de Swarm con la imagen nueva antes del update). Un servicio con
// comando de migración no se le encola a uno anterior: lo desplegaría sin
// migrar.
const AgentVersionMigrates = 4

// AgentSilence: cuánto se tolera sin latido antes de dar el agente por caído.
// El agente pregunta cada 25 s como mucho; tres preguntas perdidas son un
// agente que no está, no una red que parpadea.
const AgentSilence = 90 * time.Second

// ─── Requests / Responses ─────────────────────────────────────────────────────

type CreateServerRequest struct {
	OrgID     string     `json:"orgId"     validate:"required"`
	Name      string     `json:"name"      validate:"required,min=1,max=100"`
	Host      string     `json:"host"      validate:"required"`
	SSHPort   int        `json:"sshPort"   validate:"required,min=1,max=65535"`
	SSHUser   string     `json:"sshUser"   validate:"required"`
	Type      ServerType `json:"type"      validate:"required,oneof=docker-swarm kubernetes"`
	AgentPort int        `json:"agentPort" validate:"required,min=1,max=65535"`
}

// UpdateServerRequest edits a registered server's connection metadata. OrgID is
// deliberately absent: moving a server between organizations would strand its
// integrations and telemetry, so it isn't an edit.
type UpdateServerRequest struct {
	Name      string     `json:"name"      validate:"required,min=1,max=100"`
	Host      string     `json:"host"      validate:"required"`
	SSHPort   int        `json:"sshPort"   validate:"required,min=1,max=65535"`
	SSHUser   string     `json:"sshUser"   validate:"required"`
	Type      ServerType `json:"type"      validate:"required,oneof=docker-swarm kubernetes"`
	AgentPort int        `json:"agentPort" validate:"required,min=1,max=65535"`
}

type ServerResponse struct {
	ID        string     `json:"id"`
	OrgID     string     `json:"orgId"`
	Name      string     `json:"name"`
	Host      string     `json:"host"`
	SSHPort   int        `json:"sshPort"`
	SSHUser   string     `json:"sshUser"`
	Type      ServerType `json:"type"`
	AgentPort int        `json:"agentPort"`
	Status    string     `json:"status"`
	// Si el agente tiene identidad. Con ella, `status` sale del latido del
	// propio agente y no de lo que la última app pudo alcanzar.
	HasAgentToken     bool       `json:"hasAgentToken"`
	AgentTokenPreview string     `json:"agentTokenPreview,omitempty"`
	AgentSeenAt       *time.Time `json:"agentSeenAt,omitempty"`
	AgentVersion      int        `json:"agentVersion"`
}

// AgentTokenResponse se enseña **una vez**, al acuñar. Las dos piezas van al
// host como Docker secrets: el token para que el agente le hable al backend, y
// la llave de sesión para que verifique a la app sin preguntarle a nadie.
type AgentTokenResponse struct {
	Token      string `json:"token"`
	SessionKey string `json:"sessionKey"`
	Preview    string `json:"preview"`
}

// AgentSessionResponse: un pase corto para hablarle al agente desde la app.
type AgentSessionResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ReportAgentStatusRequest es lo que la app dice tras probar el agente.
//
// Sólo `online` u `offline`: `pending` significa «nadie lo ha mirado todavía» y
// es del servidor ponerlo, no de un cliente devolverlo. Sin esta lista, un
// cliente podría dejar un servidor en un estado que ninguna pantalla sabe leer.
type ReportAgentStatusRequest struct {
	Status string `json:"status" validate:"required,oneof=online offline"`
}
