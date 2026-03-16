package domain

// ServerType represents the orchestrator type on the server.
type ServerType string

const (
	ServerTypeDockerSwarm ServerType = "docker-swarm"
	ServerTypeKubernetes  ServerType = "kubernetes"
)

// Server holds connection metadata for a VPS. SSH credentials are stored
// in the OS keychain, keyed by the server ID.
type Server struct {
	BaseModel
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
	Name           string     `json:"name"           validate:"required,min=1,max=100"`
	Host           string     `json:"host"           validate:"required"`
	SSHPort        int        `json:"sshPort"        validate:"required,min=1,max=65535"`
	SSHUser        string     `json:"sshUser"        validate:"required"`
	Type           ServerType `json:"type"           validate:"required,oneof=docker-swarm kubernetes"`
	AgentPort      int        `json:"agentPort"      validate:"required,min=1,max=65535"`
	SSHPrivateKey  string     `json:"sshPrivateKey"  validate:"required"` // stored in keychain, not in DB
}

type ServerResponse struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Host      string     `json:"host"`
	SSHPort   int        `json:"sshPort"`
	SSHUser   string     `json:"sshUser"`
	Type      ServerType `json:"type"`
	AgentPort int        `json:"agentPort"`
	Status    string     `json:"status"`
}
