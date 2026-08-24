package service

import (
	"errors"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"time"
)

// ErrInboxOtherOrg: la lista elegida como bandeja es de otra organización.
var ErrInboxOtherOrg = errors.New("that list belongs to another organization")

type ReportProjectService struct {
	repo    *repository.ReportProjectRepository
	orgRepo *repository.OrganizationRepository
}

func NewReportProjectService(repo *repository.ReportProjectRepository, orgRepo *repository.OrganizationRepository) *ReportProjectService {
	return &ReportProjectService{repo: repo, orgRepo: orgRepo}
}

// validateDefaultAssignee ensures the default assignee (when set) belongs to
// the project's org.
func (s *ReportProjectService) validateDefaultAssignee(orgID, userID string) error {
	if userID == "" {
		return nil
	}
	if _, err := s.orgRepo.GetMembership(orgID, userID); err != nil {
		return ErrAssigneeNotMember
	}
	return nil
}

// defaultReporterRateLimit mirrors portento's own anti-spam rule, which is where
// the number comes from: ten reports per person per hour.
func defaultReporterRateLimit(v int) int {
	if v <= 0 {
		return 10
	}
	return v
}

func defaultRateLimit(v int) int {
	if v <= 0 {
		return 20 // hereda el anti-spam de portento, configurable
	}
	return v
}

// Create mints a project plus a write-only ingest key. The plaintext key is
// returned exactly once; only its HMAC is stored.
func (s *ReportProjectService) Create(req domain.CreateReportProjectRequest) (*domain.CreateReportProjectResult, error) {
	slug := slugify(req.Slug)
	if slug == "" {
		slug = slugify(req.Name)
	}
	if slug == "" {
		slug = uuid.NewString()[:8]
	}

	if err := s.validateDefaultAssignee(req.OrgID, req.DefaultAssigneeUserID); err != nil {
		return nil, err
	}

	plain, hash, err := repository.GenerateIngestKey()
	if err != nil {
		return nil, err
	}

	// Native "app" projects have no browser Origin; ignore any origins sent.
	platform := req.Platform
	if platform == "" {
		platform = "web"
	}
	origins := req.AllowedOrigins
	if platform == "app" {
		origins = nil
	}

	p := &domain.ReportProject{
		OrgID:                       req.OrgID,
		Name:                        req.Name,
		Slug:                        slug,
		WebhookURL:                  req.WebhookURL,
		WebhookSecret:               req.WebhookSecret,
		Platform:                    platform,
		IngestKeyHash:               hash,
		AllowedOrigins:              domain.StringList(origins),
		RateLimitPerHour:            defaultRateLimit(req.RateLimitPerHour),
		RateLimitPerReporterPerHour: defaultReporterRateLimit(req.RateLimitPerReporterPerHour),
		IsActive:                    true,
	}
	if req.DefaultAssigneeUserID != "" {
		p.DefaultAssigneeUserID = &req.DefaultAssigneeUserID
	}
	p.ID = uuid.NewString()

	if err := s.repo.Create(p); err != nil {
		return nil, err
	}
	return &domain.CreateReportProjectResult{
		Project:   *toReportProjectResponse(p),
		IngestKey: plain,
	}, nil
}

func (s *ReportProjectService) List(orgIDs []string, superadmin bool) ([]domain.ReportProjectResponse, error) {
	var projects []domain.ReportProject
	var err error
	if superadmin {
		projects, err = s.repo.ListAll()
	} else {
		projects, err = s.repo.ListByOrgs(orgIDs)
	}
	if err != nil {
		return nil, err
	}
	// El volumen del mes en curso, contado desde el día 1 en la zona del
	// servidor. Si la cuenta falla, la lista sale igual con ceros: no ver un
	// número es peor que no ver la integración.
	ahora := time.Now()
	inicioDeMes := time.Date(ahora.Year(), ahora.Month(), 1, 0, 0, 0, 0, ahora.Location())
	volumen, err := s.repo.CountSinceByProject(inicioDeMes)
	if err != nil {
		volumen = map[string]int64{}
	}

	out := make([]domain.ReportProjectResponse, len(projects))
	for i := range projects {
		out[i] = *toReportProjectResponse(&projects[i])
		out[i].ReportsThisMonth = volumen[projects[i].ID]
	}
	return out, nil
}

func (s *ReportProjectService) Find(id string) (*domain.ReportProject, error) {
	return s.repo.FindByID(id)
}

func (s *ReportProjectService) Update(id string, req domain.UpdateReportProjectRequest) (*domain.ReportProjectResponse, error) {
	p, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	// Las dos guardas de la bandeja, antes de tocar nada.
	if req.ListID != nil {
		if *req.ListID == "" {
			// Dejar un canal sin lista no es «desconfigurarlo»: es que todo lo
			// que le manden a partir de ese momento se pierda sin decir nada.
			// Es la única excepción a «el vacío borra».
			return nil, repository.ErrChannelNeedsInbox
		}
		// Y no a la de otra organización: sería enseñar el trabajo de un
		// cliente a gente que no tiene nada que ver con él, por una línea mal
		// puesta en un formulario.
		if org := s.repo.OrgDeLista(*req.ListID); org != p.OrgID {
			return nil, ErrInboxOtherOrg
		}
	}
	if err := s.aplicarCambios(p, req); err != nil {
		return nil, err
	}
	if err := s.repo.Update(p); err != nil {
		return nil, err
	}
	return toReportProjectResponse(p), nil
}

// aplicarCambios copia sobre el proyecto **sólo los campos que llegaron**.
//
// Aparte de `Update` para poder probarse sin base de datos: la regla que
// implementa —omitir no borra— es aritmética sobre dos structs, y montar
// Postgres para leerla añadiría formas de fallar que no tienen nada que ver con
// ella. Importa porque el CI no corre las pruebas del backend, así que una
// prueba que necesite una base de datos no vigila nada.
//
// Lo que necesita el repositorio se queda fuera: validar el responsable y
// comprobar la organización de la bandeja.
func aplicarCambios(p *domain.ReportProject, req domain.UpdateReportProjectRequest) {
	if req.DefaultAssigneeUserID != nil {
		if *req.DefaultAssigneeUserID == "" {
			p.DefaultAssigneeUserID = nil
		} else {
			p.DefaultAssigneeUserID = req.DefaultAssigneeUserID
		}
	}
	if req.Name != nil {
		p.Name = *req.Name
	}
	if req.AllowedOrigins != nil {
		p.AllowedOrigins = domain.StringList(*req.AllowedOrigins)
	}
	if req.RateLimitPerHour != nil {
		p.RateLimitPerHour = defaultRateLimit(*req.RateLimitPerHour)
	}
	if req.RateLimitPerReporterPerHour != nil {
		p.RateLimitPerReporterPerHour = defaultReporterRateLimit(*req.RateLimitPerReporterPerHour)
	}
	if req.IsActive != nil {
		p.IsActive = *req.IsActive
	}
	// El secreto se reemplaza sólo cuando llega uno nuevo: una edición
	// corriente no puede dejar de firmar sin decirlo.
	if req.WebhookSecret != nil && *req.WebhookSecret != "" {
		p.WebhookSecret = *req.WebhookSecret
	}
	if req.WebhookURL != nil {
		p.WebhookURL = *req.WebhookURL
		if *req.WebhookURL == "" {
			// Retirar el destino retira su secreto — pero sólo si mandaste el
			// vacío a propósito.
			p.WebhookSecret = ""
		}
	}
	// El vacío no llega aquí: `Update` lo rechaza antes.
	if req.ListID != nil && *req.ListID != "" {
		p.ListID = req.ListID
	}
}

// aplicarCambios con lo que hace falta el repositorio: validar el responsable.
func (s *ReportProjectService) aplicarCambios(p *domain.ReportProject, req domain.UpdateReportProjectRequest) error {
	if req.DefaultAssigneeUserID != nil {
		if err := s.validateDefaultAssignee(p.OrgID, *req.DefaultAssigneeUserID); err != nil {
			return err
		}
	}
	aplicarCambios(p, req)
	return nil
}

func (s *ReportProjectService) Delete(id string) error {
	return s.repo.Delete(id)
}

// RotateKey issues a fresh ingest key (invalidates the previous one) and returns
// the new plaintext once.
func (s *ReportProjectService) RotateKey(id string) (string, error) {
	p, err := s.repo.FindByID(id)
	if err != nil {
		return "", err
	}
	plain, hash, err := repository.GenerateIngestKey()
	if err != nil {
		return "", err
	}
	p.IngestKeyHash = hash
	if err := s.repo.RotateKey(p.ID, hash); err != nil {
		return "", err
	}
	return plain, nil
}

// ProjectResponse renders a channel for a client. Exported because the space
// endpoints answer with the same shape — one channel, described one way,
// wherever it is configured from.
func ProjectResponse(p *domain.ReportProject) *domain.ReportProjectResponse {
	return toReportProjectResponse(p)
}

func toReportProjectResponse(p *domain.ReportProject) *domain.ReportProjectResponse {
	origins := []string(p.AllowedOrigins)
	if origins == nil {
		origins = []string{}
	}
	return &domain.ReportProjectResponse{
		ID:                          p.ID,
		OrgID:                       p.OrgID,
		Name:                        p.Name,
		Slug:                        p.Slug,
		Platform:                    p.Platform,
		AllowedOrigins:              origins,
		RateLimitPerHour:            p.RateLimitPerHour,
		RateLimitPerReporterPerHour: p.RateLimitPerReporterPerHour,
		IsActive:                    p.IsActive,
		DefaultAssigneeUserID:       p.DefaultAssigneeUserID,
		ListID:                      p.ListID,
		WebhookURL:                  p.WebhookURL,
		// The secret is never returned — only whether one exists, which is all
		// the console needs to show "signed" instead of "unsigned".
		WebhookConfigured: p.WebhookSecret != "",
		CreatedAt:         p.CreatedAt,
	}
}
