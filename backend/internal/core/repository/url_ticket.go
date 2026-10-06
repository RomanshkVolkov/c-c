package repository

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

/*
Pase de URL (barrido de seguridad, 6-oct-2026). Un `<img>` y un `EventSource`
no saben mandar `Authorization`, así que la web llevaba el token de acceso en la
URL, y una URL acaba en los logs del Gateway y de cualquier proxy del camino.
Ahora lleva esto: un pase corto, con un alcance —leer adjuntos (`media`) o
escuchar el stream (`events`)— y firmado con **otra llave**, derivada de la de
acceso. Por eso ValidateAccessToken no lo acepta: un pase que se filtre a un log
no abre la API, sólo lo que dice su alcance y durante URLTicketTTL.
*/

// URLTicketTTL: cuánto vale un pase de URL. La web lo renueva antes.
const URLTicketTTL = 30 * time.Minute

// Los alcances de un pase de URL.
const (
	URLScopeMedia  = "media"
	URLScopeEvents = "events"
)

// ValidURLScope: si es un alcance que se puede pedir.
func ValidURLScope(s string) bool { return s == URLScopeMedia || s == URLScopeEvents }

type urlTicketClaims struct {
	domain.ClaimsJWT
	URLScope string `json:"url_scope"`
}

func urlTicketKey() []byte {
	mac := hmac.New(sha256.New, []byte(GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret")))
	mac.Write([]byte("url-ticket"))
	return mac.Sum(nil)
}

// SignURLTicket firma un pase con la identidad de quien lo pide (sus orgs, si
// es superadmin, si es una sesión web) y un alcance.
func SignURLTicket(c *domain.ClaimsJWT, scope string, now time.Time) (string, time.Time, error) {
	if !ValidURLScope(scope) {
		return "", time.Time{}, errors.New("bad-url-scope")
	}
	exp := now.Add(URLTicketTTL)
	claims := urlTicketClaims{
		ClaimsJWT: domain.ClaimsJWT{
			UserID: c.UserID, Username: c.Username, Superadmin: c.Superadmin, Orgs: c.Orgs, Web: c.Web,
			RegisteredClaims: jwt.RegisteredClaims{
				ExpiresAt: jwt.NewNumericDate(exp), IssuedAt: jwt.NewNumericDate(now), Subject: c.UserID,
			},
		},
		URLScope: scope,
	}
	tok, err := generateToken(claims, urlTicketKey())
	return tok, exp, err
}

// ValidateURLTicket: la identidad del pase, si es válido y es de ese alcance.
func ValidateURLTicket(encoded, scope string) (*domain.ClaimsJWT, error) {
	var claims urlTicketClaims
	token, err := jwt.ParseWithClaims(encoded, &claims, func(t *jwt.Token) (any, error) {
		return urlTicketKey(), nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !token.Valid || claims.URLScope != scope {
		return nil, errors.New("invalid-url-ticket")
	}
	return &claims.ClaimsJWT, nil
}
