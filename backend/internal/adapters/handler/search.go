package handler

import (
	"net/http"
	"strconv"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type SearchHandler interface {
	Search(w http.ResponseWriter, r *http.Request)
}

type searchHandler struct{ svc *service.SearchService }

func NewSearchHandler(svc *service.SearchService) SearchHandler {
	return &searchHandler{svc: svc}
}

// Search answers for whoever holds the token, in the organization they name.
//
// Membership is checked here and the organization dropped if they are not in
// it, rather than trusted downstream: every source that takes an org id treats
// an empty one as "nothing", so a non-member gets their own notes and their own
// messages and not one row more.
func (h *searchHandler) Search(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	orgID := r.URL.Query().Get("orgId")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	var res domain.SearchResults
	var err error
	if orgID == "" {
		// Sin org: en las organizaciones de las que el token es **miembro**, y
		// en ninguna más — tampoco siendo superadmin, que vería las de todo el
		// servidor. Es lo que pide el MCP, y lo que sale de ahí va al contexto
		// de un agente.
		res, err = h.svc.SearchOrgs(r.URL.Query().Get("q"), MemberOrgs(user), user.UserID, limit)
	} else {
		if !user.Superadmin {
			if _, member := user.RoleInOrg(orgID); !member {
				orgID = ""
			}
		}
		res, err = h.svc.Search(r.URL.Query().Get("q"), orgID, user.UserID, limit)
	}
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Search failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.SearchResults]{Success: true, Data: res})
}

// MemberOrgs: las organizaciones de las que el token es miembro, según sus
// membresías. Nunca «todas»: ser superadmin no cuenta aquí.
func MemberOrgs(user *domain.ClaimsJWT) []string {
	out := make([]string, 0, len(user.Orgs))
	for _, o := range user.Orgs {
		if o.OrgID != "" {
			out = append(out, o.OrgID)
		}
	}
	return out
}
