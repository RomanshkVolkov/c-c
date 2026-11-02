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
	// La campana (R9): un deploy que acaba y un run del CI que termina dejan
	// fila a toda la org. Ver docs/notifications.md.
	inbox := service.NewNotificationService(repository.NewNotificationRepository(db))
	orgs := repository.NewOrganizationRepository(db)
	deploySvc.WithNotifier(inbox, orgs)
	if gh != nil {
		deploySvc.WithObserver(gh)
		gh.WithDeploys(deploySvc, deployRepo).WithNotifier(inbox, orgs)
		// Construir en el servidor clona con el token de la App.
		deploySvc.WithRepoTokens(gh)
	}
	deployH := handler.NewDeployHandler(svc, deploySvc).
		WithSecrets(service.NewSecretRefService(repository.NewSecretRefRepository(db)))
	if gh != nil {
		deployH.WithRepos(gh)
	}
	// Los backups de bases (#166). Sin BACKUPS_BUCKET el servicio queda
	// apagado: las rutas contestan 503 y la app lo dice.
	store := newBackupStore()
	backupSvc := service.NewBackupService(repository.NewBackupRepository(db), repository.NewServerRepository(db), orgs, store, bus, inbox)
	backupH := handler.NewBackupHandler(svc, backupSvc)
	startBackupClockFn(backupSvc)
	agentH := handler.NewAgentHandler(svc, deploySvc).WithBackups(backupSvc)

	// La config de cada servidor y las plantillas de la org viven en cac; el
	// repo de Ansible sólo tiene los playbooks. Ver domain/server_config.go.
	configSvc := service.NewServerConfigService(repository.NewServerConfigRepository(db), repository.NewServerRepository(db))
	configH := handler.NewServerConfigHandler(svc, configSvc)
	provH := handler.NewProvisioningHandler(svc, service.NewProvisioningService(repository.NewProvisioningRepository(db)).WithConfigs(configSvc))

	incH := handler.NewIncidentHandler(
		service.NewIncidentService(repository.NewIncidentRepository(db), repository.NewDocRepository(db)),
		service.NewDocService(repository.NewDocRepository(db)), svc)

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
		// Lo que ha mordido en este servidor (domain.Incident).
		r.Get("/{id}/incidents", incH.ForServer)
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
		// Lo que un agente pide aplicar, con su ensayo y su aprobación. Ver
		// domain.ProvisioningRequest.
		r.Get("/{id}/provisioning-requests", provH.Requests)
		r.Post("/{id}/provisioning-requests", provH.CreateRequest)
		r.Get("/{id}/provisioning-requests/{rqid}", provH.GetRequest)
		r.Put("/{id}/provisioning-requests/{rqid}/check", provH.SubmitCheck)
		r.Post("/{id}/provisioning-requests/{rqid}/decision", provH.Decide)
		r.Post("/{id}/provisioning-requests/{rqid}/discard", provH.Discard)
		// Su config versionada: lo que se le aplica, sin ningún valor secreto.
		r.Get("/{id}/config", configH.Config)
		r.Put("/{id}/config", configH.Save)
		r.Get("/{id}/config/effective", configH.Effective)
		r.Get("/{id}/config/versions/{seq}", configH.Version)
		// Los servicios que cac sabe desplegar, y sus despliegues. Ver
		// domain.Deployable.
		r.Get("/{id}/deployables", deployH.List)
		r.Post("/{id}/deployables", deployH.Create)
		r.Patch("/{id}/deployables/{did}", deployH.Update)
		r.Delete("/{id}/deployables/{did}", deployH.Delete)
		r.Post("/{id}/deployables/{did}/deploy", deployH.Deploy)
		// Backups de bases (#166).
		r.Get("/{id}/backups/status", backupH.Status)
		r.Get("/{id}/backups/targets", backupH.ListTargets)
		r.Post("/{id}/backups/targets", backupH.CreateTarget)
		r.Patch("/{id}/backups/targets/{tid}", backupH.UpdateTarget)
		r.Delete("/{id}/backups/targets/{tid}", backupH.DeleteTarget)
		r.Post("/{id}/backups/targets/{tid}/run", backupH.RunNow)
		r.Post("/{id}/backups/targets/{tid}/test", backupH.TestNow)
		r.Get("/{id}/backups/targets/{tid}/history", backupH.History)
		r.Get("/{id}/backups/recipients", backupH.Recipients)
		r.Post("/{id}/backups/recipients", backupH.AddRecipient)
		r.Delete("/{id}/backups/recipients/{rid}", backupH.DeleteRecipient)
		r.Get("/{id}/backups/runs/{bid}", backupH.Backup)
		r.Post("/{id}/backups/runs/{bid}/download", backupH.Download)
		r.Get("/{id}/deployables/{did}/deployments", deployH.Deployments)
		r.Get("/{id}/deployables/{did}/deployments/{depId}", deployH.Deployment)
		r.Post("/{id}/deployables/{did}/deployments/{depId}/rollback", deployH.Rollback)
		r.Post("/{id}/deployables/{did}/ci-key", deployH.CIKey)
		r.Get("/{id}/deployables/{did}/builds", deployH.Builds)
		r.Get("/{id}/deployables/{did}/build-args", deployH.BuildArgs)
		r.Get("/{id}/deployables/{did}/commits", deployH.Commits)
		r.Get("/{id}/deployables/{did}/secret-refs", deployH.SecretRefs)
		r.Put("/{id}/deployables/{did}/secret-refs", deployH.PutSecretRefs)
		r.Get("/{id}/deployables/{did}/secret-rotations", deployH.SecretRotations)
		r.Post("/{id}/deployables/{did}/secret-rotations", deployH.RecordRotation)
	})

	// Las plantillas de servidor de una org.
	r.Route("/api/v1/organizations/{id}/server-templates", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", configH.Templates)
		r.Post("/", configH.CreateTemplate)
		r.Get("/{tplId}", configH.Template)
		r.Put("/{tplId}", configH.SaveTemplate)
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
		r.Post("/heartbeat", agentH.Heartbeat)
		r.Post("/backups/{bid}/log", agentH.BackupLog)
		r.Post("/backups/{bid}/upload-url", agentH.BackupUploadURL)
		r.Post("/backups/{bid}/download-url", agentH.BackupDownloadURL)
		r.Post("/backups/{bid}/finish", agentH.BackupFinish)
		r.Post("/restore-key", agentH.RestoreKey)
		r.Post("/jobs/{jid}/log", agentH.JobLog)
		r.Post("/jobs/{jid}/finish", agentH.JobFinish)
	})

	// Integration proxy — authenticated by the launch token / its session cookie,
	// NOT the JWT (a browser can't attach Authorization to navigations or assets),
	// so it lives outside the JWT group. Same pattern as the report image proxy.
	r.HandleFunc("/api/v1/servers/{id}/integrations/{iid}/proxy", intgH.Proxy)
	r.HandleFunc("/api/v1/servers/{id}/integrations/{iid}/proxy/*", intgH.Proxy)
}
