package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
La config de un servidor y las plantillas, por las rutas (31-oct-2026).

Lo que se fija: guardar es de admin y leer de cualquiera de la org; cada
guardado es una versión nueva y la numeración no se pisa con dos a la vez; un
secreto no entra como valor ni por un campo desconocido; basar un servidor en
otro copia sus referencias menos las de cada máquina, y nunca de otra org; y una
ejecución guarda la foto de lo aplicado, que no cambia aunque la config cambie
después.
*/

func configHandler(db *gorm.DB) (*ServerConfigHandler, *ProvisioningHandler) {
	servers := service.NewServerService(repository.NewServerRepository(db))
	cfg := service.NewServerConfigService(repository.NewServerConfigRepository(db), repository.NewServerRepository(db))
	prov := NewProvisioningHandler(servers,
		service.NewProvisioningService(repository.NewProvisioningRepository(db)).WithConfigs(cfg))
	return NewServerConfigHandler(servers, cfg), prov
}

type apiResp[T any] struct {
	Data  T      `json:"data"`
	Error string `json:"error"`
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out apiResp[T]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, rec.Body.String())
	}
	return out.Data
}

// createTemplate: una plantilla de org-1, como admin.
func createTemplate(t *testing.T, h *ServerConfigHandler, body string) domain.ServerTemplateResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	h.CreateTemplate(rec, serverReq(http.MethodPost, "org-1", "", body, claims("u-ana", "org-1", domain.OrgRoleAdmin)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("crear la plantilla → %d: %s", rec.Code, rec.Body.String())
	}
	return decode[domain.ServerTemplateResponse](t, rec)
}

const swarmTemplate = `{"name":"Swarm + Traefik","playbooks":["baseline","swarm"],
	"vars":{"traefik_image":"traefik:v3.6","acme_email":"ops@x.dev"},
	"requires":["OPS_PASSWORD","CLOUDFLARE_DNS_TOKEN","GHCR_LOGIN"],"perServer":["OPS_PASSWORD"]}`

func saveConfig(h *ServerConfigHandler, serverID, body string, c *domain.ClaimsJWT) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.Save(rec, serverReq(http.MethodPut, serverID, "", body, c))
	return rec
}

// Guardar la config de un servidor es de admin, como su conexión: decide qué
// se monta y de dónde salen sus credenciales. Leerla, de cualquiera de la org;
// a otra org, 404. Mutantes: bajar Save a miembro; subir Config a admin.
func TestOnlyAnAdminSavesAServerConfig(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	body := `{"vars":{"base_domain":"gstd.guz-studio.dev"}}`

	if rec := saveConfig(h, "srv-1", body, claims("u-ana", "org-1", domain.OrgRoleMember)); rec.Code != http.StatusForbidden {
		t.Errorf("un miembro guardando → %d, se esperaba 403", rec.Code)
	}
	if rec := saveConfig(h, "srv-1", body, claims("u-ajena", "org-2", domain.OrgRoleAdmin)); rec.Code != http.StatusNotFound {
		t.Errorf("un admin de otra org → %d, se esperaba 404", rec.Code)
	}
	if rec := saveConfig(h, "srv-1", body, claims("u-ana", "org-1", domain.OrgRoleAdmin)); rec.Code != http.StatusCreated {
		t.Fatalf("un admin → %d: %s", rec.Code, rec.Body.String())
	}
	rec := httptest.NewRecorder()
	h.Config(rec, serverReq(http.MethodGet, "srv-1", "", "", claims("u-vera", "org-1", domain.OrgRoleViewer)))
	if rec.Code != http.StatusOK {
		t.Fatalf("un viewer leyendo → %d", rec.Code)
	}
	if got := decode[domain.ServerConfigSummary](t, rec); got.Current == nil || got.Current.Seq != 1 || got.Current.CreatedByName != "Ana López" {
		t.Errorf("la actual no es la 1 de Ana: %+v", got.Current)
	}
}

// Una plantilla también es de admin. Mutante: CreateTemplate o SaveTemplate a
// miembro.
func TestOnlyAnAdminSavesAServerTemplate(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	rec := httptest.NewRecorder()
	h.CreateTemplate(rec, serverReq(http.MethodPost, "org-1", "", swarmTemplate, claims("u-ana", "org-1", domain.OrgRoleMember)))
	if rec.Code != http.StatusForbidden {
		t.Errorf("un miembro creando una plantilla → %d, se esperaba 403", rec.Code)
	}
	tpl := createTemplate(t, h, swarmTemplate)
	r := serverReq(http.MethodPut, "org-1", "", `{"playbooks":["baseline"]}`, claims("u-ana", "org-1", domain.OrgRoleMember))
	chiContext(r).URLParams.Add("tplId", tpl.ID)
	rec = httptest.NewRecorder()
	h.SaveTemplate(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Errorf("un miembro guardando una versión → %d, se esperaba 403", rec.Code)
	}
	r = serverReq(http.MethodGet, "org-2", "", "", claims("u-ajena", "org-2", domain.OrgRoleAdmin))
	chiContext(r).URLParams.Add("tplId", tpl.ID)
	rec = httptest.NewRecorder()
	h.Template(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("la plantilla de org-1 pedida desde org-2 → %d, se esperaba 404", rec.Code)
	}
}

// Un secreto no se guarda: ni pegado en una referencia, ni como variable, ni
// por un campo que el tipo no conoce. Mutantes: quitar ValidateOpRefs o
// ValidateConfigVars de Save; volver a ValidateRequest (no estricto).
func TestAServerConfigNeverStoresASecret(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	tpl := createTemplate(t, h, swarmTemplate)
	admin := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	for _, c := range []struct{ nombre, body, code string }{
		{"el valor en una referencia", `{"opRefs":{"OPS_PASSWORD":"hunter2"}}`, "bad-op-ref"},
		// Sin sufijo que lo delate: lo atrapa que la plantilla lo pide.
		{"un secreto de la plantilla como variable", `{"templateId":"` + tpl.ID + `","vars":{"ghcr_login":"abc"}}`, "secret-in-vars"},
		{"una referencia como variable", `{"vars":{"dns":"op://Employee/cf/credential"}}`, "secret-in-vars"},
		{"un campo que no existe", `{"secrets":{"OPS_PASSWORD":"hunter2"}}`, "invalid-body"},
	} {
		rec := saveConfig(h, "srv-1", c.body, admin)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, se esperaba 400", c.nombre, rec.Code)
		}
		var res apiResp[any]
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if res.Error != c.code {
			t.Errorf("%s → %q, se esperaba %q", c.nombre, res.Error, c.code)
		}
	}
	var n int64
	db.Model(&domain.ServerConfigVersion{}).Count(&n)
	if n != 0 {
		t.Errorf("se guardaron %d versiones con un secreto dentro", n)
	}
}

// Cada guardado es una versión, y dos a la vez no se pisan el número.
// Mutante: quitar el bloqueo de la fila del servidor (salen dos con el mismo
// número y el índice único tira una).
func TestEverySaveIsANewVersionEvenAtTheSameTime(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	admin := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	var wg sync.WaitGroup
	codes := make([]int, 6)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = saveConfig(h, "srv-1", `{"vars":{"n":1}}`, admin).Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusCreated {
			t.Errorf("guardado %d → %d", i, c)
		}
	}
	var seqs []int
	db.Model(&domain.ServerConfigVersion{}).Where("server_id = ?", "srv-1").Order("seq").Pluck("seq", &seqs)
	for i, s := range seqs {
		if s != i+1 {
			t.Fatalf("la numeración tiene huecos o repetidos: %v", seqs)
		}
	}
	if len(seqs) != len(codes) {
		t.Errorf("%d versiones para %d guardados", len(seqs), len(codes))
	}
}

// La efectiva es la plantilla con lo del servidor encima, y dice qué secretos
// faltan. Mutante: MergeVars al revés (la plantilla pisa al servidor).
func TestTheEffectiveConfigIsTheTemplateUnderTheServer(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	tpl := createTemplate(t, h, swarmTemplate)
	admin := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	rec := saveConfig(h, "srv-1", `{"templateId":"`+tpl.ID+`","vars":{"acme_email":"jose@x.dev","base_domain":"gstd.guz-studio.dev"},
		"opRefs":{"OPS_PASSWORD":"op://Employee/gstd infra_devops/password"}}`, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("guardar → %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.Effective(rec, serverReq(http.MethodGet, "srv-1", "", "", claims("u-vera", "org-1", domain.OrgRoleViewer)))
	eff := decode[domain.EffectiveConfig](t, rec)
	if eff.Vars["acme_email"] != "jose@x.dev" || eff.Vars["traefik_image"] != "traefik:v3.6" {
		t.Errorf("la combinación no es plantilla ⊕ servidor: %v", eff.Vars)
	}
	if len(eff.Missing) != 2 || eff.Missing[0] != "CLOUDFLARE_DNS_TOKEN" || eff.Missing[1] != "GHCR_LOGIN" {
		t.Errorf("faltan %v, se esperaba [CLOUDFLARE_DNS_TOKEN GHCR_LOGIN]", eff.Missing)
	}
	if eff.TemplateName != "Swarm + Traefik" || len(eff.Playbooks) != 2 || eff.Connection.Host != "10.0.0.1" {
		t.Errorf("efectiva incompleta: %+v", eff)
	}
}

// Basar un servidor en otro copia su config menos los secretos de cada
// máquina, y dice de dónde salió. De otra org, nunca. Mutantes: copiar también
// los perServer; no mirar la org del origen.
func TestBasingAServerOnAnotherCopiesAllButItsOwnSecrets(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, _ := configHandler(db)
	tpl := createTemplate(t, h, swarmTemplate)
	admin := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	rec := saveConfig(h, "srv-1", `{"templateId":"`+tpl.ID+`","vars":{"base_domain":"gstd.guz-studio.dev","ssh_port":7337},
		"opRefs":{"OPS_PASSWORD":"op://Employee/gstd infra_devops/password","CLOUDFLARE_DNS_TOKEN":"op://Employee/cf/credential"}}`, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("guardar el origen → %d: %s", rec.Code, rec.Body.String())
	}
	rec = saveConfig(h, "srv-2", `{"basedOnServerId":"srv-1","vars":{"base_domain":"dev.guz-studio.dev"}}`, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("basar srv-2 en srv-1 → %d: %s", rec.Code, rec.Body.String())
	}
	v := decode[domain.ServerConfigVersion](t, rec)
	if v.TemplateID != tpl.ID || v.Vars["base_domain"] != "dev.guz-studio.dev" || v.Vars["ssh_port"] != float64(7337) {
		t.Errorf("no se copió la plantilla o las variables: %+v", v)
	}
	if _, ok := v.OpRefs["OPS_PASSWORD"]; ok {
		t.Error("se copió la contraseña de sudo de otra máquina (perServer)")
	}
	if v.OpRefs["CLOUDFLARE_DNS_TOKEN"] != "op://Employee/cf/credential" {
		t.Errorf("no se copió la referencia compartida: %v", v.OpRefs)
	}
	if v.BasedOn == nil || v.BasedOn.ServerID != "srv-1" || v.BasedOn.Seq != 1 {
		t.Errorf("no dice de dónde salió: %+v", v.BasedOn)
	}

	// Un servidor de otra org no se puede copiar, aunque tenga config.
	ahora := "2026-10-31T00:00:00Z"
	db.Exec(`INSERT INTO servers (id, org_id, name, host, ssh_port, ssh_user, type, agent_port, status, created_at, updated_at)
		VALUES ('srv-ajeno','org-2','ajeno','10.9.9.9',22,'root','docker-swarm',9090,'pending',?,?)`, ahora, ahora)
	if rec := saveConfig(h, "srv-ajeno", `{"vars":{"x":1}}`, claims("u-ajena", "org-2", domain.OrgRoleAdmin)); rec.Code != http.StatusCreated {
		t.Fatalf("config del ajeno → %d", rec.Code)
	}
	if rec := saveConfig(h, "srv-2", `{"basedOnServerId":"srv-ajeno"}`, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("basarse en un servidor de otra org → %d, se esperaba 400", rec.Code)
	}
}

// Una ejecución lanzada con una versión guarda la foto de lo aplicado, sacada
// del backend, y no cambia aunque la config cambie después. Mutante: no
// rellenar Applied en Start.
func TestARunKeepsWhatWasAppliedEvenAfterTheConfigChanges(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h, prov := configHandler(db)
	tpl := createTemplate(t, h, swarmTemplate)
	admin := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	save := func(body string) {
		t.Helper()
		if rec := saveConfig(h, "srv-1", body, admin); rec.Code != http.StatusCreated {
			t.Fatalf("guardar → %d: %s", rec.Code, rec.Body.String())
		}
	}
	save(`{"templateId":"` + tpl.ID + `","vars":{"base_domain":"a.dev"},"opRefs":{"OPS_PASSWORD":"op://Employee/gstd/password"}}`)
	save(`{"templateId":"` + tpl.ID + `","vars":{"base_domain":"b.dev"}}`)
	// Se lanza con la 1 aunque la actual sea la 2: la foto es la de la 1.
	rec := httptest.NewRecorder()
	prov.Start(rec, serverReq(http.MethodPost, "srv-1", "",
		`{"kind":"playbook","playbook":"swarm","varNames":["base_domain"],"configSeq":1}`, claims("u-ana", "org-1", domain.OrgRoleMember)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("abrir la ejecución → %d: %s", rec.Code, rec.Body.String())
	}
	runID := decode[domain.ProvisioningRun](t, rec).ID
	// Y cambiar la config después no la toca.
	save(`{"templateId":"` + tpl.ID + `","vars":{"base_domain":"c.dev"}}`)

	var run domain.ProvisioningRun
	if err := db.First(&run, "id = ?", runID).Error; err != nil {
		t.Fatal(err)
	}
	if run.ConfigSeq != 1 || run.TemplateID != tpl.ID || run.TemplateSeq != 1 || run.Applied == nil {
		t.Fatalf("la ejecución no dice con qué se lanzó: %+v", run)
	}
	if run.Applied.Vars["base_domain"] != "a.dev" || run.Applied.Vars["traefik_image"] != "traefik:v3.6" {
		t.Errorf("lo aplicado no es la versión 1 combinada: %v", run.Applied.Vars)
	}
	if run.Applied.OpRefs["OPS_PASSWORD"] != "op://Employee/gstd/password" {
		t.Errorf("lo aplicado no lleva la referencia: %v", run.Applied.OpRefs)
	}

	// Y la lista la devuelve igual (el Scan de la lista pasa por el serializador).
	rec = httptest.NewRecorder()
	prov.List(rec, serverReq(http.MethodGet, "srv-1", "", "", claims("u-vera", "org-1", domain.OrgRoleViewer)))
	runs := decode[[]domain.ProvisioningRunResponse](t, rec)
	if len(runs) != 1 || runs[0].Applied == nil || runs[0].Applied.Vars["base_domain"] != "a.dev" {
		t.Errorf("la lista no trae lo aplicado: %+v", runs)
	}
}

// Una ejecución dice por dónde entró: la app, o una terminal con `cac
// provision` y un token. Mutante: no mirar ViaToken al abrirla.
func TestARunSaysWhetherItCameFromATerminal(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	_, prov := configHandler(db)
	open := func(c *domain.ClaimsJWT) domain.ProvisioningRun {
		t.Helper()
		rec := httptest.NewRecorder()
		prov.Start(rec, serverReq(http.MethodPost, "srv-1", "", `{"kind":"playbook","playbook":"test"}`, c))
		if rec.Code != http.StatusCreated {
			t.Fatalf("abrir → %d: %s", rec.Code, rec.Body.String())
		}
		return decode[domain.ProvisioningRun](t, rec)
	}
	if got := open(claims("u-ana", "org-1", domain.OrgRoleMember)).Source; got != "app" {
		t.Errorf("desde la app quedó %q", got)
	}
	token := claims("u-ana", "org-1", domain.OrgRoleMember)
	token.ViaToken = true
	if got := open(token).Source; got != "cli" {
		t.Errorf("con un token quedó %q, se esperaba cli", got)
	}
}
