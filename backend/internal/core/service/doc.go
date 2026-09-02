package service

import (
	"errors"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ErrNotAColleague: el responsable propuesto no está en la organización.
var ErrNotAColleague = errors.New("that person is not in this organization")

type DocService struct {
	repo *repository.DocRepository
}

func NewDocService(repo *repository.DocRepository) *DocService {
	return &DocService{repo: repo}
}

func (s *DocService) OwnerOrg(kind domain.DocOwnerKind, id string) (string, error) {
	return s.repo.OwnerOrg(kind, id)
}

// Get returns the node's document. Never an error for "not written yet": an
// empty overview is the normal starting state, and the caller renders the same
// editor either way.
func (s *DocService) Get(kind domain.DocOwnerKind, id string) (*domain.Doc, error) {
	d, err := s.repo.Find(kind, id)
	if err != nil || d == nil {
		return nil, err
	}
	s.stampAuthor(d)
	return d, nil
}

func (s *DocService) Save(orgID string, kind domain.DocOwnerKind, id, body, userID string) (*domain.Doc, error) {
	before := ""
	if prev, err := s.repo.Find(kind, id); err == nil && prev != nil {
		before = prev.Body
	}
	d, err := s.repo.Save(orgID, kind, id, body, userID)
	if err != nil {
		return nil, err
	}
	s.dropRemovedAttachments(d.ID, before, body)
	s.stampAuthor(d)
	return d, nil
}

// Tabs: las cuatro secciones, con las vacías incluidas.
func (s *DocService) Tabs(docID string) ([]domain.DocTab, error) { return s.repo.Tabs(docID) }

// SaveTab guarda una sección y limpia los adjuntos que dejaron de citarse.
//
// La limpieza mira **el documento entero**, no sólo la pestaña que se guarda: un
// fichero citado desde Overview y desde Runbook no puede borrarse porque una de
// las dos lo suelte.
func (s *DocService) SaveTab(
	orgID string, kind domain.DocOwnerKind, ownerID string,
	key domain.DocTabKey, body, userID string,
) (*domain.Doc, error) {
	antes := ""
	if doc, err := s.repo.Find(kind, ownerID); err == nil && doc != nil {
		if tabs, err := s.repo.Tabs(doc.ID); err == nil {
			for _, t := range tabs {
				if t.Key == key {
					antes = t.Body
				}
			}
		}
	}
	doc, err := s.repo.SaveTab(orgID, kind, ownerID, key, body, userID)
	if err != nil {
		return nil, err
	}
	if antes != body {
		s.dropRemovedAttachments(doc.ID, antes, s.allTabsText(doc.ID))
	}
	s.stampAuthor(doc)
	return doc, nil
}

// Todo el markdown del documento junto, para decidir si un adjunto sigue citado.
func (s *DocService) allTabsText(docID string) string {
	tabs, err := s.repo.Tabs(docID)
	if err != nil {
		// Sin poder leerlas, no se borra nada: perder un fichero por un error de
		// lectura es peor que dejar uno huérfano.
		return ""
	}
	var todo string
	for _, t := range tabs {
		todo += t.Body
	}
	return todo
}

// Versions: el historial de una sección.
func (s *DocService) Versions(docID string, key domain.DocTabKey) ([]domain.DocVersion, error) {
	return s.repo.Versions(docID, key, domain.DocVersionKeep)
}

// Restore devuelve una sección a un estado anterior.
//
// Restaurar **es** un guardado, no una operación aparte: pasa por `SaveTab`, así
// que el texto que se está pisando entra al historial como cualquier otro. Sin
// eso, deshacer sería la única acción de la que no se puede volver.
func (s *DocService) Restore(
	orgID string, kind domain.DocOwnerKind, ownerID string, docID, versionID, userID string,
) (*domain.Doc, error) {
	v, err := s.repo.FindVersion(docID, versionID)
	if err != nil {
		return nil, err
	}
	return s.SaveTab(orgID, kind, ownerID, v.Key, v.Body, userID)
}

func (s *DocService) HasDoc(orgID string) (map[string]domain.DocMark, error) {
	return s.repo.HasDoc(orgID)
}

func (s *DocService) FindByID(id string) (*domain.Doc, error) { return s.repo.FindByID(id) }

func (s *DocService) Attachments(docID string) ([]domain.DocAttachment, error) {
	atts, err := s.repo.Attachments(docID)
	if err != nil {
		return nil, err
	}
	for i := range atts {
		atts[i].NormalizeURL()
	}
	return atts, nil
}

func (s *DocService) AddAttachment(a *domain.DocAttachment) error {
	return s.repo.CreateAttachment(a)
}

func (s *DocService) FindAttachment(id string) (*domain.DocAttachment, error) {
	return s.repo.FindAttachment(id)
}

func (s *DocService) DeleteAttachment(id string) error { return s.repo.DeleteAttachment(id) }

// dropRemovedAttachments mirrors the task rule: a file stops being listed when
// the reference the user just deleted was in the previous text and is gone from
// the new one. Narrow on purpose — pruning everything unreferenced would delete
// an image pasted seconds ago that hasn't been saved into any text yet.
func (s *DocService) dropRemovedAttachments(docID, before, after string) {
	if before == "" || before == after {
		return
	}
	atts, err := s.repo.Attachments(docID)
	if err != nil {
		return
	}
	for _, a := range atts {
		if !strings.Contains(before, a.ID) || strings.Contains(after, a.ID) {
			continue
		}
		if err := s.repo.DeleteAttachment(a.ID); err != nil {
			lg.Error("drop removed doc attachment " + a.ID + ": " + err.Error())
		}
	}
}

// stampAuthor fills the display names the row only stores as ids, and resuelve
// la frescura, que depende de qué día es hoy y por eso no está guardada.
func (s *DocService) stampAuthor(d *domain.Doc) {
	if d == nil {
		return
	}
	d.UpdatedByName = s.repo.AuthorName(d.UpdatedBy)
	if d.MaintainerID != "" {
		d.MaintainerName = s.repo.AuthorName(d.MaintainerID)
	}
	if d.ReviewedBy != "" {
		d.ReviewedByName = s.repo.AuthorName(d.ReviewedBy)
	}
	d.Stale = domain.DocIsStale(d.ReviewedAt, d.UpdatedAt, time.Now())
}

// Patch cambia responsable, revisión y línea fijada.
//
// El responsable se comprueba contra la organización: apuntar a alguien de fuera
// deja un documento cuyo dueño nadie puede ver y que por tanto nadie va a
// revisar nunca. Vaciarlo sí se permite —«esto no tiene dueño» es un estado
// real, y el índice lo pinta en rojo justamente para que se note.
func (s *DocService) Patch(
	orgID string, kind domain.DocOwnerKind, ownerID, userID string, req domain.PatchDocRequest,
) (*domain.Doc, error) {
	fields := map[string]any{}
	if req.MaintainerID != nil {
		quien := strings.TrimSpace(*req.MaintainerID)
		if quien != "" && !s.repo.IsMember(orgID, quien) {
			return nil, ErrNotAColleague
		}
		fields["maintainer_id"] = quien
	}
	if req.PinnedLine != nil {
		fields["pinned_line"] = strings.TrimSpace(*req.PinnedLine)
	}
	if req.Reviewed != nil {
		if *req.Reviewed {
			ahora := time.Now()
			fields["reviewed_at"] = ahora
			// Quién lo confirmó, y no quién lo pidió: la firma es la mitad del
			// dato. «Revisado» sin nombre no se le puede preguntar a nadie.
			fields["reviewed_by"] = userID
		} else {
			fields["reviewed_at"] = nil
			fields["reviewed_by"] = ""
		}
	}
	d, err := s.repo.Patch(orgID, kind, ownerID, fields)
	if err != nil {
		return nil, err
	}
	s.stampAuthor(d)
	return d, nil
}
