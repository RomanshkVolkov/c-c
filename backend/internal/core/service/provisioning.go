package service

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ProvisioningService struct {
	repo    *repository.ProvisioningRepository
	configs *ServerConfigService
}

func NewProvisioningService(repo *repository.ProvisioningRepository) *ProvisioningService {
	return &ProvisioningService{repo: repo}
}

// WithConfigs: con la config de los servidores en cac, una ejecución que dice
// con qué versión se lanza guarda la foto de lo aplicado.
func (s *ProvisioningService) WithConfigs(c *ServerConfigService) *ProvisioningService {
	s.configs = c
	return s
}

func (s *ProvisioningService) Start(server *domain.ServerResponse, userID string, viaToken bool, req domain.StartProvisioningRequest) (*domain.ProvisioningRun, error) {
	src := "app"
	if viaToken {
		src = "cli"
	}
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
		Source:    src,
	}
	run.ID = uuid.NewString()
	// Un token no aplica nada sin el protocolo: necesita una petición
	// autorizada (ver domain.ProvisioningRequest). Una persona en la app es su
	// propia aprobación y puede correr sin ella; si trae una, se gasta igual.
	if viaToken && req.RequestID == "" {
		return nil, domain.ErrGrantRequired
	}
	if req.RequestID != "" && req.ConfigSeq < 1 {
		return nil, domain.ErrGrantMismatch
	}
	run.RequestID = req.RequestID
	// La foto se saca aquí, del backend, y no de lo que diga la app: lo que
	// queda es la versión guardada tal como estaba, no una copia que el
	// cliente pudo haber retocado.
	if req.ConfigSeq > 0 && s.configs != nil {
		eff, err := s.configs.Effective(server, req.ConfigSeq)
		if err != nil {
			return nil, err
		}
		run.ConfigSeq, run.TemplateID, run.TemplateSeq = eff.ConfigSeq, eff.TemplateID, eff.TemplateSeq
		run.Applied = &domain.AppliedConfig{Vars: eff.Vars, OpRefs: eff.OpRefs}
	}
	if run.RequestID != "" {
		if err := s.repo.StartWithGrant(run, time.Now().UTC()); err != nil {
			return nil, err
		}
		return run, nil
	}
	if err := s.repo.Create(run); err != nil {
		return nil, err
	}
	return run, nil
}

// Finish cierra una ejecución abierta. Una ya cerrada contesta
// `ErrProvisioningNotRunning`: el primer cierre es el que cuenta.
func (s *ProvisioningService) Finish(serverID, id string, req domain.FinishProvisioningRequest) error {
	now := time.Now().UTC()
	summary := boundTail(req.Summary, 40, 8<<10)
	if err := s.repo.Finish(serverID, id, map[string]any{
		"status":      req.Status,
		"exit_code":   req.ExitCode,
		"summary":     summary,
		"log_tail":    boundTail(req.LogTail, domain.ProvisioningTailLines, domain.ProvisioningTailBytes),
		"finished_at": now,
	}); err != nil {
		return err
	}
	run, err := s.repo.Run(serverID, id)
	if err != nil || run.RequestID == "" {
		return err
	}
	return s.advanceRequest(serverID, run, req.Status, summary, req.NotStarted)
}

// advanceRequest lleva la petición al paso siguiente cuando acaba una de sus
// ejecuciones (pasos 5 y 6 del protocolo). Una que no llegó a arrancar
// Ansible (`notStarted`) no es un paso: no tocó el servidor, y la petición
// vuelve a donde estaba con su autorización intacta, para correrla otra vez.
func (s *ProvisioningService) advanceRequest(serverID string, run *domain.ProvisioningRun, status, summary string, notStarted bool) error {
	p, err := s.repo.Request(serverID, run.RequestID)
	if err != nil {
		return err
	}
	ok := status == domain.ProvisioningSucceeded
	if notStarted && !ok {
		switch run.ID {
		case p.RunID:
			return s.repo.ReopenRequest(p.ID, domain.ProvisioningRequestRunning, domain.ProvisioningRequestApproved, "run_id")
		case p.VerifyRunID:
			return s.repo.ReopenRequest(p.ID, domain.ProvisioningRequestVerifying, domain.ProvisioningRequestVerifying, "verify_run_id")
		}
		return nil
	}
	switch run.ID {
	case p.RunID:
		next := domain.ProvisioningRequestFailed
		switch {
		case !ok:
		case p.Risk == domain.RiskRead && domain.RecapChanged(summary) != 0:
			// Autorizada como lectura y cambió algo, o no dejó recap con qué
			// comprobar que no: no se da por buena.
			next = domain.ProvisioningRequestViolated
		case p.Risk != domain.RiskRead && p.Verify != "":
			next = domain.ProvisioningRequestVerifying
		default:
			next = domain.ProvisioningRequestSucceeded
		}
		return s.repo.MoveRequest(p.ID, domain.ProvisioningRequestRunning, next)
	case p.VerifyRunID:
		next := domain.ProvisioningRequestVerifyFailed
		if ok {
			next = domain.ProvisioningRequestSucceeded
		}
		return s.repo.MoveRequest(p.ID, domain.ProvisioningRequestVerifying, next)
	}
	return nil
}

// ─── Peticiones ───────────────────────────────────────────────────────────────

// Request abre una petición (paso 0): queda esperando su ensayo. La versión
// de la config tiene que existir: es lo que se ensayará y lo que correrá.
func (s *ProvisioningService) Request(server *domain.ServerResponse, user *domain.ClaimsJWT, req domain.CreateProvisioningRequest) (*domain.ProvisioningRequest, error) {
	if err := domain.ValidateProvisioningRequest(req); err != nil {
		return nil, err
	}
	if s.configs != nil {
		if _, err := s.configs.Effective(server, req.ConfigSeq); err != nil {
			return nil, err
		}
	}
	src := "app"
	if user.ViaToken {
		src = "mcp"
	}
	p := &domain.ProvisioningRequest{
		OrgID: server.OrgID, ServerID: server.ID,
		Playbook: req.Playbook, Project: req.Project, Risk: req.Risk,
		Verify: req.Verify, Rollback: req.Rollback, ConfigSeq: req.ConfigSeq,
		Reason: req.Reason, RequestedBy: user.UserID, Source: src,
		Status: domain.ProvisioningRequestChecking, Flags: []domain.RiskFlag{},
	}
	p.ID = uuid.NewString()
	if err := s.repo.CreateRequest(p); err != nil {
		return nil, err
	}
	return p, nil
}

// SubmitCheck guarda el ensayo, lo evalúa (paso 2) y, si la política lo
// pre-autoriza —sólo una lectura limpia—, deja la autorización puesta.
func (s *ProvisioningService) SubmitCheck(server *domain.ServerResponse, id string, check domain.ProvisioningCheck) (*domain.ProvisioningRequestResponse, error) {
	p, err := s.repo.Request(server.ID, id)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if p.Expired(now) {
		return nil, domain.ErrRequestExpired
	}
	check = domain.BoundCheck(check)
	flags, auto := domain.EvaluateCheck(p.Risk, p.Playbook, check)
	// La config de la versión pedida, no la de ahora: es la que se ensayó. Un
	// aviso, no una puerta: si no se puede leer, el ensayo entra igual (una
	// petición que se queda «ensayando» es justo lo que mordió en la 283).
	if s.configs != nil && p.ConfigSeq > 0 {
		if eff, err := s.configs.Effective(server, p.ConfigSeq); err == nil {
			if f := domain.EvaluateHost(server.Host, eff.Vars); f != nil {
				flags = append(flags, *f)
				auto = false
			}
		}
	}
	status := domain.ProvisioningRequestAwaiting
	var grant *time.Time
	if auto {
		status = domain.ProvisioningRequestApproved
		g := now.Add(domain.ProvisioningGrantTTL)
		grant = &g
	}
	if err := s.repo.SubmitCheck(server.ID, id, now, check, flags, status, auto, grant); err != nil {
		return nil, err
	}
	return s.repo.Request(server.ID, id)
}

// Discard quita de en medio una petición que se quedó sin ensayo. Sólo la que
// sigue esperándolo (`checking`): una ensayada se rechaza, y lo demás ya
// terminó. La descarta quien la pidió o un admin; un ensayo que llegue
// después no entra (`SubmitCheck` sólo escribe sobre una en `checking`).
func (s *ProvisioningService) Discard(server *domain.ServerResponse, user *domain.ClaimsJWT, admin bool, id string) (*domain.ProvisioningRequestResponse, error) {
	p, err := s.repo.Request(server.ID, id)
	if err != nil {
		return nil, err
	}
	// Que siga en `checking` lo mira el repositorio en la misma sentencia que
	// la cambia: si no, 409.
	if !admin && p.RequestedBy != user.UserID {
		return nil, domain.ErrNotYourRequest
	}
	if err := s.repo.Discard(server.ID, id, time.Now().UTC(), user.UserID); err != nil {
		return nil, err
	}
	return s.repo.Request(server.ID, id)
}

// Decide es el paso 3: aprobar o rechazar. **Sólo una persona en persona**:
// con un token, ni el de un admin, se puede decidir. Es la misma regla que
// firmar la revisión de un doc (`ViaToken`).
func (s *ProvisioningService) Decide(server *domain.ServerResponse, user *domain.ClaimsJWT, id string, req domain.DecideProvisioningRequest) (*domain.ProvisioningRequestResponse, error) {
	if user.ViaToken {
		return nil, domain.ErrInPersonOnly
	}
	p, err := s.repo.Request(server.ID, id)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if p.Expired(now) {
		return nil, domain.ErrRequestExpired
	}
	if p.Status != domain.ProvisioningRequestAwaiting {
		return nil, domain.ErrRequestState
	}
	fields := map[string]any{
		"status": domain.ProvisioningRequestRejected, "decided_by": user.UserID,
		"decided_at": now, "decision_note": req.Note,
	}
	if req.Approve {
		if p.Risk == domain.RiskDestructive && req.ConfirmServer != server.Name {
			return nil, domain.ErrConfirmServerName
		}
		if domain.HasRedFlag(p.Flags) && !req.AcknowledgeFlags {
			return nil, domain.ErrAcknowledgeFlags
		}
		fields["status"] = domain.ProvisioningRequestApproved
		fields["grant_expires_at"] = now.Add(domain.ProvisioningGrantTTL)
	}
	if err := s.repo.Decide(server.ID, id, now, fields); err != nil {
		return nil, err
	}
	return s.repo.Request(server.ID, id)
}

// GetRequest y Requests leen, con el estado como se lee ahora.
func (s *ProvisioningService) GetRequest(serverID, id string) (*domain.ProvisioningRequestResponse, error) {
	p, err := s.repo.Request(serverID, id)
	if err != nil {
		return nil, err
	}
	readNow(p)
	return p, nil
}

func (s *ProvisioningService) Requests(serverID string) ([]domain.ProvisioningRequestResponse, error) {
	out, err := s.repo.Requests(serverID, 50)
	for i := range out {
		readNow(&out[i])
	}
	return out, err
}

func readNow(p *domain.ProvisioningRequestResponse) {
	if p.Expired(time.Now().UTC()) {
		p.Status = domain.ProvisioningRequestExpired
	}
	if p.Flags == nil {
		p.Flags = []domain.RiskFlag{}
	}
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
