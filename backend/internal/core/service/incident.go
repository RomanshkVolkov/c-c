package service

import (
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// IncidentService: apuntar y leer lo que mordió (domain.Incident).
type IncidentService struct {
	repo *repository.IncidentRepository
	docs *repository.DocRepository
}

func NewIncidentService(repo *repository.IncidentRepository, docs *repository.DocRepository) *IncidentService {
	return &IncidentService{repo: repo, docs: docs}
}

var (
	ErrIncidentNotFound          = errors.New("incident not found")
	ErrIncidentOriginNotHere     = errors.New("that task is not in this organization")
	ErrIncidentSupersedesNotHere = errors.New("the incident to supersede is not in this organization")
	ErrIncidentAlreadySuperseded = errors.New("that incident was already superseded; name the one that replaced it")
	ErrIncidentNothingToAdd      = errors.New("nothing to add")
)

// ErrNoSuchServer: un servidor nombrado que no es de la org. Trae los que sí
// hay: sin la lista, quien llama se queda probando variantes del nombre.
type ErrNoSuchServer struct {
	Wanted  string
	Options []string
}

func (e *ErrNoSuchServer) Error() string {
	if len(e.Options) == 0 {
		return "this organization has no server called " + e.Wanted + " (it has no servers)"
	}
	return "this organization has no server called \"" + e.Wanted + "\". Its servers: " + strings.Join(e.Options, ", ")
}

// ErrBadCommit: algo que no es `sha` ni `owner/repo@sha`.
type ErrBadCommit struct{ Value string }

func (e *ErrBadCommit) Error() string {
	return "\"" + e.Value + "\" is not a commit: pass a sha (7 to 40 hex characters) or owner/repo@sha"
}

// Record apunta un incidente en el nodo. Como una decisión, lo que se nombra
// tiene que ser de la org y existir: lo escrito no se edita, y un enlace a
// nada se quedaría ahí mintiendo.
func (s *IncidentService) Record(orgID string, kind domain.DocOwnerKind, ownerID, userID, via string,
	req domain.IncidentRequest) (*domain.Incident, error) {
	if id := strings.TrimSpace(req.OriginTaskID); id != "" {
		org, err := s.docs.TaskOrgID(id)
		if err != nil {
			return nil, err
		}
		if org == "" || org != orgID {
			return nil, ErrIncidentOriginNotHere
		}
	}
	if old := strings.TrimSpace(req.Supersedes); old != "" {
		prev, err := s.repo.Raw(old)
		if err != nil || prev.OrgID != orgID {
			return nil, ErrIncidentSupersedesNotHere
		}
		if s.repo.IsSuperseded(old) {
			return nil, ErrIncidentAlreadySuperseded
		}
	}
	add, err := s.resolve(orgID, domain.IncidentAdditions{
		Servers: req.Servers, Areas: req.Areas, Commits: req.Commits, Guards: req.Guards,
	})
	if err != nil {
		return nil, err
	}
	doc, err := s.docs.Patch(orgID, kind, ownerID, nil)
	if err != nil {
		return nil, err
	}
	in := &domain.Incident{
		OrgID: orgID, DocID: doc.ID, Title: strings.TrimSpace(req.Title), Body: req.Body,
		Status: domain.IncidentStatus(req.Status), OriginTaskID: strings.TrimSpace(req.OriginTaskID),
		AuthorID: userID, Via: via, SupersedesID: strings.TrimSpace(req.Supersedes),
	}
	if err := s.repo.Create(in, add.serverIDs, add.areas, add.commits, add.guards); err != nil {
		return nil, err
	}
	return s.repo.ByID(in.ID)
}

// Add le añade lo que llegó después: un commit, la prueba, otro servidor.
func (s *IncidentService) Add(orgID, id string, a domain.IncidentAdditions) (*domain.Incident, error) {
	if a.Empty() {
		return nil, ErrIncidentNothingToAdd
	}
	add, err := s.resolve(orgID, a)
	if err != nil {
		return nil, err
	}
	if err := s.repo.Add(id, add.serverIDs, add.areas, add.commits, add.guards); err != nil {
		return nil, err
	}
	return s.repo.ByID(id)
}

// SetStatus: abierto o arreglado.
func (s *IncidentService) SetStatus(id string, st domain.IncidentStatus) (*domain.Incident, error) {
	if err := s.repo.SetStatus(id, st); err != nil {
		return nil, err
	}
	return s.repo.ByID(id)
}

// OrgOf: la org de un incidente, o ErrIncidentNotFound. Para que el handler
// decida quién puede verlo antes de cargarlo entero.
func (s *IncidentService) OrgOf(id string) (string, error) {
	in, err := s.repo.Raw(id)
	if err != nil {
		return "", ErrIncidentNotFound
	}
	return in.OrgID, nil
}

func (s *IncidentService) Get(id string) (*domain.Incident, error) {
	in, err := s.repo.ByID(id)
	if err != nil {
		return nil, ErrIncidentNotFound
	}
	return in, nil
}

// List: ver IncidentRepository.List. `truncated` dice si había más.
func (s *IncidentService) List(f domain.IncidentFilter) (out []domain.IncidentSummary, truncated bool, err error) {
	limit := f.Limit
	if limit <= 0 || limit > domain.IncidentListMax {
		limit = domain.IncidentListMax
	}
	f.Limit = limit
	out, err = s.repo.List(f)
	if err != nil {
		return nil, false, err
	}
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

type resolvedAdditions struct {
	serverIDs []string
	areas     []string
	commits   []domain.IncidentCommit
	guards    []string
}

// resolve pasa lo que nombra quien llama a lo que se guarda: servidores por
// nombre o id de la org, áreas normalizadas, commits leídos y completados con
// lo que cac ya vio de ellos, y guardianes sin repetir.
func (s *IncidentService) resolve(orgID string, a domain.IncidentAdditions) (resolvedAdditions, error) {
	var out resolvedAdditions
	if len(a.Servers) > 0 {
		all, err := s.repo.OrgServers(orgID)
		if err != nil {
			return out, err
		}
		seen := map[string]bool{}
		for _, want := range a.Servers {
			want = strings.TrimSpace(want)
			if want == "" {
				continue
			}
			id := ""
			for _, sv := range all {
				if sv.ID == want || strings.EqualFold(sv.Name, want) {
					id = sv.ID
					break
				}
			}
			if id == "" {
				names := make([]string, len(all))
				for i, sv := range all {
					names[i] = sv.Name
				}
				return out, &ErrNoSuchServer{Wanted: want, Options: names}
			}
			if !seen[id] {
				seen[id] = true
				out.serverIDs = append(out.serverIDs, id)
			}
		}
	}
	seen := map[string]bool{}
	for _, raw := range a.Areas {
		if ar := domain.NormalizeIncidentArea(raw); ar != "" && !seen[ar] {
			seen[ar] = true
			out.areas = append(out.areas, ar)
		}
	}
	seen = map[string]bool{}
	for _, raw := range a.Commits {
		repo, sha, ok := domain.ParseCommitRef(raw)
		if !ok {
			return out, &ErrBadCommit{Value: raw}
		}
		c := domain.IncidentCommit{SHA: sha, Repo: repo}
		if knownRepo, full, title, url := s.repo.CommitLink(orgID, repo, sha); full != "" {
			if r := []rune(title); len(r) > 200 {
				title = string(r[:200])
			}
			c.SHA, c.Title, c.HTMLURL = full, title, url
			if c.Repo == "" {
				c.Repo = knownRepo
			}
		}
		if !seen[c.SHA] {
			seen[c.SHA] = true
			out.commits = append(out.commits, c)
		}
	}
	seen = map[string]bool{}
	for _, g := range a.Guards {
		if g = strings.TrimSpace(g); g != "" && !seen[g] {
			seen[g] = true
			out.guards = append(out.guards, g)
		}
	}
	return out, nil
}
