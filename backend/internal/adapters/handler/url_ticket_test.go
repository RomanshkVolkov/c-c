package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
El token fuera de las URLs (barrido de seguridad, 6-oct-2026). Por `?token=`
sólo entra un pase de URL del alcance de esa ruta; el token de acceso ya no,
porque una URL acaba en los logs. Y un pase no sirve como token de acceso: si
se filtra, abre adjuntos o el stream media hora, no la API.
*/

var ticketOwner = &domain.ClaimsJWT{UserID: "u-ana", Username: "ana",
	Orgs: []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}}

func conToken(tok string) *http.Request {
	return httptest.NewRequest(http.MethodGet, "/api/v1/tasks/attachments/a/file?token="+tok, nil)
}

// Mutantes: aceptar también el token de acceso en la URL; no mirar el alcance;
// firmar el pase con la llave de acceso.
func TestOnlyAScopedTicketRidesTheURL(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	t.Setenv("JWT_SECRET_REFRESH", "r-test")
	par, err := repository.GenerateTokens(ticketOwner.UserID, ticketOwner.Username, false, ticketOwner.Orgs)
	if err != nil {
		t.Fatal(err)
	}
	media, _, _ := repository.SignURLTicket(ticketOwner, repository.URLScopeMedia, time.Now())
	events, _, _ := repository.SignURLTicket(ticketOwner, repository.URLScopeEvents, time.Now())

	if !attachmentViewer(conToken(media), "org-1") {
		t.Error("un pase de adjuntos no abre un adjunto")
	}
	if attachmentViewer(conToken(par.AccessToken), "org-1") {
		t.Error("el token de acceso sigue valiendo en la URL")
	}
	if attachmentViewer(conToken(events), "org-1") {
		t.Error("un pase del stream abre adjuntos")
	}
	if attachmentViewer(conToken(media), "org-2") {
		t.Error("un pase abre adjuntos de otra org")
	}
	if _, err := repository.ValidateAccessToken(media); err == nil {
		t.Error("un pase de URL vale como token de acceso")
	}
	cabecera := httptest.NewRequest(http.MethodGet, "/api/v1/tasks/attachments/a/file", nil)
	cabecera.Header.Set("Authorization", "Bearer "+par.AccessToken)
	if !attachmentViewer(cabecera, "org-1") {
		t.Error("el token de acceso en la cabecera dejó de valer")
	}
}

// Un pase caduca, y lleva la identidad de quien lo pidió (también si es una
// sesión web). Mutantes: sin caducidad; perder el claim web.
func TestATicketExpiresAndKeepsWhoAsked(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	web := *ticketOwner
	web.Web = true
	viejo, _, _ := repository.SignURLTicket(&web, repository.URLScopeMedia, time.Now().Add(-repository.URLTicketTTL-time.Minute))
	if _, err := repository.ValidateURLTicket(viejo, repository.URLScopeMedia); err == nil {
		t.Error("un pase caducado sigue valiendo")
	}
	nuevo, exp, _ := repository.SignURLTicket(&web, repository.URLScopeMedia, time.Now())
	c, err := repository.ValidateURLTicket(nuevo, repository.URLScopeMedia)
	if err != nil || c.UserID != "u-ana" || !c.Web || len(c.Orgs) != 1 {
		t.Errorf("el pase no lleva a quien lo pidió: %+v %v", c, err)
	}
	if d := time.Until(exp); d > repository.URLTicketTTL || d < repository.URLTicketTTL-time.Minute {
		t.Errorf("caduca en %v", d)
	}
}

// Pedir un pase: con sesión, un alcance conocido, y no con un token personal.
// Mutantes: aceptar cualquier alcance; dárselo a un token personal.
func TestAskingForATicket(t *testing.T) {
	t.Setenv("JWT_SECRET_ACCESS", "a-test")
	h := &authHandler{}
	pedir := func(scope string, c *domain.ClaimsJWT) int {
		r := serverReq(http.MethodPost, "", "", "", c)
		r.URL.RawQuery = "scope=" + scope
		rec := httptest.NewRecorder()
		h.URLTicket(rec, r)
		return rec.Code
	}
	if code := pedir("media", ticketOwner); code != http.StatusOK {
		t.Errorf("pedir uno de adjuntos → %d", code)
	}
	if code := pedir("todo", ticketOwner); code != http.StatusBadRequest {
		t.Errorf("un alcance inventado → %d, se esperaba 400", code)
	}
	pat := *ticketOwner
	pat.ViaToken = true
	if code := pedir("media", &pat); code != http.StatusForbidden {
		t.Errorf("un token personal → %d, se esperaba 403", code)
	}
}
