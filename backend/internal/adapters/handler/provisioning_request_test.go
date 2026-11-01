package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"gorm.io/gorm"
)

/*
El protocolo de ejecución por agentes, por las rutas (31-oct-2026, decisión
4d28f4ab). Lo que se fija: un token pide y ensaya pero nunca decide ni corre
sin autorización; la autorización casa con lo aprobado, es de un solo uso y
caduca; sólo una lectura limpia se pre-autoriza, y si al correr cambia algo
queda marcada; lo destructivo pide el nombre del servidor y una bandera roja
pide reconocerse; y la verificación cierra la petición.
*/

type protocol struct {
	t    *testing.T
	db   *gorm.DB
	cfg  *ServerConfigHandler
	prov *ProvisioningHandler
}

func newProtocol(t *testing.T) (*protocol, func()) {
	db, cleanup := provisioningDB(t)
	cfg, prov := configHandler(db)
	// La versión 1 de la config de srv-1, que es lo que se pide aplicar.
	if rec := saveConfig(cfg, "srv-1", `{"vars":{"base_domain":"gstd.guz-studio.dev"}}`, claims("u-ana", "org-1", domain.OrgRoleAdmin)); rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("guardar la config → %d: %s", rec.Code, rec.Body.String())
	}
	return &protocol{t: t, db: db, cfg: cfg, prov: prov}, cleanup
}

func agent() *domain.ClaimsJWT {
	c := claims("u-ana", "org-1", domain.OrgRoleAdmin)
	c.ViaToken = true
	return c
}

func person() *domain.ClaimsJWT { return claims("u-ana", "org-1", domain.OrgRoleAdmin) }

func requestReq(method, serverID, rqid, body string, c *domain.ClaimsJWT) *http.Request {
	r := serverReq(method, serverID, "", body, c)
	if rqid != "" {
		chiContext(r).URLParams.Add("rqid", rqid)
	}
	return r
}

func (p *protocol) ask(body string) domain.ProvisioningRequest {
	p.t.Helper()
	rec := httptest.NewRecorder()
	p.prov.CreateRequest(rec, requestReq(http.MethodPost, "srv-1", "", body, agent()))
	if rec.Code != http.StatusCreated {
		p.t.Fatalf("pedir → %d: %s", rec.Code, rec.Body.String())
	}
	return decode[domain.ProvisioningRequest](p.t, rec)
}

func (p *protocol) check(id string, c domain.ProvisioningCheck) *httptest.ResponseRecorder {
	b, _ := json.Marshal(c)
	rec := httptest.NewRecorder()
	p.prov.SubmitCheck(rec, requestReq(http.MethodPut, "srv-1", id, string(b), agent()))
	return rec
}

func (p *protocol) decide(id, body string, c *domain.ClaimsJWT) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	p.prov.Decide(rec, requestReq(http.MethodPost, "srv-1", id, body, c))
	return rec
}

func (p *protocol) start(playbook, requestID string, configSeq int, c *domain.ClaimsJWT) *httptest.ResponseRecorder {
	b, _ := json.Marshal(map[string]any{"kind": "playbook", "playbook": playbook, "configSeq": configSeq, "requestId": requestID})
	rec := httptest.NewRecorder()
	p.prov.Start(rec, serverReq(http.MethodPost, "srv-1", "", string(b), c))
	return rec
}

func (p *protocol) finish(runID, status, summary string) {
	p.t.Helper()
	b, _ := json.Marshal(map[string]any{"status": status, "summary": summary})
	rec := httptest.NewRecorder()
	p.prov.Finish(rec, serverReq(http.MethodPatch, "srv-1", runID, string(b), agent()))
	if rec.Code != http.StatusOK {
		p.t.Fatalf("cerrar → %d: %s", rec.Code, rec.Body.String())
	}
}

func (p *protocol) status(id string) string {
	p.t.Helper()
	rec := httptest.NewRecorder()
	p.prov.GetRequest(rec, requestReq(http.MethodGet, "srv-1", id, "", person()))
	if rec.Code != http.StatusOK {
		p.t.Fatalf("leer → %d: %s", rec.Code, rec.Body.String())
	}
	return decode[domain.ProvisioningRequestResponse](p.t, rec).Status
}

func expect(t *testing.T, rec *httptest.ResponseRecorder, code int, errCode, what string) {
	t.Helper()
	if rec.Code != code || (errCode != "" && !strings.Contains(rec.Body.String(), errCode)) {
		t.Errorf("%s → %d: %s (quería %d %s)", what, rec.Code, rec.Body.String(), code, errCode)
	}
}

const swarmAsk = `{"playbook":"swarm","risk":"change","verify":"swarm-verify","rollback":"swarm-teardown","configSeq":1,"reason":"levantar Traefik"}`

func cleanDryRun() domain.ProvisioningCheck {
	return domain.ProvisioningCheck{Hosts: []string{"tds"}, Ok: 20, Changed: 4, ChangedTasks: []string{"Instalar Traefik"}}
}

// El camino entero de un `change`: el agente pide y ensaya; un ensayo limpio
// no basta, espera a una persona; el agente no puede ni decidir ni correr
// antes; la autorización casa con lo aprobado y se gasta una vez; y la
// verificación cierra la petición.
func TestAnAgentAsksAndOnlyAPersonApproves(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()

	req := p.ask(swarmAsk)
	if req.Status != domain.ProvisioningRequestChecking || req.Source != "mcp" {
		t.Fatalf("recién pedida: %s, %s", req.Status, req.Source)
	}
	// Sin ensayo no hay nada que decidir.
	expect(t, p.decide(req.ID, `{"approve":true}`, person()), http.StatusConflict, "provisioning-request-state", "decidir sin ensayo")

	rec := p.check(req.ID, cleanDryRun())
	expect(t, rec, http.StatusOK, "", "ensayar")
	if got := decode[domain.ProvisioningRequestResponse](t, rec); got.Status != domain.ProvisioningRequestAwaiting || got.AutoApproved {
		t.Fatalf("un change con ensayo limpio quedó %s (auto=%v): un change nunca se pre-autoriza", got.Status, got.AutoApproved)
	}
	expect(t, p.check(req.ID, cleanDryRun()), http.StatusConflict, "provisioning-request-state", "ensayar dos veces")

	// El agente no decide, ni con un token de admin.
	expect(t, p.decide(req.ID, `{"approve":true}`, agent()), http.StatusForbidden, "in-person-only", "aprobar con un token")
	// Ni corre sin petición, ni con una sin aprobar.
	expect(t, p.start("swarm", "", 1, agent()), http.StatusForbidden, "grant-required", "correr sin petición")
	expect(t, p.start("swarm", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "correr sin aprobar")
	// Un miembro no aprueba: es de admin.
	expect(t, p.decide(req.ID, `{"approve":true}`, claims("u-ana", "org-1", domain.OrgRoleMember)), http.StatusForbidden, "", "aprobar como miembro")

	expect(t, p.decide(req.ID, `{"approve":true,"note":"simulacro"}`, person()), http.StatusOK, "", "aprobar en persona")
	expect(t, p.decide(req.ID, `{"approve":true}`, person()), http.StatusConflict, "", "aprobar dos veces")

	// La autorización es de este playbook y esta versión.
	expect(t, p.start("k8s", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "otro playbook")
	// Una versión nueva de la config después de aprobar no viaja con la
	// autorización: lo aprobado es la 1.
	saveConfig(p.cfg, "srv-1", `{"vars":{"base_domain":"otro.dev"}}`, person())
	expect(t, p.start("swarm", req.ID, 2, agent()), http.StatusConflict, "grant-mismatch", "otra versión de la config")

	rec = p.start("swarm", req.ID, 1, agent())
	expect(t, rec, http.StatusCreated, "", "correr con la autorización")
	run := decode[domain.ProvisioningRun](t, rec)
	if run.RequestID != req.ID || run.Source != "cli" || run.Applied == nil {
		t.Errorf("la ejecución: request=%q source=%q applied=%v", run.RequestID, run.Source, run.Applied)
	}
	expect(t, p.start("swarm", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "gastar la autorización dos veces")
	if got := p.status(req.ID); got != domain.ProvisioningRequestRunning {
		t.Fatalf("corriendo: %s", got)
	}

	// Paso 5: sale bien → toca verificar, con su verify y nada más.
	p.finish(run.ID, domain.ProvisioningSucceeded, "tds : ok=20 changed=4 unreachable=0 failed=0")
	if got := p.status(req.ID); got != domain.ProvisioningRequestVerifying {
		t.Fatalf("tras correr: %s", got)
	}
	expect(t, p.start("swarm", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "volver a correr el playbook en la verificación")
	rec = p.start("swarm-verify", req.ID, 1, agent())
	expect(t, rec, http.StatusCreated, "", "verificar")
	expect(t, p.start("swarm-verify", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "verificar dos veces")
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningSucceeded, "tds : ok=5 changed=0")
	if got := p.status(req.ID); got != domain.ProvisioningRequestSucceeded {
		t.Fatalf("verificada: %s", got)
	}
}

// Una verificación que falla no se da por buena, y el rollback no corre solo:
// la petición queda en verify_failed y nada más.
func TestAFailedVerifyIsSaidAndNothingRollsBack(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()
	req := p.ask(swarmAsk)
	p.check(req.ID, cleanDryRun())
	p.decide(req.ID, `{"approve":true}`, person())
	rec := p.start("swarm", req.ID, 1, agent())
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningSucceeded, "tds : ok=20 changed=4")
	rec = p.start("swarm-verify", req.ID, 1, agent())
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningFailed, "tds : ok=2 changed=0 failed=1")
	if got := p.status(req.ID); got != domain.ProvisioningRequestVerifyFailed {
		t.Fatalf("verificación fallida: %s", got)
	}
	expect(t, p.start("swarm-teardown", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "correr el rollback con la autorización del playbook")

	// Y un playbook que falla no pasa a verificar.
	req = p.ask(swarmAsk)
	p.check(req.ID, cleanDryRun())
	p.decide(req.ID, `{"approve":true}`, person())
	rec = p.start("swarm", req.ID, 1, agent())
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningFailed, "tds : ok=3 changed=1 failed=1")
	if got := p.status(req.ID); got != domain.ProvisioningRequestFailed {
		t.Fatalf("playbook fallido: %s", got)
	}
}

// Sólo lo de lectura va directo, y sólo con un ensayo que no cambiaría nada.
// Si al correr cambia algo igualmente, la petición queda marcada.
func TestAReadIsPreAuthorizedOnlyWhenItChangesNothing(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()
	const readAsk = `{"playbook":"test","risk":"read","configSeq":1}`

	req := p.ask(readAsk)
	rec := p.check(req.ID, domain.ProvisioningCheck{Hosts: []string{"tds"}, Ok: 3})
	got := decode[domain.ProvisioningRequestResponse](t, rec)
	if got.Status != domain.ProvisioningRequestApproved || !got.AutoApproved || got.GrantExpiresAt == nil {
		t.Fatalf("una lectura limpia: %s auto=%v", got.Status, got.AutoApproved)
	}
	rec = p.start("test", req.ID, 1, agent())
	expect(t, rec, http.StatusCreated, "", "correr la lectura")
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningSucceeded, "tds : ok=3 changed=1 unreachable=0")
	if st := p.status(req.ID); st != domain.ProvisioningRequestViolated {
		t.Errorf("una lectura que cambió algo quedó %s", st)
	}

	// Una lectura limpia que corre limpia queda bien.
	req = p.ask(readAsk)
	p.check(req.ID, domain.ProvisioningCheck{Hosts: []string{"tds"}, Ok: 3})
	rec = p.start("test", req.ID, 1, agent())
	p.finish(decode[domain.ProvisioningRun](t, rec).ID, domain.ProvisioningSucceeded, "tds : ok=3 changed=0 unreachable=0")
	if st := p.status(req.ID); st != domain.ProvisioningRequestSucceeded {
		t.Errorf("una lectura limpia quedó %s", st)
	}

	// Una «lectura» cuyo ensayo cambiaría algo espera a una persona.
	req = p.ask(readAsk)
	got = decode[domain.ProvisioningRequestResponse](t, p.check(req.ID, domain.ProvisioningCheck{Hosts: []string{"tds"}, Changed: 2}))
	if got.Status != domain.ProvisioningRequestAwaiting || got.AutoApproved {
		t.Errorf("una lectura que cambiaría algo: %s auto=%v", got.Status, got.AutoApproved)
	}
	expect(t, p.start("test", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "correrla sin aprobar")
}

// Una autorización caduca: pasada su hora no corre, y se lee como caducada.
func TestAGrantExpires(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()
	req := p.ask(swarmAsk)
	p.check(req.ID, cleanDryRun())
	p.decide(req.ID, `{"approve":true}`, person())
	if err := p.db.Exec(`UPDATE provisioning_requests SET grant_expires_at = now() - interval '1 second' WHERE id = ?`, req.ID).Error; err != nil {
		t.Fatal(err)
	}
	expect(t, p.start("swarm", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "correr con la autorización caducada")
	if got := p.status(req.ID); got != domain.ProvisioningRequestExpired {
		t.Errorf("caducada se lee %s", got)
	}

	// Y una sin decidir de hace un día ya no se decide.
	req = p.ask(swarmAsk)
	p.check(req.ID, cleanDryRun())
	p.db.Exec(`UPDATE provisioning_requests SET created_at = now() - interval '25 hours' WHERE id = ?`, req.ID)
	expect(t, p.decide(req.ID, `{"approve":true}`, person()), http.StatusConflict, "provisioning-request-expired", "aprobar una de ayer")

	// Ni se ensaya: un ensayo de hoy sobre una petición de ayer no se
	// presenta como si fuera lo que se pidió.
	req = p.ask(swarmAsk)
	p.db.Exec(`UPDATE provisioning_requests SET created_at = now() - interval '25 hours' WHERE id = ?`, req.ID)
	expect(t, p.check(req.ID, cleanDryRun()), http.StatusConflict, "provisioning-request-expired", "ensayar una de ayer")
}

// Lo destructivo se confirma escribiendo el nombre del servidor, y una
// bandera roja se reconoce a propósito. Rechazar no pide nada.
func TestDestructiveAsksForTheServerNameAndRedFlagsForAcknowledgement(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()
	req := p.ask(`{"playbook":"swarm-teardown","risk":"destructive","verify":"test","rollback":"swarm","configSeq":1}`)
	dry := cleanDryRun()
	dry.Paths = []string{"/etc/ufw/user.rules"}
	got := decode[domain.ProvisioningRequestResponse](t, p.check(req.ID, dry))
	if !domain.HasRedFlag(got.Flags) {
		t.Fatalf("tocar el cortafuegos fuera de baseline no levantó bandera roja: %v", got.Flags)
	}
	expect(t, p.decide(req.ID, `{"approve":true,"acknowledgeFlags":true}`, person()), http.StatusBadRequest, "confirm-server-name", "sin el nombre")
	expect(t, p.decide(req.ID, `{"approve":true,"acknowledgeFlags":true,"confirmServer":"TDS"}`, person()), http.StatusBadRequest, "confirm-server-name", "con el nombre mal")
	expect(t, p.decide(req.ID, `{"approve":true,"confirmServer":"tds"}`, person()), http.StatusBadRequest, "acknowledge-flags", "sin reconocer la bandera")
	expect(t, p.decide(req.ID, `{"approve":true,"acknowledgeFlags":true,"confirmServer":"tds"}`, person()), http.StatusOK, "", "con todo")

	req = p.ask(`{"playbook":"swarm-teardown","risk":"destructive","verify":"test","rollback":"swarm","configSeq":1}`)
	p.check(req.ID, dry)
	expect(t, p.decide(req.ID, `{"approve":false,"note":"no hoy"}`, person()), http.StatusOK, "", "rechazar")
	if st := p.status(req.ID); st != domain.ProvisioningRequestRejected {
		t.Errorf("rechazada se lee %s", st)
	}
	expect(t, p.start("swarm-teardown", req.ID, 1, agent()), http.StatusConflict, "grant-mismatch", "correr una rechazada")
}

// Una petición de otro servidor, o de otra org, no existe para quien pregunta.
func TestARequestBelongsToItsServer(t *testing.T) {
	p, cleanup := newProtocol(t)
	defer cleanup()
	req := p.ask(swarmAsk)
	rec := httptest.NewRecorder()
	p.prov.GetRequest(rec, requestReq(http.MethodGet, "srv-2", req.ID, "", person()))
	expect(t, rec, http.StatusNotFound, "", "leerla por otro servidor")
	rec = httptest.NewRecorder()
	p.prov.SubmitCheck(rec, requestReq(http.MethodPut, "srv-2", req.ID, `{"hosts":["x"]}`, agent()))
	expect(t, rec, http.StatusNotFound, "", "ensayarla por otro servidor")
	rec = httptest.NewRecorder()
	p.prov.GetRequest(rec, requestReq(http.MethodGet, "srv-1", req.ID, "", claims("u-ana", "org-2", domain.OrgRoleAdmin)))
	if rec.Code == http.StatusOK {
		t.Error("otra org leyó la petición")
	}
	// Y pedir sin una versión de la config que exista, no.
	rec = httptest.NewRecorder()
	p.prov.CreateRequest(rec, requestReq(http.MethodPost, "srv-1", "", strings.Replace(swarmAsk, `"configSeq":1`, `"configSeq":9`, 1), agent()))
	expect(t, rec, http.StatusNotFound, "config-version-not-found", "pedir con una versión que no existe")
}
