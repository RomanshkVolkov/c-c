package http

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
El aviso del CI (R3 del módulo de servidores): `POST /ingest/v1/deploys` con
`X-Deploy-Key`, montado como en producción.

Un repo que se suma lo hace con un paso de cinco líneas en su `prod.yml`. Lo
que se fija aquí es que ese paso no pueda hacer más de lo que debe: una llave
sólo avisa de su servicio, el mismo aviso dos veces es uno, en modo `record` no
se despliega nada, y un aviso que llega en mal momento se guarda en vez de
tirar el CI.
*/

type ingestFixture struct {
	db      *gorm.DB
	r       *chi.Mux
	deploys *service.DeployService
	a, b    *domain.Deployable
	keyA    string
}

func ingestSetup(t *testing.T, mode string) (*ingestFixture, func()) {
	t.Helper()
	db, cleanup := agentDB(t)
	r := chi.NewRouter()
	InitServerRoutes(db, r, events.NewHub())
	servers := service.NewServerService(repository.NewServerRepository(db))
	deploys := service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil)
	if err := servers.Heartbeat("srv-1", domain.AgentVersionDeploys, time.Now()); err != nil {
		t.Fatal(err)
	}
	srv, _ := servers.Find("srv-1")
	mk := func(name string) *domain.Deployable {
		d, err := deploys.CreateDeployable(srv, domain.CreateDeployableRequest{
			Name: name, Stack: name, ServiceName: name + "_app", ImageRepo: "ghcr.io/a/" + name,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := deploys.UpdateDeployable(d, domain.UpdateDeployableRequest{Name: name, OnCINotify: mode}); err != nil {
			t.Fatal(err)
		}
		return d
	}
	f := &ingestFixture{db: db, r: r, deploys: deploys, a: mk("api"), b: mk("web")}
	k, err := deploys.MintCIKey(f.a)
	if err != nil {
		t.Fatal(err)
	}
	f.keyA = k.Key
	return f, cleanup
}

func (f *ingestFixture) notice(key, sha string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/ingest/v1/deploys",
		strings.NewReader(fmt.Sprintf(`{"sha":%q,"ref":"refs/heads/main","actor":"bot"}`, sha)))
	if key != "" {
		req.Header.Set("X-Deploy-Key", key)
	}
	rec := httptest.NewRecorder()
	f.r.ServeHTTP(rec, req)
	return rec
}

func (f *ingestFixture) count(model any, deployableID string) int64 {
	var n int64
	f.db.Model(model).Where("deployable_id = ?", deployableID).Count(&n)
	return n
}

func noticeOf(t *testing.T, rec *httptest.ResponseRecorder) domain.DeployNoticeResponse {
	t.Helper()
	var res struct {
		Data domain.DeployNoticeResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("respuesta ilegible (%d): %s", rec.Code, rec.Body.String())
	}
	return res.Data
}

// Una llave sólo avisa de su servicio. No hay forma de nombrar otro con ella:
// el cuerpo ni siquiera lleva a qué deployable va.
func TestCIKeyCannotDeployAServiceItWasNotIssuedFor(t *testing.T) {
	f, cleanup := ingestSetup(t, "deploy")
	defer cleanup()
	if rec := f.notice(f.keyA, "abc1234"); rec.Code != http.StatusAccepted {
		t.Fatalf("el aviso bueno → %d: %s", rec.Code, rec.Body.String())
	}
	if n := f.count(&domain.ImageBuild{}, f.b.ID); n != 0 {
		t.Errorf("la llave de api dejó %d builds en web", n)
	}
	if n := f.count(&domain.Deployment{}, f.b.ID); n != 0 {
		t.Errorf("la llave de api encoló %d deploys en web", n)
	}
	if n := f.count(&domain.Deployment{}, f.a.ID); n != 1 {
		t.Errorf("en api hay %d deploys, se esperaba 1", n)
	}
}

// Sin llave, con otra cosa, o con una inventada: 401, y sin contar nada.
func TestAnUnknownDeployKeyIsA401WithoutDetail(t *testing.T) {
	f, cleanup := ingestSetup(t, "deploy")
	defer cleanup()
	for _, k := range []string{"", "pk_algo", "cac_agent_algo", "dk_inventada"} {
		rec := f.notice(k, "abc1234")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%q → %d, se esperaba 401", k, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "api") {
			t.Errorf("%q: la respuesta habla de un servicio: %s", k, rec.Body.String())
		}
	}
}

// El CI que reintenta no duplica nada.
func TestTheSameShaTwiceIsOneBuildAndOneDeployment(t *testing.T) {
	f, cleanup := ingestSetup(t, "deploy")
	defer cleanup()
	first := noticeOf(t, f.notice(f.keyA, "abc1234"))
	second := noticeOf(t, f.notice(f.keyA, "abc1234"))
	if first.Deploy != "queued" || second.Deploy != "exists" {
		t.Errorf("primero %q, segundo %q; se esperaba queued y exists", first.Deploy, second.Deploy)
	}
	if n := f.count(&domain.ImageBuild{}, f.a.ID); n != 1 {
		t.Errorf("%d builds del mismo commit", n)
	}
	if first.Build == nil || second.Build == nil || first.Build.ID != second.Build.ID {
		t.Errorf("el segundo aviso no devolvió el build que ya había: %+v / %+v", first.Build, second.Build)
	}
	if n := f.count(&domain.Deployment{}, f.a.ID); n != 1 {
		t.Errorf("%d deploys del mismo aviso", n)
	}
}

// En modo `record` el CI sigue desplegando él: cac apunta y nada más.
func TestRecordModeNeverEnqueues(t *testing.T) {
	f, cleanup := ingestSetup(t, "record")
	defer cleanup()
	rec := f.notice(f.keyA, "abc1234")
	if rec.Code != http.StatusOK || noticeOf(t, rec).Deploy != "recorded" {
		t.Fatalf("en record → %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count(&domain.Deployment{}, f.a.ID); n != 0 {
		t.Errorf("en modo record se encolaron %d deploys", n)
	}
	if n := f.count(&domain.ImageBuild{}, f.a.ID); n != 1 {
		t.Errorf("en modo record hay %d builds, se esperaba el que llegó", n)
	}
}

// Dos commits seguidos: el segundo llega con el primero desplegándose. Se
// guarda y se dice por qué no se desplegó; el CI no se pone rojo.
func TestANoticeDuringADeployIsKeptNotFailed(t *testing.T) {
	f, cleanup := ingestSetup(t, "deploy")
	defer cleanup()
	f.notice(f.keyA, "abc1234")
	rec := f.notice(f.keyA, "def5678")
	if rec.Code != http.StatusOK {
		t.Fatalf("el segundo aviso → %d: %s", rec.Code, rec.Body.String())
	}
	res := noticeOf(t, rec)
	if res.Deploy != "skipped" || res.Reason != "deploy-in-flight" {
		t.Errorf("se esperaba skipped por deploy-in-flight: %+v", res)
	}
	if res.Build == nil || res.Build.Sha != "def5678" {
		t.Errorf("el build del segundo commit no quedó: %+v", res.Build)
	}
}

// Reacuñar la llave tumba la anterior.
func TestRemintingTheCIKeyRevokesTheOldOne(t *testing.T) {
	f, cleanup := ingestSetup(t, "record")
	defer cleanup()
	vieja := f.keyA
	if _, err := f.deploys.MintCIKey(f.a); err != nil {
		t.Fatal(err)
	}
	if rec := f.notice(vieja, "abc1234"); rec.Code != http.StatusUnauthorized {
		t.Errorf("la llave vieja → %d, se esperaba 401", rec.Code)
	}
}

// Un CI que se vuelve loco no llena la tabla.
func TestTheNoticeIsRateLimited(t *testing.T) {
	f, cleanup := ingestSetup(t, "record")
	defer cleanup()
	var last int
	for i := 0; i < 61; i++ {
		last = f.notice(f.keyA, fmt.Sprintf("abc%04d", i)).Code
	}
	if last != http.StatusTooManyRequests {
		t.Errorf("el aviso 61 en una hora → %d, se esperaba 429", last)
	}
}
