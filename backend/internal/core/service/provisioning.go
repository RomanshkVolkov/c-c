package service

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ProvisioningService struct {
	repo *repository.ProvisioningRepository
}

func NewProvisioningService(repo *repository.ProvisioningRepository) *ProvisioningService {
	return &ProvisioningService{repo: repo}
}

func (s *ProvisioningService) Start(server *domain.ServerResponse, userID string, req domain.StartProvisioningRequest) (*domain.ProvisioningRun, error) {
	run := &domain.ProvisioningRun{
		ServerID:  server.ID,
		OrgID:     server.OrgID,
		Kind:      req.Kind,
		Project:   req.Project,
		Playbook:  req.Playbook,
		Target:    req.Target,
		VarNames:  strings.Join(req.VarNames, ","),
		StartedBy: userID,
		StartedAt: time.Now().UTC(),
		Status:    domain.ProvisioningRunning,
	}
	run.ID = uuid.NewString()
	if err := s.repo.Create(run); err != nil {
		return nil, err
	}
	return run, nil
}

// Finish cierra una ejecución abierta. Una ya cerrada contesta
// `ErrProvisioningNotRunning`: el primer cierre es el que cuenta.
func (s *ProvisioningService) Finish(serverID, id string, req domain.FinishProvisioningRequest) error {
	now := time.Now().UTC()
	return s.repo.Finish(serverID, id, map[string]any{
		"status":      req.Status,
		"exit_code":   req.ExitCode,
		"summary":     boundTail(req.Summary, 40, 8<<10),
		"log_tail":    boundTail(req.LogTail, domain.ProvisioningTailLines, domain.ProvisioningTailBytes),
		"finished_at": now,
	})
}

func (s *ProvisioningService) List(serverID string) ([]domain.ProvisioningRunResponse, error) {
	return s.repo.ListByServer(serverID, 50)
}

// boundTail se queda con **el final**: las últimas `lines` líneas y, de ellas,
// los últimos `bytes` bytes. De una ejecución fallida lo que se lee es cómo
// acabó; el principio es la instalación de paquetes.
//
// Cortar por bytes puede partir un carácter UTF-8 por la mitad, así que se
// avanza hasta el siguiente inicio de carácter: guardar texto inválido haría
// que Postgres rechazara la fila entera y se perdiera también el resto.
func boundTail(s string, lines, bytes int) string {
	parts := strings.Split(s, "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	out := strings.Join(parts, "\n")
	if len(out) > bytes {
		out = out[len(out)-bytes:]
		for len(out) > 0 && out[0]&0xC0 == 0x80 {
			out = out[1:]
		}
	}
	return out
}
