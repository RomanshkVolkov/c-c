package domain

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
}

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
}

// ReportAgentStatusRequest es lo que la app dice tras probar el agente.
//
// Sólo `online` u `offline`: `pending` significa «nadie lo ha mirado todavía» y
// es del servidor ponerlo, no de un cliente devolverlo. Sin esta lista, un
// cliente podría dejar un servidor en un estado que ninguna pantalla sabe leer.
type ReportAgentStatusRequest struct {
	Status string `json:"status" validate:"required,oneof=online offline"`
}
