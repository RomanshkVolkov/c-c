package handler

import (
	"reflect"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Buscar sin org mira las orgs de las que el token es miembro, y ninguna más:
// tampoco siendo superadmin, que vería las de todo el servidor. Lo que sale va
// al contexto de un agente por el MCP.
func TestSearchingWithoutAnOrgOnlyLooksAtYourMemberships(t *testing.T) {
	user := &domain.ClaimsJWT{
		Superadmin: true,
		Orgs: []domain.OrgMembershipClaim{
			{OrgID: "org-1", Role: domain.OrgRoleAdmin},
			{OrgID: "org-3", Role: domain.OrgRoleViewer},
			{OrgID: ""},
		},
	}
	if got := MemberOrgs(user); !reflect.DeepEqual(got, []string{"org-1", "org-3"}) {
		t.Errorf("MemberOrgs = %v, se esperaban sólo las membresías", got)
	}
	if got := MemberOrgs(&domain.ClaimsJWT{Superadmin: true}); len(got) != 0 {
		t.Errorf("un superadmin sin membresías buscaría en %v", got)
	}
}
