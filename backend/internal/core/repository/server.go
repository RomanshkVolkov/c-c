package repository

import (
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

type ServerRepository struct {
	db *gorm.DB
}

func NewServerRepository(db *gorm.DB) *ServerRepository {
	return &ServerRepository{db: db}
}

func (r *ServerRepository) Create(server *domain.Server) error {
	return r.db.Create(server).Error
}

// ListByOrgs returns servers belonging to any of the given orgs. An empty slice
// yields no rows (a caller with no memberships sees nothing).
func (r *ServerRepository) ListByOrgs(orgIDs []string) ([]domain.Server, error) {
	if len(orgIDs) == 0 {
		return []domain.Server{}, nil
	}
	var servers []domain.Server
	if err := r.db.Where("org_id IN ?", orgIDs).Find(&servers).Error; err != nil {
		return nil, err
	}
	return servers, nil
}

// ListAll returns every server (superadmin scope).
func (r *ServerRepository) ListAll() ([]domain.Server, error) {
	var servers []domain.Server
	if err := r.db.Find(&servers).Error; err != nil {
		return nil, err
	}
	return servers, nil
}

func (r *ServerRepository) FindByID(id string) (*domain.Server, error) {
	var server domain.Server
	if err := r.db.First(&server, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &server, nil
}

// Update persists the editable connection fields.
func (r *ServerRepository) Update(server *domain.Server) error {
	return r.db.Model(&domain.Server{}).Where("id = ?", server.ID).Updates(map[string]any{
		"name":       server.Name,
		"host":       server.Host,
		"ssh_port":   server.SSHPort,
		"ssh_user":   server.SSHUser,
		"type":       server.Type,
		"agent_port": server.AgentPort,
	}).Error
}

func (r *ServerRepository) UpdateStatus(id, status string) error {
	return r.db.Model(&domain.Server{}).Where("id = ?", id).Update("status", status).Error
}

// SetAgentToken guarda la identidad nueva y **olvida el latido**: un agente
// con el token de antes ya no puede presentarse, así que no está en línea
// hasta que el nuevo pregunte.
func (r *ServerRepository) SetAgentToken(id string, hash []byte, salt, preview string) error {
	return r.db.Model(&domain.Server{}).Where("id = ?", id).Updates(map[string]any{
		"agent_token_hash":    hash,
		"agent_token_salt":    salt,
		"agent_token_preview": preview,
		"agent_seen_at":       nil,
		"status":              "pending",
	}).Error
}

// FindByAgentTokenHash: el servidor al que pertenece un token de agente. Los
// servidores sin token tienen la columna en NULL, que no casa con ningún hash.
func (r *ServerRepository) FindByAgentTokenHash(hash []byte) (*domain.Server, error) {
	var server domain.Server
	if err := r.db.First(&server, "agent_token_hash = ?", hash).Error; err != nil {
		return nil, err
	}
	return &server, nil
}

// TouchAgent anota el latido.
func (r *ServerRepository) TouchAgent(id string, at time.Time) error {
	return r.db.Model(&domain.Server{}).Where("id = ?", id).Updates(map[string]any{
		"agent_seen_at": at,
		"status":        "online",
	}).Error
}

func (r *ServerRepository) Delete(id string) error {
	return r.db.Delete(&domain.Server{}, "id = ?", id).Error
}
