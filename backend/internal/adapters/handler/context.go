package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// contextSource: lo que el handler usa de service.ContextService. Interfaz
// para probar quién puede pedir qué sin montar la base.
type contextSource interface {
	FindSpace(id string) (*domain.TaskSpace, error)
	ResolveRepo(fullName string, orgIDs []string) (spaceID, orgID string, err error)
	Map(orgID, spaceID string, repo *domain.ContextRepo) (domain.ContextMap, error)
}

type ContextHandler struct{ svc contextSource }

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
	m, err := h.svc.Map(orgID, spaceID, repo)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Context failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.ContextMap]{Success: true, Data: m})
}
