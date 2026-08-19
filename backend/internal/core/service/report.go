package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// imageURLTTL is how long a signed image proxy URL stays valid. Short-lived so
// a leaked URL is useless quickly; the app refetches the detail to renew.
const imageURLTTL = 10 * time.Minute

// telemetryTTL is the retention window for the encrypted telemetry blob; a purge
// job clears it after this without deleting the report (decision 4/7).
const telemetryTTL = 45 * 24 * time.Hour

// buildTelemetryBlob combines the widget's telemetry/snapshot/context JSON into
// one object and re-applies server-side redaction (defense in depth). Returns
// nil when nothing was sent.
func buildTelemetryBlob(in domain.IngestReportInput) []byte {
	if in.TelemetryJSON == "" && in.SnapshotJSON == "" && in.ContextJSON == "" {
		return nil
	}
	raw := func(s string) json.RawMessage {
		if s == "" {
			return nil
		}
		if !json.Valid([]byte(s)) {
			return nil
		}
		return json.RawMessage(repository.RedactSensitive(s))
	}
	combined := map[string]json.RawMessage{}
	if v := raw(in.TelemetryJSON); v != nil {
		combined["telemetry"] = v
	}
	if v := raw(in.SnapshotJSON); v != nil {
		combined["snapshot"] = v
	}
	if v := raw(in.ContextJSON); v != nil {
		combined["context"] = v
	}
	if len(combined) == 0 {
		return nil
	}
	blob, err := json.Marshal(combined)
	if err != nil {
		return nil
	}
	return blob
}

// signedImageURL builds the short-lived HMAC-signed proxy URL for an image.
func signedImageURL(reportID, imageID string) string {
	exp := time.Now().Add(imageURLTTL).Unix()
	sig := repository.SignImage(reportID, imageID, exp)
	return fmt.Sprintf("/api/v1/reports/%s/images/%s?exp=%d&sig=%s", reportID, imageID, exp, sig)
}

var (
	// ErrImagesUnavailable means the report carried screenshots but image-service
	// is not configured/reachable, so none could be stored.
	ErrImagesUnavailable = errors.New("image storage unavailable")
	ErrInvalidTransition = errors.New("invalid status transition")
	ErrAssigneeNotMember = errors.New("assignee is not a member of the organization")
	ErrCommentImmutable  = errors.New("system comments are immutable")
	ErrNotCommentAuthor  = errors.New("only the author can modify this comment")
	ErrEmptyComment      = errors.New("comment needs a body or at least one image")
	// ErrImageNotInComment guards the edit endpoint from being used to delete an
	// image that belongs to the gallery or to somebody else's reply.
	ErrImageNotInComment = errors.New("that image does not belong to this comment")
	// ErrImageInComment sends the caller to the edit endpoint: a comment's
	// images are governed by the comment, not detachable on their own.
	ErrImageInComment = errors.New("this image belongs to a comment; edit the comment to remove it")
)

type ReportService struct {
	repo     *repository.ReportRepository
	orgRepo  *repository.OrganizationRepository
	authRepo *repository.AuthRepository
	images   *imageservice.Client
	hub      *events.Hub
	// avisos escribe en la campana; ver el comentario del tipo.
	avisos *avisos
}

// WithNotifier deja constancia de lo que llega de un cliente. Es la mitad que
// faltaba: el stream ya lo contaba en vivo, pero en vivo sólo lo oye quien
// tenga la app abierta en ese momento.
func (s *ReportService) WithNotifier(n Notifier) *ReportService {
	s.avisos = &avisos{inbox: n, items: s.repo, orgs: s.orgRepo}
	return s
}

func NewReportService(
	repo *repository.ReportRepository,
	orgRepo *repository.OrganizationRepository,
	authRepo *repository.AuthRepository,
	images *imageservice.Client,
	hub *events.Hub,
) *ReportService {
	return &ReportService{repo: repo, orgRepo: orgRepo, authRepo: authRepo, images: images, hub: hub}
}

// emit publishes a report event scoped to the report's org (best-effort; a
// lookup failure just skips the notification).
// emit publishes an event to the live stream and the project's webhook.
//
// `from` is a parameter and not just another map key so it cannot be forgotten:
// a tenant receives the webhook for the change it just made itself, and without
// this it cannot tell its own action from ours. It used to be guarded by a test
// that scanned this file for the string, which stopped working the moment a
// payload was built on the line above. The compiler doesn't have that problem.
func (s *ReportService) emit(eventType, reportID, from string, data map[string]any) {
	emitItemEvent(s.hub, s.repo, eventType, reportID, from, data)
}

// emitItemEvent tells everyone who is owed the news that a channel item changed:
// the live stream inside cac, and the tenant's webhook.
//
// Package-level rather than a method, because the task side raises channel items
// too now — someone on the team filing a bug on a client's board — and a second
// copy of "who has to hear about this" is exactly how one of them ends up
// missing a case.
//
// `from` is a positional argument on purpose. A tenant receives the webhook for
// the change it just made itself, and without this it cannot tell its own action
// from ours. Burying it in the data map made it forgettable; the compiler
// doesn't forget.
func emitItemEvent(hub *events.Hub, repo *repository.ReportRepository,
	eventType, itemID, from string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	data["from"] = from
	target, err := repo.EventTargetForReport(itemID)
	if err != nil {
		return
	}
	if hub != nil {
		hub.Publish(events.Event{Type: eventType, OrgID: target.OrgID, Data: data})
	}
	dispatchWebhook(target, eventType, itemID, data)
}

// ─── Ingest (public) ──────────────────────────────────────────────────────────

// Ingest creates a report for a project and forwards any screenshots to
// image-service (the web client never touches image-service or S3). The report
// row is created first so a screenshot-upload hiccup never loses the report.
//
// System-origin reports dedup by title against open reports of the same project
// (portento's createSystemBugTicket behavior) so retries don't flood the board.
func (s *ReportService) Ingest(ctx context.Context, project *domain.ReportProject, in domain.IngestReportInput) (*domain.IngestReportResult, error) {
	if len(in.Images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}

	origin := in.Origin
	if origin != "system" {
		origin = "user"
	}

	if origin == "system" {
		existing, err := s.repo.FindOpenByTitle(project.ID, in.Title)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return &domain.IngestReportResult{
				ID:      existing.ID,
				Seq:     existing.Seq,
				Folio:   domain.Folio(project.Slug, existing.Seq),
				Deduped: true,
			}, nil
		}
	}

	report := &domain.Report{
		ProjectID: project.ID,
		// De dónde salen estos dos: del proyecto que la llave de ingesta acaba
		// de identificar. No hay nada que pedirle al tenant ni ninguna consulta
		// que hacer — están en la fila que ya tenemos en la mano.
		//
		// Que faltaran es el fallo que dejó a `portento-99` fuera del tablero:
		// un item sin lista no sale en ninguna columna y su detalle contestaba
		// «list not found». La migración a items se los puso una vez a los que
		// ya existían, y desde entonces cada reporte nuevo entraba huérfano.
		OrgID:       project.OrgID,
		ListID:      inboxDe(project),
		Title:       in.Title,
		Description: in.Description,
		Status:      domain.ReportPending,
		// Normalized rather than validated: ingest is public, and refusing a
		// whole report over an unrecognised label would lose real bug reports.
		Category:      domain.NormalizeCategory(in.Category),
		Priority:      domain.ItemPriority(domain.NormalizePriority(in.Priority)),
		Area:          domain.NormalizeArea(in.Area),
		Origin:        origin,
		URL:           in.URL,
		UserAgent:     in.UserAgent,
		Viewport:      in.Viewport,
		ReporterName:  in.ReporterName,
		ReporterEmail: in.ReporterEmail,
		ReporterID:    in.ReporterID,
		// Auto-assignment: reports are born assigned to the project's default
		// agent when configured (portento's DEFAULT_ASSIGNEE_ID).
		AssigneeUserID: project.DefaultAssigneeUserID,
	}
	report.ID = uuid.NewString()

	// Encrypt telemetry/snapshot/context at rest (decision 4/7). Skipped when no
	// KEK is configured; a telemetry hiccup never blocks the report.
	if blob := buildTelemetryBlob(in); blob != nil && repository.TelemetryEncryptionEnabled() {
		if enc, err := repository.EncryptTelemetry(blob); err == nil {
			report.Telemetry = enc
			purge := time.Now().Add(telemetryTTL)
			report.TelemetryPurgeAt = &purge
		}
	}

	if err := s.repo.CreateWithSeq(report); err != nil {
		return nil, err
	}

	uploaded := 0
	if len(in.Images) > 0 {
		folder := s.storageFolder(project, report.ID)
		persisted, lastErr := s.uploadImages(ctx, report.ID, nil, in.Images, folder)
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
		uploaded = len(persisted)
		// Surface a total image-service outage; partial success is tolerated.
		if uploaded == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
	}

	folio := domain.Folio(project.Slug, report.Seq)
	// Routed through emit() like every other event. It used to publish straight
	// to the hub, which meant anything added to emit() covered four of the five
	// events and quietly skipped the one a subscriber cares about most.
	s.emit("report:new", report.ID, "reporter", map[string]any{
		"reportId": report.ID, "projectId": project.ID, "folio": folio, "title": report.Title,
	})
	// El responsable por defecto del proyecto es esta misma pregunta ya
	// contestada: quién lleva la cuenta de ese cliente. Los reportes nuevos
	// nacen asignados a él, así que avisarle es avisar a quien ya lo tiene.
	responsable := ""
	if project.DefaultAssigneeUserID != nil {
		responsable = *project.DefaultAssigneeUserID
	}
	s.avisos.reporteNuevo(domain.ViaFrom(ctx), project.OrgID, report.ID, responsable,
		"New report · "+folio, report.Title)

	return &domain.IngestReportResult{
		ID:     report.ID,
		Seq:    report.Seq,
		Folio:  folio,
		Images: uploaded,
		Token:  repository.MintReportToken(report.ID),
	}, nil
}

// UnreadSince returns the count of team replies on a report newer than sinceUnix
// (best-effort; errors yield 0).
func (s *ReportService) UnreadSince(reportID string, sinceUnix int64) int64 {
	n, err := s.repo.CountTeamCommentsSince(reportID, time.Unix(sinceUnix, 0))
	if err != nil {
		return 0
	}
	return n
}

// ReporterView returns the reporter's own view of a report (status + thread),
// omitting internal fields. Caller must already be authorized by report token.
func (s *ReportService) ReporterView(reportID string) (*domain.ReporterReportView, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	images, err := s.repo.ListImages(reportID)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.ListComments(reportID, false) // the reporter never sees a withdrawn reply
	if err != nil {
		return nil, err
	}

	var gallery []domain.ReportImageResponse
	byComment := make(map[string][]domain.ReportImageResponse)
	for _, img := range images {
		res := domain.ReportImageResponse{ID: img.ID, FileName: img.FileName, URL: signedImageURL(reportID, img.ID), CreatedAt: img.CreatedAt}
		if img.CommentID == nil {
			gallery = append(gallery, res)
		} else {
			byComment[*img.CommentID] = append(byComment[*img.CommentID], res)
		}
	}
	if gallery == nil {
		gallery = []domain.ReportImageResponse{}
	}

	out := make([]domain.ReporterCommentView, 0, len(comments))
	for _, c := range comments {
		// Read off the tagged author rather than re-deriving it. Showing the
		// reporter their own words back as a reply — which is what deducing
		// "you" from a null user id did — is the failure this guards.
		author, name := "team", ""
		switch {
		case c.Kind == domain.CommentKindSystem:
			author = "system"
		case c.Author == nil || c.Author.Kind == domain.AuthorKindReporter:
			author = "you"
		default:
			// Who answered, when we know it. Not which tenant: the reporter is a
			// user of that app and has no idea cac exists.
			name = c.Author.Name
			if c.Author.Kind == domain.AuthorKindTenant && c.Author.ExternalID == "" && c.Author.Name == c.Author.ProjectName {
				name = "" // only the project name was available; that isn't a person
			}
		}
		out = append(out, domain.ReporterCommentView{
			Author:     author,
			AuthorName: name,
			Body:       c.Body,
			Images:     byComment[c.ID],
			CreatedAt:  c.CreatedAt,
		})
	}

	return &domain.ReporterReportView{
		ID:          report.ID,
		Folio:       domain.Folio(project.Slug, report.Seq),
		Title:       report.Title,
		Description: report.Description,
		Status:      report.Status,
		CreatedAt:   report.CreatedAt,
		UpdatedAt:   report.UpdatedAt,
		Images:      gallery,
		Comments:    out,
	}, nil
}

// ReporterComment adds a comment from the reporter (author nil = reporter, per
// the model) plus optional images, and notifies the console.
func (s *ReportService) ReporterComment(ctx context.Context, reportID, body string, images []domain.IngestImage) (*domain.ReporterReportView, error) {
	if len(images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	c := &domain.ReportComment{ItemID: reportID, Kind: domain.CommentKindUser, Body: body}
	c.ID = uuid.NewString()
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}
	if len(images) > 0 {
		project, err := s.repo.ProjectForReport(reportID)
		if err != nil {
			return nil, err
		}
		folder := s.storageFolder(project, reportID)
		var persisted []domain.ReportImage
		for _, img := range images {
			res, err := s.images.UploadImage(ctx, img.FileName, img.ContentType, img.Data, folder)
			if err != nil {
				continue
			}
			ri := domain.ReportImage{ItemID: reportID, CommentID: &c.ID, Path: res.Key, FileName: img.FileName}
			ri.ID = uuid.NewString()
			persisted = append(persisted, ri)
		}
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
	}
	s.emit("report:comment", reportID, "reporter", map[string]any{"reportId": reportID, "commentId": c.ID})
	// De fuera, así que a toda la organización. Se relee el reporte porque aquí
	// sólo llega el id: el que lo escribió no tiene usuario en cac y no hay más
	// contexto a mano.
	if rep, err := s.repo.FindByID(reportID); err == nil {
		s.avisos.comentario(true, domain.ViaFrom(ctx), rep.OrgID, reportID, "",
			tituloDeRespuesta(true, rep.ReporterName), rep.Title)
	}
	return s.ReporterView(reportID)
}

// inboxDe es la lista donde aterriza lo que llega de este cliente.
//
// Vacío cuando el canal todavía no tiene ninguna vinculada. El reporte entra
// igual: es la misma regla que el resto del ingest —una categoría rara se
// normaliza, no se rechaza— porque perder el reporte de un cliente por un hueco
// de configuración nuestro es el peor de los dos fallos posibles. Se abre y se
// lee; lo único que no tiene es columna.
func inboxDe(project *domain.ReportProject) string {
	if project == nil || project.ListID == nil {
		return ""
	}
	return *project.ListID
}

// storageFolder builds the private-bucket prefix: org/<slug>/project/<slug>/<reportID>.
func (s *ReportService) storageFolder(project *domain.ReportProject, reportID string) string {
	orgSlug, _ := s.orgRepo.SlugByID(project.OrgID)
	if orgSlug == "" {
		orgSlug = project.OrgID
	}
	return fmt.Sprintf("org/%s/project/%s/%s", orgSlug, project.Slug, reportID)
}

// uploadImages pushes files to image-service and returns the rows to persist.
func (s *ReportService) uploadImages(ctx context.Context, reportID string, commentID *string, images []domain.IngestImage, folder string) ([]domain.ReportImage, error) {
	var persisted []domain.ReportImage
	var lastErr error
	for _, img := range images {
		res, err := s.images.UploadImage(ctx, img.FileName, img.ContentType, img.Data, folder)
		if err != nil {
			lastErr = err
			continue
		}
		ri := domain.ReportImage{ItemID: reportID, CommentID: commentID, Path: res.Key, FileName: img.FileName}
		ri.ID = uuid.NewString()
		persisted = append(persisted, ri)
	}
	return persisted, lastErr
}

// ─── Admin (console) ──────────────────────────────────────────────────────────

func (s *ReportService) List(orgIDs []string, q domain.ReportListQuery, superadmin bool) (*domain.ReportListResult, error) {
	return s.repo.List(orgIDs, q, superadmin)
}

// OrgIDForReport exposes the report→org resolution for handler authorization.
func (s *ReportService) OrgIDForReport(reportID string) (string, error) {
	return s.repo.OrgIDForReport(reportID)
}

// ProjectIDForReport exposes the report→project resolution, which is how a
// project-key caller is authorized: it belongs to my project, or it 404s.
func (s *ReportService) ProjectIDForReport(reportID string) (string, error) {
	return s.repo.ProjectIDForReport(reportID)
}

// Detail assembles the full report view: gallery images + comment thread with
// inline images.
// Detail assembles the console view. includeWithdrawn is true only for a cac
// user: a tenant driving its own board must not receive comments the team
// retired, not even as a gap.
func (s *ReportService) Detail(reportID string, includeWithdrawn bool) (*domain.ReportDetailResponse, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	images, err := s.repo.ListImages(reportID)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.ListComments(reportID, includeWithdrawn)
	if err != nil {
		return nil, err
	}

	var gallery []domain.ReportImageResponse
	byComment := make(map[string][]domain.ReportImageResponse)
	for _, img := range images {
		res := domain.ReportImageResponse{
			ID:        img.ID,
			CommentID: img.CommentID,
			FileName:  img.FileName,
			URL:       signedImageURL(reportID, img.ID),
			CreatedAt: img.CreatedAt,
		}
		if img.CommentID == nil {
			gallery = append(gallery, res)
		} else {
			byComment[*img.CommentID] = append(byComment[*img.CommentID], res)
		}
	}
	if gallery == nil {
		gallery = []domain.ReportImageResponse{}
	}
	for i := range comments {
		comments[i].Images = byComment[comments[i].ID]
	}
	if comments == nil {
		comments = []domain.ReportCommentResponse{}
	}

	assigneeName := ""
	// From the table the board writes to, so a card assigned on either side reads
	// the same on both.
	assigneeID, _ := s.repo.PrimaryAssignee(reportID)
	if assigneeID != "" {
		assigneeName = s.repo.UsernameByID(assigneeID)
	}

	// Decrypt telemetry for the console timeline (best-effort: a purged/absent
	// blob or missing KEK just yields no telemetry).
	var telemetry json.RawMessage
	if len(report.Telemetry) > 0 {
		if plain, err := repository.DecryptTelemetry(report.Telemetry); err == nil && json.Valid(plain) {
			telemetry = plain
		}
	}

	return &domain.ReportDetailResponse{
		ID:             report.ID,
		ProjectID:      report.ProjectID,
		ProjectSlug:    project.Slug,
		Seq:            report.Seq,
		Folio:          domain.Folio(project.Slug, report.Seq),
		Title:          report.Title,
		Description:    report.Description,
		Status:         report.Status,
		Category:       report.Category,
		Priority:       domain.ReportPriority(report.Priority.ReportWire()),
		Area:           report.Area,
		Origin:         report.Origin,
		URL:            report.URL,
		UserAgent:      report.UserAgent,
		Viewport:       report.Viewport,
		ReporterName:   report.ReporterName,
		ReporterEmail:  report.ReporterEmail,
		ReporterID:     report.ReporterID,
		AssigneeUserID: nilIfEmpty(assigneeID),
		AssigneeName:   assigneeName,
		ResolvedAt:     report.ResolvedAt,
		CreatedAt:      report.CreatedAt,
		UpdatedAt:      report.UpdatedAt,
		Images:         gallery,
		Comments:       comments,
		Telemetry:      telemetry,
	}, nil
}

// Update applies a validated status transition and/or (un)assignment, leaving
// kind=system audit comments (portento behavior).
// actorUserID va aparte de `actor` porque contestan preguntas distintas:
// `actor` es el **lado** que causó el evento —"team", "reporter", un
// proyecto— y es lo que necesita el webhook del tenant para filtrar su propio
// eco; esto es **la persona**, y es lo único que sirve para no avisarle a
// alguien de lo que acaba de hacer. Vacío cuando no hubo persona.
func (s *ReportService) Update(ctx context.Context, actor, actorUserID, reportID string, req domain.UpdateReportRequest) (*domain.ReportDetailResponse, error) {
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}

	if req.Status != nil && *req.Status != report.Status {
		if !report.Status.CanTransitionTo(*req.Status) {
			return nil, fmt.Errorf("%w: %s → %s", ErrInvalidTransition, report.Status, *req.Status)
		}
		old := report.Status
		report.Status = *req.Status
		// resolved_at is (re)set on entering resolved and NOT cleared on reopen
		// (decision inherited from portento).
		if *req.Status == domain.ReportResolved {
			now := time.Now()
			report.ResolvedAt = &now
		}
		if err := s.systemComment(reportID, fmt.Sprintf("status: %s → %s", old, *req.Status)); err != nil {
			return nil, err
		}
	}
	// Triage labels change freely — there is no illegal move between them, so
	// they are applied without the transition check status goes through.
	if req.Category != nil {
		report.Category = *req.Category
	}
	if req.Priority != nil {
		report.Priority = domain.ItemPriority(*req.Priority)
	}
	if req.Area != nil {
		report.Area = domain.NormalizeArea(*req.Area)
	}

	if req.AssigneeUserID != nil {
		before, err := s.repo.PrimaryAssignee(reportID)
		if err != nil {
			return nil, err
		}
		if *req.AssigneeUserID == "" {
			if before != "" {
				if err := s.repo.SetPrimaryAssignee(reportID, ""); err != nil {
					return nil, err
				}
				if err := s.systemComment(reportID, "unassigned"); err != nil {
					return nil, err
				}
			}
		} else {
			orgID, err := s.repo.OrgIDForReport(reportID)
			if err != nil {
				return nil, err
			}
			if _, err := s.orgRepo.GetMembership(orgID, *req.AssigneeUserID); err != nil {
				if errors.Is(err, repository.ErrMembershipNotFound) {
					return nil, ErrAssigneeNotMember
				}
				return nil, err
			}
			if err := s.repo.SetPrimaryAssignee(reportID, *req.AssigneeUserID); err != nil {
				return nil, err
			}
			name := *req.AssigneeUserID
			if u, err := s.authRepo.FindByID(*req.AssigneeUserID); err == nil {
				name = u.Username
			}
			if err := s.systemComment(reportID, "assigned to "+name); err != nil {
				return nil, err
			}
		}
	}

	if err := s.repo.Save(report); err != nil {
		return nil, err
	}
	if req.Status != nil {
		s.emit("report:status", reportID, actor, map[string]any{
			"reportId": reportID, "status": report.Status,
		})
		s.avisos.estado(domain.ViaFrom(ctx), report.OrgID, reportID, actorUserID,
			"Moved to "+string(report.Status), report.Title)
	}
	return s.Detail(reportID, actorIsPerson(actor))
}

// systemComment appends an immutable kind=system audit mark to the thread.
func (s *ReportService) systemComment(reportID, body string) error {
	c := &domain.ReportComment{ItemID: reportID, Kind: domain.CommentKindSystem, Body: body}
	c.ID = uuid.NewString()
	return s.repo.CreateComment(c)
}

// AddComment creates a user comment, optionally with inline images. Body may be
// empty when images are attached (portento behavior).
func (s *ReportService) AddComment(ctx context.Context, callerID, reportID, body string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	return s.addComment(ctx, commentAuthor{userID: &callerID, from: "team"}, reportID, body, images)
}

// AddProjectComment records a reply written by a tenant app through its project
// key. It is a separate entry point rather than a nullable argument on
// AddComment so the path people use keeps its signature, and so the one caller
// that has no user has to say so out loud.
func (s *ReportService) AddProjectComment(ctx context.Context, p domain.TenantAuthor, reportID, body string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	return s.addComment(ctx, commentAuthor{
		projectID:    &p.ProjectID,
		externalID:   p.ExternalID,
		externalName: p.ExternalName,
		from:         "project:" + p.ProjectSlug,
	}, reportID, body, images)
}

// commentAuthor is whoever is speaking: a cac user, or a person at a tenant app
// vouched for by that tenant's project. Exactly one of userID / projectID is set.
type commentAuthor struct {
	userID *string
	// projectID is the tenant that vouched; externalID/externalName are who it
	// says wrote this. The tenant is proven, the person is asserted.
	projectID    *string
	externalID   string
	externalName string
	from         string // what the emitted event reports as the cause
}

func (s *ReportService) addComment(ctx context.Context, author commentAuthor, reportID, body string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	if body == "" && len(images) == 0 {
		return nil, ErrEmptyComment
	}
	if len(images) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	report, err := s.repo.FindByID(reportID)
	if err != nil {
		return nil, err
	}
	author.from = causedBy(author, report.ReporterID)

	c := &domain.ReportComment{
		ItemID: reportID, Kind: domain.CommentKindUser,
		AuthorUserID: author.userID, AuthorProjectID: author.projectID,
		AuthorExternalID: author.externalID, AuthorExternalName: author.externalName,
		Body: body,
	}
	c.ID = uuid.NewString()
	if err := s.repo.CreateComment(c); err != nil {
		return nil, err
	}

	if len(images) > 0 {
		project, err := s.repo.ProjectForReport(reportID)
		if err != nil {
			return nil, err
		}
		folder := s.storageFolder(project, reportID)
		persisted, lastErr := s.uploadImages(ctx, reportID, &c.ID, images, folder)
		if err := s.repo.AddImages(persisted); err != nil {
			return nil, err
		}
		if len(persisted) == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
	}
	// The author rides along so a receiver can attribute the reply without
	// fetching the report back. `from` stays what it is — the echo filter.
	data := map[string]any{"reportId": reportID, "commentId": c.ID}
	// Which *person* caused this, when it was one of ours.
	//
	// `from` says which side, and that was enough for a tenant deciding whether
	// it caused its own event. It is not enough for us: every console in the
	// organization hears "team", including the one belonging to whoever just
	// typed the comment — so they get told about their own reply.
	if author.userID != nil {
		data["actorId"] = *author.userID
	}
	if author.externalName != "" {
		data["authorName"] = author.externalName
	}
	if author.externalID != "" {
		data["authorId"] = author.externalID
	}
	s.emit("report:comment", reportID, author.from, data)
	// `from` ya distingue las dos procedencias y es lo que decide el reparto:
	// "team" es un compañero; "reporter" y "project:<slug>" vienen de fuera.
	externo := author.from != "team"
	nombre := author.externalName
	if nombre == "" && externo {
		nombre = report.ReporterName
	}
	actor := ""
	if author.userID != nil {
		actor = *author.userID
	}
	s.avisos.comentario(externo, domain.ViaFrom(ctx), report.OrgID, reportID, actor,
		tituloDeRespuesta(externo, nombre), report.Title)
	return s.Detail(reportID, author.projectID == nil)
}

// ownsComment decides whether this caller may change a comment.
//
// For a person it is the usual "you wrote it". For a tenant app it is "my
// project wrote it", and a non-empty label is enough to establish that: a label
// is only ever set by AddProjectComment, and by the time we get here the report
// itself has already been proven to belong to the caller's project. One report
// belongs to one project, so a labelled comment on it came from that project and
// no other.
//
// That inference breaks the day a person can post with a label. If that ever
// happens, this needs a project id on the row instead.
// actorIsPerson reads the same string the events carry, so Update and
// AttachImages don't need a second parameter saying what they already know.
func actorIsPerson(actor string) bool { return !strings.HasPrefix(actor, "project:") }

// causedBy names who an event should be attributed to.
//
// A tenant relays comments from all of its people, and one of them is whoever
// filed the report. Attributing that person's own reply to the project is what
// makes the tenant's echo filter discard it, so nobody on their side learns a
// user answered. The author's id decides, not the credential that carried it.
func causedBy(author commentAuthor, reporterID string) string {
	if author.projectID != nil && author.externalID != "" && author.externalID == reporterID {
		return "reporter"
	}
	return author.from
}

func ownsComment(author commentAuthor, c *domain.ReportComment) bool {
	if author.projectID != nil {
		return c.AuthorProjectID != nil && *c.AuthorProjectID == *author.projectID
	}
	return c.AuthorUserID != nil && author.userID != nil && *c.AuthorUserID == *author.userID
}

// EditComment updates the body of the caller's own user comment.
func (s *ReportService) EditComment(ctx context.Context, callerID, reportID, commentID string, edit CommentEdit) (*domain.ReportDetailResponse, error) {
	return s.editComment(ctx, commentAuthor{userID: &callerID, from: "team"}, reportID, commentID, edit)
}

// EditProjectComment lets a tenant app correct a reply its own key wrote.
func (s *ReportService) EditProjectComment(ctx context.Context, p domain.TenantAuthor, reportID, commentID string, edit CommentEdit) (*domain.ReportDetailResponse, error) {
	return s.editComment(ctx, commentAuthor{projectID: &p.ProjectID, from: "project:" + p.ProjectSlug}, reportID, commentID, edit)
}

// DeleteProjectComment removes a reply the tenant's own key wrote. Soft, like
// every other delete here — the row keeps its deleted_at and its images go with
// it.
func (s *ReportService) DeleteProjectComment(projectID, reportID, commentID string) error {
	return s.deleteComment(commentAuthor{projectID: &projectID}, reportID, commentID)
}

// CommentEdit is everything one edit can change. A nil Body leaves the text
// alone, which is what lets "just remove that screenshot" be an edit too.
type CommentEdit struct {
	Body     *string
	Add      []domain.IngestImage
	RemoveID []string
}

func (s *ReportService) editComment(ctx context.Context, author commentAuthor, reportID, commentID string, edit CommentEdit) (*domain.ReportDetailResponse, error) {
	c, err := s.repo.FindComment(reportID, commentID)
	if err != nil {
		return nil, err
	}
	if c.Kind == domain.CommentKindSystem {
		return nil, ErrCommentImmutable
	}
	if !ownsComment(author, c) {
		return nil, ErrNotCommentAuthor
	}
	if len(edit.Add) > 0 && !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}

	// Every id has to belong to *this* comment. Without it the endpoint would be
	// a way to delete any image on the report — including the gallery and other
	// people's replies — just by naming it here.
	current, err := s.repo.ListCommentImages(commentID)
	if err != nil {
		return nil, err
	}
	owned := make(map[string]bool, len(current))
	for _, img := range current {
		owned[img.ID] = true
	}
	for _, id := range edit.RemoveID {
		if !owned[id] {
			return nil, ErrImageNotInComment
		}
	}

	// Refuse before touching anything if the edit would leave the comment with
	// neither text nor images — the same rule that stops an empty one being
	// created, applied to the state the edit would produce.
	body := c.Body
	if edit.Body != nil {
		body = strings.TrimSpace(*edit.Body)
	}
	if body == "" && len(current)-len(edit.RemoveID)+len(edit.Add) == 0 {
		return nil, ErrEmptyComment
	}

	// Upload before the transaction: it talks to image-service, which is slow
	// and can fail, and a half-written comment is worse than a rejected edit.
	var persisted []domain.ReportImage
	if len(edit.Add) > 0 {
		project, err := s.repo.ProjectForReport(reportID)
		if err != nil {
			return nil, err
		}
		up, lastErr := s.uploadImages(ctx, reportID, &commentID, edit.Add, s.storageFolder(project, reportID))
		if len(up) == 0 && lastErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
		}
		persisted = up
	}

	// One edit, one write. Text and images move together or not at all.
	if err := s.repo.ApplyCommentEdit(commentID, body, persisted, edit.RemoveID); err != nil {
		return nil, err
	}

	// Same rule as posting: an edit to the reporter's own reply is caused by the
	// reporter, whichever credential carried it.
	from := author.from
	if rep, err := s.repo.FindByID(reportID); err == nil {
		from = causedBy(author, rep.ReporterID)
	}
	s.emit("report:comment", reportID, from, map[string]any{
		"reportId": reportID, "commentId": commentID, "edited": true,
	})
	return s.Detail(reportID, author.projectID == nil)
}

// DeleteComment removes the caller's own user comment (and its inline images).
func (s *ReportService) DeleteComment(callerID, reportID, commentID string) error {
	return s.deleteComment(commentAuthor{userID: &callerID}, reportID, commentID)
}

func (s *ReportService) deleteComment(author commentAuthor, reportID, commentID string) error {
	c, err := s.repo.FindComment(reportID, commentID)
	if err != nil {
		return err
	}
	if c.Kind == domain.CommentKindSystem {
		return ErrCommentImmutable
	}
	if !ownsComment(author, c) {
		return ErrNotCommentAuthor
	}
	return s.repo.DeleteComment(commentID)
}

// AttachImages uploads screenshots to the report gallery, leaving a system
// audit comment (portento behavior).
func (s *ReportService) AttachImages(ctx context.Context, actor, reportID string, images []domain.IngestImage) (*domain.ReportDetailResponse, error) {
	if len(images) == 0 {
		return nil, ErrEmptyComment
	}
	if !s.images.Enabled() {
		return nil, ErrImagesUnavailable
	}
	if _, err := s.repo.FindByID(reportID); err != nil {
		return nil, err
	}
	project, err := s.repo.ProjectForReport(reportID)
	if err != nil {
		return nil, err
	}
	folder := s.storageFolder(project, reportID)
	persisted, lastErr := s.uploadImages(ctx, reportID, nil, images, folder)
	if err := s.repo.AddImages(persisted); err != nil {
		return nil, err
	}
	if len(persisted) == 0 && lastErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrImagesUnavailable, lastErr)
	}
	if err := s.systemComment(reportID, fmt.Sprintf("attached %d image(s)", len(persisted))); err != nil {
		return nil, err
	}
	s.emit("report:attachment", reportID, actor, map[string]any{
		"reportId": reportID, "attached": len(persisted),
	})
	return s.Detail(reportID, actorIsPerson(actor))
}

// DetachImage soft-deletes a gallery image, leaving a system audit comment.
func (s *ReportService) DetachImage(reportID, imageID string) error {
	img, err := s.repo.FindImage(reportID, imageID)
	if err != nil {
		return err
	}
	// The gallery is triage material and anyone triaging may prune it. An image
	// inside a comment belongs to that comment, and so does the right to remove
	// it — otherwise this endpoint quietly reopens what comment ownership
	// closes, letting a tenant strip a screenshot off a colleague's reply.
	if img.CommentID != nil {
		return ErrImageInComment
	}
	if err := s.repo.DeleteImage(img.ID); err != nil {
		return err
	}
	return s.systemComment(reportID, "removed image "+img.FileName)
}

// newSystemComment builds the line a state change leaves in a thread.
//
// Public, because the reporter is shown these today — "status: pending →
// in_progress" is how they learn anything is happening — and filing them
// internal would be a silent downgrade of what they already receive.
// nilIfEmpty keeps the contract's optional field optional: the tenant reads an
// absent assignee as "nobody", and "" would render as an empty name.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func newSystemComment(itemID, body string) *domain.ReportComment {
	c := &domain.ReportComment{
		ItemID:     itemID,
		Kind:       domain.CommentKindSystem,
		Visibility: domain.VisibilityPublic,
		Body:       body,
	}
	c.ID = uuid.NewString()
	return c
}
