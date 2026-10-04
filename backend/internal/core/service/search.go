package service

import (
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type SearchService struct{ repo *repository.SearchRepository }

func NewSearchService(repo *repository.SearchRepository) *SearchService {
	return &SearchService{repo: repo}
}

// Search asks each source separately and hands back the answers still apart.
//
// The caller's identity goes to every source and the organization only to the
// ones the organization governs, plus direct messages: notes answer to their
// owner alone, and a direct message answers to its two participants **and** to
// the org it was written in — the fence is still the participants (the query
// starts from them), the org only narrows it to the one on screen.
//
// A short query returns nothing rather than everything. One or two letters
// match most of a database, which is a slow way to be useless.
func (s *SearchService) Search(query, orgID, userID string, limit int) (domain.SearchResults, error) {
	var out domain.SearchResults
	out.Tasks, out.Notes = []domain.SearchHit{}, []domain.SearchHit{}
	out.People, out.Messages, out.DMs = []domain.SearchHit{}, []domain.SearchHit{}, []domain.SearchHit{}
	out.Docs = []domain.SearchHit{}

	if len(strings.TrimSpace(query)) < 2 {
		return out, nil
	}
	if limit <= 0 || limit > 20 {
		limit = 8
	}

	var err error
	if out.Tasks, err = s.repo.Tasks(query, orgID, limit); err != nil {
		return out, err
	}
	if out.Notes, err = s.repo.Notes(query, userID, limit); err != nil {
		return out, err
	}
	if out.People, err = s.repo.People(query, orgID, userID, limit); err != nil {
		return out, err
	}
	if out.Messages, err = s.repo.Messages(query, orgID, limit); err != nil {
		return out, err
	}
	if out.DMs, err = s.repo.DMs(query, orgID, userID, limit); err != nil {
		return out, err
	}
	if out.Docs, err = s.repo.Docs(query, orgID, limit); err != nil {
		return out, err
	}
	// Todo lo que sale filtrado por la org es de esa org. Los directos traen la
	// suya de la consulta, y las notas no son de ninguna.
	for _, hits := range [][]domain.SearchHit{out.Tasks, out.People, out.Messages, out.Docs} {
		for i := range hits {
			hits[i].OrgID = orgID
		}
	}
	return out, nil
}

// SearchOrgs hace la misma búsqueda en varias organizaciones y junta lo que
// sale, sin repetir y sin pasar del límite por tipo. Busca **sólo** en las que
// se le pasan: quién decide cuáles son es quien llama (el handler, con las
// membresías del token).
//
// Las notas son de la persona y no de una org, así que salen en cada una: se
// quedan una vez.
func (s *SearchService) SearchOrgs(query string, orgIDs []string, userID string, limit int) (domain.SearchResults, error) {
	var out domain.SearchResults
	out.Tasks, out.Notes = []domain.SearchHit{}, []domain.SearchHit{}
	out.People, out.Messages, out.DMs = []domain.SearchHit{}, []domain.SearchHit{}, []domain.SearchHit{}
	out.Docs = []domain.SearchHit{}
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	merge := func(dst *[]domain.SearchHit, seen map[string]bool, src []domain.SearchHit) {
		for _, h := range src {
			key := string(h.Kind) + ":" + h.ID
			if len(*dst) < limit && !seen[key] {
				seen[key] = true
				*dst = append(*dst, h)
			}
		}
	}
	seen := map[string]map[string]bool{}
	for _, k := range []string{"tasks", "notes", "people", "messages", "dms", "docs"} {
		seen[k] = map[string]bool{}
	}
	for _, org := range orgIDs {
		r, err := s.Search(query, org, userID, limit)
		if err != nil {
			return out, err
		}
		merge(&out.Tasks, seen["tasks"], r.Tasks)
		merge(&out.Notes, seen["notes"], r.Notes)
		merge(&out.People, seen["people"], r.People)
		merge(&out.Messages, seen["messages"], r.Messages)
		merge(&out.DMs, seen["dms"], r.DMs)
		merge(&out.Docs, seen["docs"], r.Docs)
	}
	return out, nil
}
