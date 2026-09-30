package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	httpRoutes "github.com/guz-studio/cac/swarm-manage/internal/adapters/http"
	"github.com/guz-studio/cac/swarm-manage/internal/core/config"
	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
	"github.com/guz-studio/cac/swarm-manage/internal/core/service"
)

func main() {
	cfg := config.Load()
	port := cfg.Port

	r := httpRoutes.InitRoutes(cfg)

	// Sin identidad no hay API: se dice al arrancar, que es donde se mira.
	if !cfg.Configured() {
		log.Printf("sin identidad (faltan /run/secrets/cac_agent_session_key o CAC_SERVER_ID): /api/v1 contesta 503. Reinstala el agente desde cac.")
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if cfg.CanPoll() {
		poller := service.NewPoller(cfg.BackendURL, cfg.Token)
		deployer := service.NewDeployer(
			repository.NewDockerClient(),
			service.NewBackendReporter(cfg.BackendURL, cfg.Token),
			config.RegistryAuth(registryAuthPath()),
		)
		poller.OnJob = func(ctx context.Context, job service.Job) {
			switch job.Kind {
			case "deploy":
				deployer.Run(ctx, job.ID, job.Data)
			default:
				log.Printf("trabajo %s de tipo %q, que esta versión no sabe hacer", job.ID, job.Kind)
			}
		}
		go poller.Run(ctx)
	} else {
		log.Printf("sin CAC_URL o sin token: no le pregunto al backend, y cac verá este servidor como caído")
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  60 * time.Second,
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		fmt.Printf("swarm-manage listening on :%s\n", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-sigChan
	stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
}

// registryAuthPath: dónde monta la app el secret con las credenciales del
// registro. Se puede cambiar por entorno para correrlo fuera de Swarm.
func registryAuthPath() string {
	if p := os.Getenv("CAC_REGISTRY_AUTH_FILE"); p != "" {
		return p
	}
	return "/run/secrets/cac_registry_auth"
}
