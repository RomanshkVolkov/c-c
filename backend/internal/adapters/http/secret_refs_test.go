package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Los secrets de un servicio por referencia a 1Password (R8), por las rutas.

1Password es la fuente de verdad y cac sólo sabe **dónde** está cada valor. Lo
que se fija aquí es que eso no se pueda romper sin que se note: ningún tipo
tiene dónde guardar un valor, una petición que trae uno se rechaza en vez de
descartarse en silencio, y rotar sólo vale en un servicio que despliega cac.
*/

// Ningún tipo de esta parte tiene un campo que pueda llevar un valor.
func TestNoSecretTypeCarriesAValue(t *testing.T) {
	forbidden := []string{"value", "secret", "password", "token", "plain"}
	for _, v := range []any{
		domain.DeployableSecretRef{}, domain.SecretRotation{}, domain.SecretRefInput{},
		domain.PutSecretRefsRequest{}, domain.RecordRotationRequest{}, domain.SecretRotationResponse{},
	} {
		checkFields(t, reflect.TypeOf(v), forbidden)
	}
}

// checkFields mira cada campo, y entra en los embebidos: su nombre es el del
// tipo, no un campo.
func checkFields(t *testing.T, typ reflect.Type, forbidden []string) {
	t.Helper()
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.Anonymous && f.Type.Kind() == reflect.Struct {
			checkFields(t, f.Type, forbidden)
			continue
		}
		name := strings.ToLower(f.Name + " " + f.Tag.Get("json"))
		for _, bad := range forbidden {
			if strings.Contains(name, bad) {
				t.Errorf("%s.%s puede llevar un valor (%q)", typ.Name(), f.Name, bad)
			}
		}
	}
}

type secretsFixture struct {
	db *gorm.DB
	r  *chi.Mux
	d  *domain.Deployable
}

func secretsSetup(t *testing.T, mode string) (*secretsFixture, func()) {
	t.Helper()
	f, cleanup := ingestSetup(t, mode)
	if err := f.db.AutoMigrate(&domain.User{}, &domain.DeployableSecretRef{}, &domain.SecretRotation{}); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	InitServerRoutes(f.db, r, events.NewHub())
	return &secretsFixture{db: f.db, r: r, d: f.a}, cleanup
}

func (f *secretsFixture) call(t *testing.T, method, path, body string, role domain.OrgRole, org string) *httptest.ResponseRecorder {
	t.Helper()
	pair, err := repository.GenerateTokens("u-1", "ana", false, []domain.OrgMembershipClaim{{OrgID: org, Role: role}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, "/api/v1/servers/srv-1/deployables/"+f.d.ID+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.r.ServeHTTP(rec, req)
	return rec
}

const goodRefs = `{"refs":[{"name":"DATABASE_URL","opRef":"op://dwit/Web RRHH/DATABASE_URL"},{"name":"AUTH_SECRET","opRef":"op://dwit/Web RRHH/AUTH_SECRET"}]}`

// Una petición con un valor dentro se rechaza entera, y el valor no queda en
// ningún sitio de la base.
func TestASecretRefsBodyWithAValueIsRejected(t *testing.T) {
	f, cleanup := secretsSetup(t, "deploy")
	defer cleanup()
	rec := f.call(t, http.MethodPut, "/secret-refs",
		`{"refs":[{"name":"DATABASE_URL","opRef":"op://dwit/x/y","value":"postgres://s3cr3t"}]}`, domain.OrgRoleAdmin, "org-1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("un cuerpo con value → %d, se esperaba 400", rec.Code)
	}
	var n int64
	f.db.Model(&domain.DeployableSecretRef{}).Count(&n)
	if n != 0 {
		t.Errorf("se guardaron %d referencias de una petición rechazada", n)
	}
	rec = f.call(t, http.MethodPost, "/secret-rotations",
		`{"names":["X"],"status":"succeeded","values":{"X":"s3cr3t"}}`, domain.OrgRoleAdmin, "org-1")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("una rotación con values → %d, se esperaba 400", rec.Code)
	}
}

// Ver, cualquiera de la org; cambiar de dónde salen, un admin; de otra org,
// nada.
func TestWhoMayManageSecretRefs(t *testing.T) {
	f, cleanup := secretsSetup(t, "deploy")
	defer cleanup()
	if rec := f.call(t, http.MethodPut, "/secret-refs", goodRefs, domain.OrgRoleMember, "org-1"); rec.Code != http.StatusForbidden {
		t.Errorf("un miembro cambiando las referencias → %d, se esperaba 403", rec.Code)
	}
	if rec := f.call(t, http.MethodPut, "/secret-refs", goodRefs, domain.OrgRoleAdmin, "org-2"); rec.Code != http.StatusNotFound {
		t.Errorf("un admin de otra org → %d, se esperaba 404", rec.Code)
	}
	if rec := f.call(t, http.MethodPut, "/secret-refs", goodRefs, domain.OrgRoleAdmin, "org-1"); rec.Code != http.StatusOK {
		t.Fatalf("un admin → %d: %s", rec.Code, rec.Body.String())
	}
	rec := f.call(t, http.MethodGet, "/secret-refs", "", domain.OrgRoleViewer, "org-1")
	var res struct {
		Data []domain.DeployableSecretRef `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if rec.Code != http.StatusOK || len(res.Data) != 2 || res.Data[0].Name != "AUTH_SECRET" {
		t.Errorf("un viewer leyendo → %d %+v", rec.Code, res.Data)
	}
	// Reemplazar es reemplazar: lo que no viene se quita.
	f.call(t, http.MethodPut, "/secret-refs", `{"refs":[{"name":"AUTH_SECRET","opRef":"op://dwit/x/y"}]}`, domain.OrgRoleAdmin, "org-1")
	var n int64
	f.db.Model(&domain.DeployableSecretRef{}).Count(&n)
	if n != 1 {
		t.Errorf("tras reemplazar quedan %d, se esperaba 1", n)
	}
}

func TestSecretRefsAreValidated(t *testing.T) {
	f, cleanup := secretsSetup(t, "deploy")
	defer cleanup()
	for name, body := range map[string]string{
		"minúsculas":       `{"refs":[{"name":"database_url","opRef":"op://a/b/c"}]}`,
		"con espacio":      `{"refs":[{"name":"A B","opRef":"op://a/b/c"}]}`,
		"no es op":         `{"refs":[{"name":"A","opRef":"https://a/b/c"}]}`,
		"op sin campo":     `{"refs":[{"name":"A","opRef":"op://a/b"}]}`,
		"repetido":         `{"refs":[{"name":"A","opRef":"op://a/b/c"},{"name":"A","opRef":"op://a/b/d"}]}`,
		"nombre muy largo": `{"refs":[{"name":"` + strings.Repeat("A", 41) + `","opRef":"op://a/b/c"}]}`,
	} {
		if rec := f.call(t, http.MethodPut, "/secret-refs", body, domain.OrgRoleAdmin, "org-1"); rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, se esperaba 400", name, rec.Code)
		}
	}
}

// Con el CI desplegando, su próximo stack deploy tiraría los secrets de cac:
// rotar sólo se apunta en un servicio que despliega cac. Y lo que se apunta
// son nombres de cac, no cualquier cosa.
func TestARotationIsRecordedOnlyWhenCacDeploys(t *testing.T) {
	rot := `{"names":["DATABASE_URL"],"versions":{"DATABASE_URL":"cac_DATABASE_URL_0123456789abcdef"},"status":"succeeded"}`
	f, cleanup := secretsSetup(t, "record")
	if rec := f.call(t, http.MethodPost, "/secret-rotations", rot, domain.OrgRoleMember, "org-1"); rec.Code != http.StatusConflict {
		t.Errorf("rotar con el CI desplegando → %d, se esperaba 409", rec.Code)
	}
	cleanup()

	f, cleanup = secretsSetup(t, "deploy")
	defer cleanup()
	if rec := f.call(t, http.MethodPost, "/secret-rotations", rot, domain.OrgRoleViewer, "org-1"); rec.Code != http.StatusForbidden {
		t.Errorf("un viewer apuntando una rotación → %d, se esperaba 403", rec.Code)
	}
	bad := strings.Replace(rot, "cac_DATABASE_URL_0123456789abcdef", "rrhh_prod_DATABASE_URL", 1)
	if rec := f.call(t, http.MethodPost, "/secret-rotations", bad, domain.OrgRoleMember, "org-1"); rec.Code != http.StatusBadRequest {
		t.Errorf("una versión que no es de cac → %d, se esperaba 400", rec.Code)
	}
	if rec := f.call(t, http.MethodPost, "/secret-rotations", rot, domain.OrgRoleMember, "org-1"); rec.Code != http.StatusCreated {
		t.Fatalf("un miembro rotando → %d: %s", rec.Code, rec.Body.String())
	}
	rec := f.call(t, http.MethodGet, "/secret-rotations", "", domain.OrgRoleViewer, "org-1")
	if !strings.Contains(rec.Body.String(), "cac_DATABASE_URL_0123456789abcdef") {
		t.Errorf("la rotación no aparece: %s", rec.Body.String())
	}
}

var _ = service.ErrRotationNeedsDeploy
