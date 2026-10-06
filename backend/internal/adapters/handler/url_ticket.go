package handler

import (
	"net/http"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// claimsFromHeaderOrTicket: quién pide un adjunto o el stream. Con
// `Authorization` vale el token de acceso, como en toda la API. Por la URL
// (`?token=`), sólo un pase de URL de ese alcance: el token de acceso ya no se
// acepta ahí, porque una URL acaba en los logs. Ver repository/url_ticket.go.
func claimsFromHeaderOrTicket(r *http.Request, scope string) (*domain.ClaimsJWT, error) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return repository.ValidateAccessToken(strings.TrimPrefix(h, "Bearer "))
	}
	return repository.ValidateURLTicket(r.URL.Query().Get("token"), scope)
}

// URLTicket emite un pase de URL para quien ya tiene sesión. Un token personal
// no lo pide: es una máquina, y una máquina manda cabeceras.
func (h *authHandler) URLTicket(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "invalid-token")
		return
	}
	if claims.ViaToken {
		SendErrorResponse(w, http.StatusForbidden, "Personal tokens send headers", "endpoint-not-scoped")
		return
	}
	scope := r.URL.Query().Get("scope")
	if !repository.ValidURLScope(scope) {
		SendErrorResponse(w, http.StatusBadRequest, "Unknown scope", "bad-url-scope")
		return
	}
	tok, exp, err := repository.SignURLTicket(claims, scope, time.Now())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to sign", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[domain.URLTicketResponse]{
		Success: true, Data: domain.URLTicketResponse{Ticket: tok, ExpiresAt: exp},
	})
}
