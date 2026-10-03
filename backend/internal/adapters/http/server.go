package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/k8s"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitServerRoutes(db *gorm.DB, r *chi.Mux, bus *events.Hub) {
	InitServerRoutesWith(db, r, bus, nil)
}

// InitServerRoutesWith: con la GitHub App, que sigue cada deploy en GitHub y
// cuyo `workflow_run` cuenta como el aviso del CI. nil = sin ella.
func InitServerRoutesWith(db *gorm.DB, r *chi.Mux, bus *events.Hub, gh *service.GitHubService) {
	repo := repository.NewServerRepository(db)
	svc := service.NewServerService(repo)
	h := handler.NewServerHandler(svc)

	hub := service.NewK8sHubService(k8s.New())
	k8sH := handler.NewK8sHandler(svc, hub)

	intgSvc := service.NewIntegrationService(repository.NewIntegrationRepository(db))
	intgH := handler.NewIntegrationHandler(svc, intgSvc)

	deployRepo := repository.NewDeployRepository(db)
	deploySvc := service.NewDeployService(deployRepo, repository.NewServerRepository(db), bus)
	if gh != nil {
		deploySvc.WithObserver(gh)
		gh.WithDeploys(deploySvc, deployRepo)
	}
	deployH := handler.NewDeployHandler(svc, deploySvc).
		WithSecrets(service.NewSecretRefService(repository.NewSecretRefRepository(db)))
	agentH := handler.NewAgentHandler(svc, deploySvc)

	provH := handler.NewProvisioningHandler(svc, service.NewProvisioningService(repository.NewProvisioningRepository(db)))

	r.Route("/api/v1/servers", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListServers)
		r.Get("/{id}", h.GetServer)
		r.Post("/", h.CreateServer)
		r.Patch("/{id}", h.UpdateServer)
		r.Post("/{id}/agent-status", h.ReportAgentStatus)
		// La identidad del agente (admin) y los pases cortos de la app.
		r.Post("/{id}/agent-token", agentH.MintToken)
		r.Post("/{id}/agent-session", agentH.Session)
		r.Delete("/{id}", h.DeleteServer)
		// Platform hub (kubernetes servers): read-only cluster views.
		r.Get("/{id}/k8s/routes", k8sH.Routes)
		r.Get("/{id}/k8s/health", k8sH.Health)
		// Integrations (vault + launcher).
		r.Get("/{id}/integrations", intgH.List)
		r.Post("/{id}/integrations", intgH.Create)
		r.Patch("/{id}/integrations/{iid}", intgH.Update)
		r.Delete("/{id}/integrations/{iid}", intgH.Delete)
		r.Post("/{id}/integrations/{iid}/reveal", intgH.Reveal)
		r.Post("/{id}/integrations/{iid}/launch", intgH.Launch)
		// Lo que la app aplicó a la máquina: playbooks y rotaciones. Lo ejecuta
		// la laptop; aquí sólo queda el registro. Ver domain.ProvisioningRun.
		r.Get("/{id}/provisioning-runs", provH.List)
		r.Post("/{id}/provisioning-runs", provH.Start)
		r.Patch("/{id}/provisioning-runs/{rid}", provH.Finish)
		// Los servicios que cac sabe desplegar, y sus despliegues. Ver
		// domain.Deployable.
		r.Get("/{id}/deployables", deployH.List)
		r.Post("/{id}/deployables", deployH.Create)
		r.Patch("/{id}/deployables/{did}", deployH.Update)
		r.Delete("/{id}/deployables/{did}", deployH.Delete)
		r.Post("/{id}/deployables/{did}/deploy", deployH.Deploy)
		r.Get("/{id}/deployables/{did}/deployments", deployH.Deployments)
		r.Get("/{id}/deployables/{did}/deployments/{depId}", deployH.Deployment)
		r.Post("/{id}/deployables/{did}/deployments/{depId}/rollback", deployH.Rollback)
		r.Post("/{id}/deployables/{did}/ci-key", deployH.CIKey)
		r.Get("/{id}/deployables/{did}/builds", deployH.Builds)
		r.Get("/{id}/deployables/{did}/secret-refs", deployH.SecretRefs)
		r.Put("/{id}/deployables/{did}/secret-refs", deployH.PutSecretRefs)
		r.Get("/{id}/deployables/{did}/secret-rotations", deployH.SecretRotations)
		r.Post("/{id}/deployables/{did}/secret-rotations", deployH.RecordRotation)
	})

	// El aviso del CI de un servicio: su propia llave, fuera del JWT. Ver
	// DeployHandler.DeployIngest y docs/integrations/deploys.md.
	r.Post("/ingest/v1/deploys", deployH.DeployIngest)

	// El agente de cada servidor, con su propio token y no con el JWT de una
	// persona: el agente no es nadie. Todo lo que pida se contesta sobre su
	// máquina y nada más. Ver middleware.AgentTokenMiddleware.
	r.Route("/agent/v1", func(r chi.Router) {
		r.Use(middleware.AgentTokenMiddleware(svc.AgentByToken))
		r.Get("/jobs", agentH.Jobs)
		r.Post("/jobs/{jid}/log", agentH.JobLog)
		r.Post("/jobs/{jid}/finish", agentH.JobFinish)
	})

	// Integration proxy — authenticated by the launch token / its session cookie,
	// NOT the JWT (a browser can't attach Authorization to navigations or assets),
	// so it lives outside the JWT group. Same pattern as the report image proxy.
	r.HandleFunc("/api/v1/servers/{id}/integrations/{iid}/proxy", intgH.Proxy)
	r.HandleFunc("/api/v1/servers/{id}/integrations/{iid}/proxy/*", intgH.Proxy)
}
