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
	if orgID != "" && !user.Superadmin {
		if _, member := user.RoleInOrg(orgID); !member {
			orgID = ""
		}
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	res, err := h.svc.Search(r.URL.Query().Get("q"), orgID, user.UserID, limit)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Search failed", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.SearchResults]{Success: true, Data: res})
}
