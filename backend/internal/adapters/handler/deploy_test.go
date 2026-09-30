package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

/*
Desplegar desde cac (R2 del módulo de servidores).

cac encola; el agente del servidor recoge el deploy en su siguiente pregunta,
despliega, cuenta por dónde va y dice cómo acabó. Lo que se fija aquí es lo que
no puede fallar sin que nadie lo note: un solo deploy vivo por servicio, que un
agente sólo toque los de su máquina, que un rollback vuelva a lo de antes y
nunca a una imagen de otro sitio, y que un agente muerto no bloquee el servicio
para siempre.
*/

const repoAPI = "ghcr.io/dwit-mexico/api"

func deploySetup(t *testing.T) (*gorm.DB, *service.DeployService, *domain.Deployable, func()) {
	t.Helper()
	db, cleanup := provisioningDB(t)
	// Los agentes de la fixture ya saben desplegar.
	if err := db.Exec("UPDATE servers SET agent_version = ?", domain.AgentVersionDeploys).Error; err != nil {
		t.Fatal(err)
	}
	svc := service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil)
	servers := service.NewServerService(repository.NewServerRepository(db))
	srv, err := servers.Find("srv-1")
	if err != nil {
		t.Fatal(err)
	}
	d, err := svc.CreateDeployable(srv, domain.CreateDeployableRequest{
		Name: "api", Stack: "beta-api-prod", ServiceName: "beta-api-prod_app", ImageRepo: repoAPI, Environment: "prod",
	})
	if err != nil {
		t.Fatal(err)
	}
	return db, svc, d, cleanup
}

// El agente recoge el deploy y lo cierra, como haría de verdad.
func runDeploy(t *testing.T, svc *service.DeployService, serverID string, req domain.AgentFinishRequest) *domain.AgentJob {
	t.Helper()
	job, err := svc.Claim(serverID)
	if err != nil || job == nil {
		t.Fatalf("el agente no recogió nada: %v", err)
	}
	if err := svc.Finish(serverID, job.ID, req); err != nil {
		t.Fatal(err)
	}
	return job
}

func TestOnlyOneLiveDeployPerService(t *testing.T) {
	_, svc, d, cleanup := deploySetup(t)
	defer cleanup()

	if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "def5678", ""); !errors.Is(err, repository.ErrDeployInFlight) {
		t.Fatalf("un segundo deploy con otro en cola → %v, se esperaba ErrDeployInFlight", err)
	}
	// Con el primero terminado, ya se puede.
	runDeploy(t, svc, "srv-1", domain.AgentFinishRequest{Status: "succeeded", FinalImage: repoAPI + ":abc1234"})
	if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "def5678", ""); err != nil {
		t.Errorf("con el anterior cerrado, desplegar → %v", err)
	}
}

// Quien pide un deploy dice qué commit, no qué imagen.
func TestADeployIsOfACommitOfItsRepository(t *testing.T) {
	_, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	for _, sha := range []string{"latest", "abc; rm", "--mount", "abc12", "ghcr.io/otro/x:abc1234"} {
		if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", sha, ""); !errors.Is(err, service.ErrBadSha) {
			t.Errorf("%q → %v, se esperaba ErrBadSha", sha, err)
		}
	}
	dep, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	if err != nil {
		t.Fatal(err)
	}
	if dep.Image != repoAPI+":abc1234" {
		t.Errorf("la imagen es %q, se esperaba el repo del servicio con el sha", dep.Image)
	}
}

func TestRollbackGoesBackToWhatWasThereBefore(t *testing.T) {
	db, svc, d, cleanup := deploySetup(t)
	defer cleanup()

	dep, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	runDeploy(t, svc, "srv-1", domain.AgentFinishRequest{
		Status: "succeeded", PreviousImage: repoAPI + ":viejo", FinalImage: repoAPI + ":abc1234",
	})

	back, err := svc.Rollback(d, dep.ID, "u-ana")
	if err != nil {
		t.Fatal(err)
	}
	if back.Image != repoAPI+":viejo" || back.RollbackOfID != dep.ID {
		t.Fatalf("el rollback apunta a %q (de %q), se esperaba lo de antes", back.Image, back.RollbackOfID)
	}
	job := runDeploy(t, svc, "srv-1", domain.AgentFinishRequest{
		Status: "succeeded", PreviousImage: repoAPI + ":abc1234", FinalImage: repoAPI + ":viejo",
	})
	if job.Data.Image != repoAPI+":viejo" {
		t.Errorf("el agente recibió %q", job.Data.Image)
	}

	var original domain.Deployment
	db.First(&original, "id = ?", dep.ID)
	if original.Status != domain.DeployRolledBack {
		t.Errorf("el deploy del que se volvió quedó %s, se esperaba rolled_back", original.Status)
	}
	var ahora domain.Deployable
	db.First(&ahora, "id = ?", d.ID)
	if ahora.CurrentImage != repoAPI+":viejo" {
		t.Errorf("el servicio dice que tiene %q", ahora.CurrentImage)
	}
}

// Lo de antes lo leyó el agente del servicio; aun así, si no es de este
// repositorio no se despliega. Y sin nada antes, no hay a dónde volver.
func TestRollbackNeverDeploysAnImageFromElsewhere(t *testing.T) {
	_, svc, d, cleanup := deploySetup(t)
	defer cleanup()

	dep, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	runDeploy(t, svc, "srv-1", domain.AgentFinishRequest{
		Status: "succeeded", PreviousImage: "evil.io/otro:1", FinalImage: repoAPI + ":abc1234",
	})
	if _, err := svc.Rollback(d, dep.ID, "u-ana"); !errors.Is(err, service.ErrRollbackOutsideRepo) {
		t.Errorf("volver a una imagen de otro repo → %v, se esperaba ErrRollbackOutsideRepo", err)
	}

	dep2, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "def5678", "")
	runDeploy(t, svc, "srv-1", domain.AgentFinishRequest{Status: "succeeded", FinalImage: repoAPI + ":def5678"})
	if _, err := svc.Rollback(d, dep2.ID, "u-ana"); !errors.Is(err, service.ErrNothingToRollBackTo) {
		t.Errorf("sin nada antes → %v, se esperaba ErrNothingToRollBackTo", err)
	}
}

// Un agente recoge, loguea y cierra sólo lo de su máquina.
func TestAnAgentOnlyTouchesItsOwnServersDeploys(t *testing.T) {
	db, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	srv2, _ := servers.Find("srv-2")
	d2, err := svc.CreateDeployable(srv2, domain.CreateDeployableRequest{
		Name: "web", Stack: "web", ServiceName: "web_app", ImageRepo: repoAPI,
	})
	if err != nil {
		t.Fatal(err)
	}
	dep1, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	if _, _, err := svc.RequestDeploy(d2, domain.DeployByUser, "u-ana", "abc1234", ""); err != nil {
		t.Fatal(err)
	}

	job, err := svc.Claim("srv-2")
	if err != nil || job == nil {
		t.Fatalf("srv-2 no recogió el suyo: %v", err)
	}
	if job.Data.ServiceName != "web_app" {
		t.Fatalf("srv-2 recogió %q, que no es de su máquina", job.Data.ServiceName)
	}
	if again, _ := svc.Claim("srv-2"); again != nil {
		t.Errorf("srv-2 recogió también %q", again.Data.ServiceName)
	}

	// El de srv-1, en curso, no se puede tocar desde srv-2.
	if _, err := svc.Claim("srv-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AppendLog("srv-2", dep1.ID, []string{"hola"}); !errors.Is(err, repository.ErrDeployNotRunning) {
		t.Errorf("loguear el deploy de otra máquina → %v", err)
	}
	if err := svc.Finish("srv-2", dep1.ID, domain.AgentFinishRequest{Status: "succeeded"}); !errors.Is(err, repository.ErrDeployNotRunning) {
		t.Errorf("cerrar el deploy de otra máquina → %v", err)
	}
}

// El log tiene tope, y cuando se llega lo dice.
func TestTheDeployLogIsCappedAndSaysSo(t *testing.T) {
	db, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	dep, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	if _, err := svc.Claim("srv-1"); err != nil {
		t.Fatal(err)
	}
	trozo := strings.Repeat("x", domain.DeployLogMax/2+10)
	for i := 0; i < 3; i++ {
		if err := svc.AppendLog("srv-1", dep.ID, []string{trozo}); err != nil {
			t.Fatal(err)
		}
	}
	var got domain.Deployment
	db.First(&got, "id = ?", dep.ID)
	if len(got.Log) > domain.DeployLogMax+100 {
		t.Errorf("el log mide %d bytes; el tope es %d", len(got.Log), domain.DeployLogMax)
	}
	if !strings.Contains(got.Log, "log truncated") {
		t.Error("se cortó el log sin decirlo")
	}
}

// Un agente que muere a medias no bloquea el servicio para siempre.
func TestAStuckDeployDoesNotBlockTheServiceForever(t *testing.T) {
	db, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	dep, _, _ := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", "")
	if _, err := svc.Claim("srv-1"); err != nil {
		t.Fatal(err)
	}
	hace := time.Now().Add(-domain.DeployStaleAfter - time.Minute)
	db.Model(&domain.Deployment{}).Where("id = ?", dep.ID).Update("started_at", hace)

	if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "def5678", ""); err != nil {
		t.Fatalf("con el anterior colgado, desplegar → %v", err)
	}
	var viejo domain.Deployment
	db.First(&viejo, "id = ?", dep.ID)
	if viejo.Status != domain.DeployFailed {
		t.Errorf("el colgado quedó %s, se esperaba failed", viejo.Status)
	}
}

// El mismo aviso dos veces es un solo deployment.
func TestTheSameNoticeTwiceIsOneDeployment(t *testing.T) {
	_, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	a, created, err := svc.RequestDeploy(d, domain.DeployByCI, "", "abc1234", "ci:abc1234")
	if err != nil || !created {
		t.Fatalf("el primer aviso: %v %v", created, err)
	}
	b, created, err := svc.RequestDeploy(d, domain.DeployByCI, "", "abc1234", "ci:abc1234")
	if err != nil || created || b.ID != a.ID {
		t.Errorf("el segundo aviso creó otro (%v) o falló: %v", created, err)
	}
}

// Quién puede qué: ver, cualquiera de la org; desplegar, member; un servidor
// kubernetes no despliega desde cac; un deployable de otro servidor no existe.
func TestWhoMayDeploy(t *testing.T) {
	db, _, d, cleanup := deploySetup(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	h := NewDeployHandler(servers, service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil))

	deploy := func(serverID string, c *domain.ClaimsJWT) int {
		r := serverReq(http.MethodPost, serverID, "", `{"sha":"abc1234"}`, c)
		rctx := chiContext(r)
		rctx.URLParams.Add("did", d.ID)
		rec := httptest.NewRecorder()
		h.Deploy(rec, r)
		return rec.Code
	}
	if code := deploy("srv-1", claims("u-vera", "org-1", domain.OrgRoleViewer)); code != http.StatusForbidden {
		t.Errorf("un viewer desplegando → %d, se esperaba 403", code)
	}
	if code := deploy("srv-2", claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusNotFound {
		t.Errorf("el deployable de srv-1 pedido por srv-2 → %d, se esperaba 404", code)
	}
	if code := deploy("srv-1", claims("u-ana", "org-1", domain.OrgRoleMember)); code != http.StatusAccepted {
		t.Errorf("un miembro desplegando → %d, se esperaba 202", code)
	}

	rec := httptest.NewRecorder()
	h.Create(rec, serverReq(http.MethodPost, "srv-k8s", "",
		`{"name":"x","stack":"x","serviceName":"x_app","imageRepo":"ghcr.io/a/b"}`, claims("u-ana", "org-1", domain.OrgRoleAdmin)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("un deployable en un kubernetes → %d, se esperaba 400", rec.Code)
	}
}

// A un agente que no sabe desplegar no se le encola nada: se dice al pedirlo,
// en vez de dejar el deploy «en curso» quince minutos hasta caducar.
func TestAnAgentThatCannotDeployIsRefusedUpFront(t *testing.T) {
	db, svc, d, cleanup := deploySetup(t)
	defer cleanup()
	db.Exec("UPDATE servers SET agent_version = ? WHERE id = 'srv-1'", domain.AgentVersionDeploys-1)
	if _, _, err := svc.RequestDeploy(d, domain.DeployByUser, "u-ana", "abc1234", ""); !errors.Is(err, service.ErrAgentTooOld) {
		t.Errorf("con un agente v%d → %v, se esperaba ErrAgentTooOld", domain.AgentVersionDeploys-1, err)
	}
	var n int64
	db.Model(&domain.Deployment{}).Count(&n)
	if n != 0 {
		t.Errorf("se encolaron %d deploys para un agente que no sabe hacerlos", n)
	}
}

// La llave del CI despliega sin persona delante: la acuña un admin, se enseña
// una sola vez y lo que se guarda es su hash, que nunca sale en JSON. Los
// builds que avisa los ve cualquiera de la org.
func TestOnlyAnAdminMintsACIKey(t *testing.T) {
	db, _, d, cleanup := deploySetup(t)
	defer cleanup()
	servers := service.NewServerService(repository.NewServerRepository(db))
	h := NewDeployHandler(servers, service.NewDeployService(repository.NewDeployRepository(db), repository.NewServerRepository(db), nil))

	call := func(fn http.HandlerFunc, method string, c *domain.ClaimsJWT) *httptest.ResponseRecorder {
		r := serverReq(method, "srv-1", "", `{}`, c)
		chiContext(r).URLParams.Add("did", d.ID)
		rec := httptest.NewRecorder()
		fn(rec, r)
		return rec
	}
	if rec := call(h.CIKey, http.MethodPost, claims("u-ana", "org-1", domain.OrgRoleMember)); rec.Code != http.StatusForbidden {
		t.Errorf("un miembro acuñando la llave → %d, se esperaba 403", rec.Code)
	}
	rec := call(h.CIKey, http.MethodPost, claims("u-ana", "org-1", domain.OrgRoleAdmin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("un admin acuñando la llave → %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Data domain.CIKeyResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || !strings.HasPrefix(res.Data.Key, repository.DeployKeyPrefix) {
		t.Fatalf("la llave no llegó: %s", rec.Body.String())
	}

	var stored domain.Deployable
	db.First(&stored, "id = ?", d.ID)
	if !bytes.Equal(stored.CIKeyHash, repository.HashDeployKey(res.Data.Key)) {
		t.Error("lo guardado no es el hash de la llave")
	}
	if strings.Contains(string(stored.CIKeyHash), res.Data.Key) {
		t.Error("la llave se guardó en claro")
	}
	out, _ := json.Marshal(stored)
	if strings.Contains(string(out), "ciKeyHash") || strings.Contains(string(out), "ci_key_hash") {
		t.Errorf("el hash de la llave viaja en JSON: %s", out)
	}
	if head := strings.TrimSuffix(stored.CIKeyPreview, "…"); head == stored.CIKeyPreview || !strings.HasPrefix(res.Data.Key, head) || len(head) >= len(res.Data.Key)/2 {
		t.Errorf("la vista previa %q no sirve para reconocer la llave", stored.CIKeyPreview)
	}

	if rec := call(h.Builds, http.MethodGet, claims("u-vera", "org-1", domain.OrgRoleViewer)); rec.Code != http.StatusOK {
		t.Errorf("un viewer viendo los builds → %d, se esperaba 200", rec.Code)
	}
}
