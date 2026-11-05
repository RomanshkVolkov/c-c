package handler

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Ver y atar una instalación sin org es de un superadmin con su sesión: con
// un token suyo (la marca que pone la rama PAT de AuthMiddleware) no, porque
// ese token lo puede llevar un agente.
func TestOnlyASuperadminInPersonSeesOrphans(t *testing.T) {
	as := func(c *domain.ClaimsJWT) bool {
		r := httptest.NewRequest("GET", "/", nil)
		if c != nil {
			r = r.WithContext(context.WithValue(r.Context(), repository.UserContextKey, c))
		}
		return inPersonSuperadmin(r)
	}
	if !as(&domain.ClaimsJWT{Superadmin: true}) {
		t.Error("el superadmin con su sesión no cuenta")
	}
	if as(&domain.ClaimsJWT{Superadmin: true, ViaToken: true}) {
		t.Error("un token del superadmin cuenta como él en persona")
	}
	if as(&domain.ClaimsJWT{}) || as(nil) {
		t.Error("alguien que no es superadmin cuenta")
	}
}
