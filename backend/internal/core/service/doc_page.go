package service

import (
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	// ErrDocPageConflict: alguien guardó la página entre la lectura y esto.
	ErrDocPageConflict = errors.New("this page changed since you read it")
	// ErrDocBodyTooLong: más de `domain.MaxDocBodyChars`.
	ErrDocBodyTooLong = errors.New("this text is too long for one page; split it into subpages")
)

// docOf: el documento de un nodo, o nil si todavía no tiene. Sin documento no
// hay páginas, y eso no es un error: es un árbol vacío.
func (s *DocService) docOf(kind domain.DocOwnerKind, ownerID string) (*domain.Doc, error) {
	return s.repo.Find(kind, ownerID)
}

// PageTree: el árbol de páginas de un nodo (o su papelera).
func (s *DocService) PageTree(kind domain.DocOwnerKind, ownerID string, trashed bool) ([]domain.DocPageTreeItem, error) {
	doc, err := s.docOf(kind, ownerID)
	if err != nil || doc == nil {
		return []domain.DocPageTreeItem{}, err
	}
	return s.repo.PageTree(doc.ID, trashed)
}

func (s *DocService) CreatePage(
	orgID string, kind domain.DocOwnerKind, ownerID string, req domain.CreateDocPageRequest, userID string,
) (*domain.DocPage, error) {
	if domain.DocBodyTooLong(req.Body) {
		return nil, ErrDocBodyTooLong
	}
	return s.repo.CreatePage(orgID, kind, ownerID, req, userID)
}

// page: una página de este nodo. Que la página exista no basta: tiene que ser
// del documento del nodo de la URL, o un id de otra organización la abriría.
func (s *DocService) page(kind domain.DocOwnerKind, ownerID, pageID string) (*domain.Doc, *domain.DocPage, error) {
	doc, err := s.docOf(kind, ownerID)
	if err != nil {
		return nil, nil, err
	}
	if doc == nil {
		return nil, nil, repository.ErrDocPageNotFound
	}
	p, err := s.repo.FindPage(doc.ID, pageID)
	if err != nil {
		return nil, nil, err
	}
	return doc, p, nil
}

// GetPage: la página, sus migas de pan y sus hijas.
func (s *DocService) GetPage(kind domain.DocOwnerKind, ownerID, pageID string) (*domain.DocPageView, error) {
	doc, p, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	crumbs, err := s.repo.Breadcrumb(p.ID)
	if err != nil {
		return nil, err
	}
	kids, err := s.repo.Children(doc.ID, &p.ID)
	if err != nil {
		return nil, err
	}
	// Las referencias son un extra: si fallan, la página se abre igual.
	refs, _ := s.repo.PageBacklinks(doc.OrgID, p.ID)
	if refs == nil {
		refs = []domain.DocBacklink{}
	}
	return &domain.DocPageView{
		Page: p, Breadcrumb: crumbs, Children: kids, OrgID: doc.OrgID, ReferencedFrom: refs,
	}, nil
}

// SavePage guarda título y/o cuerpo, con la misma detección de conflicto que
// las pestañas (`DocSaveConflicts`): un agente por MCP y una persona con la
// página abierta escriben a la vez, y aplicar el guardado tardío borraría lo
// del otro sin que nadie se entere.
func (s *DocService) SavePage(
	kind domain.DocOwnerKind, ownerID, pageID string, req domain.SaveDocPageRequest, userID string,
) (*domain.DocPage, error) {
	doc, p, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	if req.Body != nil {
		if domain.DocBodyTooLong(*req.Body) {
			return nil, ErrDocBodyTooLong
		}
		if domain.DocSaveConflicts(p.BodyHash, req.BaseHash) {
			return nil, ErrDocPageConflict
		}
	}
	antes := p.Body
	if err := s.repo.SavePage(p, req.Title, req.Body, userID); err != nil {
		return nil, err
	}
	if req.Body != nil {
		s.pruneUncited(doc.ID, antes, *req.Body)
	}
	_, out, err := s.page(kind, ownerID, pageID)
	return out, err
}

func (s *DocService) AppendPage(kind domain.DocOwnerKind, ownerID, pageID, text, userID string) (*domain.DocPage, error) {
	_, p, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	if domain.DocBodyTooLong(p.Body + "\n\n" + text) {
		return nil, ErrDocBodyTooLong
	}
	if err := s.repo.AppendPage(p.ID, text, userID); err != nil {
		return nil, err
	}
	_, out, err := s.page(kind, ownerID, pageID)
	return out, err
}

// MovePage devuelve el árbol entero ya movido: quien movió tenía una copia que
// puede estar vieja (otro movió a la vez), y así se resincroniza en el viaje.
func (s *DocService) MovePage(
	kind domain.DocOwnerKind, ownerID, pageID string, req domain.MoveDocPageRequest,
) ([]domain.DocPageTreeItem, error) {
	doc, _, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.MovePage(doc.ID, pageID, req); err != nil {
		return nil, err
	}
	return s.repo.PageTree(doc.ID, false)
}

// TrashPage: a la papelera con todo lo que cuelga. Devuelve cuántas se fueron.
func (s *DocService) TrashPage(kind domain.DocOwnerKind, ownerID, pageID string) (int, error) {
	doc, _, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return 0, err
	}
	return s.repo.TrashPage(doc.ID, pageID)
}

// RestorePage: de la papelera, con lo que se fue a la vez.
func (s *DocService) RestorePage(kind domain.DocOwnerKind, ownerID, pageID string) error {
	doc, err := s.docOf(kind, ownerID)
	if err != nil {
		return err
	}
	if doc == nil {
		return repository.ErrDocPageNotFound
	}
	return s.repo.RestorePage(doc.ID, pageID)
}

func (s *DocService) PageVersions(kind domain.DocOwnerKind, ownerID, pageID string) ([]domain.DocPageVersion, error) {
	_, p, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	return s.repo.PageVersions(p.ID)
}

// RestorePageVersion es un guardado más, sin `baseHash`: restaurar es
// deliberado, y lo que se pisa entra al historial como cualquier otro guardado.
func (s *DocService) RestorePageVersion(
	kind domain.DocOwnerKind, ownerID, pageID, versionID, userID string,
) (*domain.DocPage, error) {
	_, p, err := s.page(kind, ownerID, pageID)
	if err != nil {
		return nil, err
	}
	v, err := s.repo.FindPageVersion(p.ID, versionID)
	if err != nil {
		return nil, err
	}
	body := v.Body
	return s.SavePage(kind, ownerID, pageID, domain.SaveDocPageRequest{Body: &body, BaseHash: &p.BodyHash}, userID)
}

// pruneUncited quita los adjuntos que el último guardado dejó de citar y que
// ya no cita **nada** del documento: ni otra pestaña, ni otra página, ni una
// página de la papelera (restaurarla no puede encontrar un hueco).
//
// Estrecha a propósito, como la regla de las tareas: sólo mira los que estaban
// en el texto de antes y no en el de ahora. Podar todo lo no citado borraría la
// imagen que alguien acaba de pegar y que todavía no se guardó en ningún texto.
func (s *DocService) pruneUncited(docID, before, after string) {
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
		cited, err := s.repo.AttachmentCited(docID, a.ID)
		if err != nil || cited {
			// Sin poder preguntar, no se borra: perder un fichero por un error de
			// lectura es peor que dejar uno huérfano.
			continue
		}
		if err := s.repo.DeleteAttachment(a.ID); err != nil {
			lg.Error("drop removed doc attachment " + a.ID + ": " + err.Error())
		}
	}
}
