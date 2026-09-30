package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
La identidad del agente (R1 del módulo de servidores).

Hasta aquí el agente de cada VPS no tenía auth: cualquiera que supiera la IP
leía sus logs y reiniciaba servicios. Ahora cada servidor tiene un token —del
que sólo se guarda el HMAC—, el agente le pregunta al backend con él, y
preguntar es su latido: el estado de un servidor con identidad sale de ahí, no
de lo que la última app pudo alcanzar.
*/

// Reacuñar tumba el token anterior. Es lo que hace útil al botón: si una
// llave se filtra, reinstalar el agente la deja sin valor.
func TestRemintingRevokesThePreviousToken(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	svc := service.NewServerService(repository.NewServerRepository(db))

	primero, err := svc.MintAgentToken("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	if srv, err := svc.AgentByToken(primero.Token); err != nil || srv.ID != "srv-1" {
		t.Fatalf("el token recién acuñado no abre: %v", err)
	}
	segundo, err := svc.MintAgentToken("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AgentByToken(primero.Token); err == nil {
		t.Error("el token viejo sigue abriendo después de reacuñar")
	}
	if srv, err := svc.AgentByToken(segundo.Token); err != nil || srv.ID != "srv-1" {
		t.Errorf("el token nuevo no abre: %v", err)
	}
	if primero.SessionKey == segundo.SessionKey {
		t.Error("reacuñar tiene que cambiar también la llave de sesión")
	}
}

// Sólo un admin acuña, y sólo en un servidor swarm.
func TestOnlyAdminsMintAgentTokens(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	h := NewAgentHandler(service.NewServerService(repository.NewServerRepository(db)))

	rec := httptest.NewRecorder()
	h.MintToken(rec, serverReq(http.MethodPost, "srv-1", "", "", claims("u-ana", "org-1", domain.OrgRoleMember)))
	if rec.Code != http.StatusForbidden {
		t.Errorf("un miembro acuñando → %d, se esperaba 403", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.MintToken(rec, serverReq(http.MethodPost, "srv-1", "", "", claims("u-ana", "org-1", domain.OrgRoleAdmin)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("un admin acuñando → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data domain.AgentTokenResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(res.Data.Token, repository.AgentTokenPrefix) || res.Data.SessionKey == "" {
		t.Errorf("la respuesta no trae las dos piezas: %+v", res.Data)
	}
	if strings.Contains(res.Data.Preview, res.Data.Token[len(repository.AgentTokenPrefix)+6:]) {
		t.Error("la vista previa enseña el token entero")
	}

	rec = httptest.NewRecorder()
	h.MintToken(rec, serverReq(http.MethodPost, "srv-k8s", "", "", claims("u-ana", "org-1", domain.OrgRoleAdmin)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("un kubernetes acuñando → %d, se esperaba 400", rec.Code)
	}
}

// El pase de la app se firma con la llave del servidor **actual**.
func TestAnAgentSessionVerifiesWithTheCurrentKey(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	svc := service.NewServerService(repository.NewServerRepository(db))

	if _, err := svc.AgentSession("srv-1", "u-ana", time.Now()); err != service.ErrNoAgentToken {
		t.Errorf("sin token, pedir un pase → %v, se esperaba ErrNoAgentToken", err)
	}
	tok, _ := svc.MintAgentToken("srv-1")
	pase, err := svc.AgentSession("srv-1", "u-ana", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if u, ok := repository.VerifyAgentSession(tok.SessionKey, "srv-1", pase.Token, time.Now()); !ok || u != "u-ana" {
		t.Errorf("el agente no aceptaría este pase: %q %v", u, ok)
	}
	if _, err := svc.MintAgentToken("srv-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := repository.VerifyAgentSession(tok.SessionKey, "srv-1", pase.Token, time.Now()); !ok {
		t.Fatal("el control: la llave vieja verifica el pase viejo")
	}
	nuevo, _ := svc.AgentSession("srv-1", "u-ana", time.Now())
	if _, ok := repository.VerifyAgentSession(tok.SessionKey, "srv-1", nuevo.Token, time.Now()); ok {
		t.Error("un pase nuevo verifica con la llave de antes de reacuñar")
	}
}

// Con identidad, lo que diga la app ya no manda: la verdad es el latido.
func TestTheAppNoLongerDecidesAnAgentWithIdentity(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	svc := service.NewServerService(repository.NewServerRepository(db))

	// Sin identidad, la app sí decide (los agentes de antes).
	if err := svc.ReportAgentStatus("srv-2", "online"); err != nil {
		t.Fatal(err)
	}
	if s, _ := svc.Find("srv-2"); s.Status != "online" {
		t.Errorf("un agente sin identidad: %s, se esperaba lo que dijo la app", s.Status)
	}

	if _, err := svc.MintAgentToken("srv-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Heartbeat("srv-1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := svc.ReportAgentStatus("srv-1", "offline"); err != nil {
		t.Fatal(err)
	}
	if s, _ := svc.Find("srv-1"); s.Status != "online" {
		t.Errorf("la app pisó el latido: %s", s.Status)
	}
}

// Ni el hash ni la sal del agente viajan en JSON. La sal no es secreta sola,
// pero con el secreto del backend da la llave de sesión: no tiene por qué
// salir de la base.
func TestAgentIdentityNeverTravelsInJSON(t *testing.T) {
	visto := time.Now()
	srv := domain.Server{AgentTokenHash: []byte("hash-secreto"), AgentTokenSalt: "sal-secreta", AgentTokenPreview: "cac_agent_abcdef…", AgentSeenAt: &visto}
	raw, _ := json.Marshal(srv)
	for _, prohibido := range []string{"hash-secreto", "aGFzaC1zZWNyZXRv", "sal-secreta"} {
		if strings.Contains(string(raw), prohibido) {
			t.Errorf("domain.Server serializa %q", prohibido)
		}
	}
	tipo := reflect.TypeOf(domain.ServerResponse{})
	for i := 0; i < tipo.NumField(); i++ {
		n := strings.ToLower(tipo.Field(i).Name)
		if strings.Contains(n, "hash") || strings.Contains(n, "salt") {
			t.Errorf("ServerResponse.%s: la identidad del agente no sale en la respuesta", tipo.Field(i).Name)
		}
	}
}

// La pregunta del agente sobrevive al `WriteTimeout` del servidor.
//
// El backend corta toda respuesta a los 15 s (cmd/main.go) y el long-poll se
// sostiene hasta 25: sin mover el plazo, cada pregunta moría a medias. Esto
// monta un servidor HTTP de verdad con un `WriteTimeout` corto —un
// `httptest.NewRecorder` no tiene ninguno, y por eso las otras pruebas no lo
// veían— y le pide que sostenga más de lo que el timeout deja.
func TestTheAgentPollOutlivesTheServerWriteTimeout(t *testing.T) {
	db, cleanup := provisioningDB(t)
	defer cleanup()
	svc := service.NewServerService(repository.NewServerRepository(db))
	h := NewAgentHandler(svc)
	srv := &domain.Server{BaseModel: domain.BaseModel{ID: "srv-1"}}

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), repository.AgentServerContextKey, srv)
		h.Jobs(w, r.WithContext(ctx))
	}))
	ts.Config.WriteTimeout = 500 * time.Millisecond
	ts.Start()
	defer ts.Close()

	res, err := http.Get(ts.URL + "/agent/v1/jobs?wait=1")
	if err != nil {
		t.Fatalf("la pregunta murió por el WriteTimeout: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("→ %d, se esperaba 204", res.StatusCode)
	}
}
