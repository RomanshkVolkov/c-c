package handler

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// contextSource: lo que el handler usa de service.ContextService. Interfaz
// para probar quién puede pedir qué sin montar la base.
type contextSource interface {
	FindSpace(id string) (*domain.TaskSpace, error)
	ResolveRepo(fullName string, orgIDs []string) (spaceID, orgID string, err error)
	MapWith(orgID, spaceID string, repo *domain.ContextRepo, opts domain.ContextOptions) (domain.ContextMap, error)
}

type ContextHandler struct{ svc contextSource }

// contextOptions lee `since` (RFC 3339), `only` (lista separada por comas, de
// domain.ContextSections) y `node`. Una opción mal escrita es un 400 que dice
// qué se acepta: callarse y devolver el mapa entero haría creer que el recorte
// funcionó.
func contextOptions(r *http.Request) (domain.ContextOptions, error) {
	var opts domain.ContextOptions
	q := r.URL.Query()
	if s := strings.TrimSpace(q.Get("since")); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return opts, errors.New("since must be an RFC 3339 instant, e.g. 2026-10-22T08:00:00Z")
		}
		opts.Since = &t
	}
	if only := strings.TrimSpace(q.Get("only")); only != "" {
		for _, part := range strings.Split(only, ",") {
			part = strings.TrimSpace(part)
			if !domain.ValidContextSection(part) {
				return opts, errors.New("only accepts " + strings.Join(domain.ContextSections, ", "))
			}
			opts.Only = append(opts.Only, part)
		}
	}
	opts.Node = strings.TrimSpace(q.Get("node"))
	return opts, nil
}

func NewContextHandler(svc *service.ContextService) *ContextHandler {
	return &ContextHandler{svc: svc}
}

// Get: el mapa de contexto de un espacio (domain.ContextMap), por `?spaceId=`
// o por `?repo=owner/name`.
//
// Por repo, sólo entre las organizaciones de las que el token es **miembro**,
// como la búsqueda: lo que sale de aquí va al contexto de un agente, y ser
// superadmin no debería traerle el proyecto de otra organización porque se
// llame igual. Por espacio, quien no es de su organización recibe 404, nunca
// 403: no se dice que existe.
func (h *ContextHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	spaceID := strings.TrimSpace(r.URL.Query().Get("spaceId"))
	repoName := strings.TrimSpace(r.URL.Query().Get("repo"))
	opts, err := contextOptions(r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, err.Error(), "context-bad-options")
		return
	}
	var orgID string
	var repo *domain.ContextRepo
	switch {
	case spaceID != "":
		sp, err := h.svc.FindSpace(spaceID)
		if err != nil {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return
		}
		if _, member := user.RoleInOrg(sp.OrgID); !member && !user.Superadmin {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return
		}
		orgID = sp.OrgID
	case repoName != "":
		var err error
		spaceID, orgID, err = h.svc.ResolveRepo(repoName, MemberOrgs(user))
		if errors.Is(err, service.ErrContextRepoNotLinked) {
			SendErrorResponse(w, http.StatusNotFound,
				"This repository is not linked to a space of your organizations. Link it from the space (GitHub), or pass spaceId.",
				"context-repo-not-linked")
			return
		}
		if err != nil {
			SendErrorResponse(w, http.StatusInternalServerError, "Context failed", err.Error())
			return
		}
		repo = &domain.ContextRepo{FullName: repoName}
	default:
		SendErrorResponse(w, http.StatusBadRequest, "Pass spaceId or repo", "context-missing-target")
		return
	}
	m, err := h.svc.MapWith(orgID, spaceID, repo, opts)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Context failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.ContextMap]{Success: true, Data: m})
}
