package handler

import (
	"errors"
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
		tok := strings.TrimPrefix(h, "Bearer ")
		if strings.HasPrefix(tok, repository.PATPrefix) {
			return claimsFromPAT(tok, scope)
		}
		return repository.ValidateAccessToken(tok)
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

// patAuth resuelve un token personal. Lo pone middleware.UsePATAuthenticator,
// que es donde se cablea para toda la API: así no hay dos sitios que olvidar.
var patAuth func(token string) (*domain.ClaimsJWT, error)

// UsePATAuthenticator: ver patAuth.
func UsePATAuthenticator(fn func(token string) (*domain.ClaimsJWT, error)) { patAuth = fn }

var errPATNotHere = errors.New("personal tokens cannot use this route")

// claimsFromPAT: un token personal, en la cabecera, abre un adjunto. Las rutas
// `raw` viven fuera de AuthMiddleware (un <img> no manda cabeceras), así que
// sin esto un agente con su token recibía 404 por cada adjunto que `get_task`
// le enseñaba (command-and-control-246). Sólo adjuntos: el stream de eventos
// registra presencia, y un token es una máquina, no alguien que está.
func claimsFromPAT(tok, scope string) (*domain.ClaimsJWT, error) {
	if scope != repository.URLScopeMedia || patAuth == nil {
		return nil, errPATNotHere
	}
	c, err := patAuth(tok)
	if err != nil {
		return nil, err
	}
	c.ViaToken = true
	return c, nil
}
