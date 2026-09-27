package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una petición con token personal sale del middleware marcada como tal (#84).
//
// Es la mitad que sostiene que un token no firme revisiones: la regla del
// dominio mira `ViaToken`, y esto es lo que lo pone. Se marca aquí y no donde se
// arman los claims porque esta rama es la única que sabe con certeza cómo llegó
// la petición.
//
// El mutante que mata: quitar `claims.ViaToken = true` de AuthMiddleware.
func TestAPersonalTokenIsMarkedAsOne(t *testing.T) {
	antes := patAuth
	defer func() { patAuth = antes }()
	// Un superadmin, que es justo el caso que se colaba: sus claims dicen
	// Superadmin y nada más distinguía que viniera con token.
	UsePATAuthenticator(func(string) (*domain.ClaimsJWT, error) {
		return &domain.ClaimsJWT{UserID: "u1", Superadmin: true}, nil
	})

	var vio *domain.ClaimsJWT
	h := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		vio, _ = r.Context().Value(repository.UserContextKey).(*domain.ClaimsJWT)
	}))

	// Un GET, que no necesita scope: así lo único que se prueba es la marca.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/docs/list/x", nil)
	req.Header.Set("Authorization", "Bearer "+repository.PATPrefix+"cualquiera")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if vio == nil {
		t.Fatal("el handler no recibió claims")
	}
	if !vio.ViaToken {
		t.Error("una petición con token personal salió sin la marca: firmaría como una persona")
	}
}
