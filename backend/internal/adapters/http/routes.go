package http

import (
	"fmt"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"gorm.io/gorm"
)

func InitRoutes(db *gorm.DB) *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.CORS)
	r.Use(middleware.Recovery)

	InitAuthRoutes(db, r)
	InitOrganizationRoutes(db, r)
	InitServerRoutes(db, r)
	InitCollectionRoutes(db, r)
	// One hub for the whole process: reports and tasks both broadcast on it, and
	// a single SSE connection per client carries everything.
	hub := events.NewHub()
	// Without a shared bus the hub only reaches subscribers on this pod, and the
	// deployment runs more than one — see the package comment. Unset in dev and
	// in tests, where one process is the whole world.
	if addr := repository.GetEnv("VALKEY_ADDR", ""); addr != "" {
		hub.UseBus(addr, repository.GetEnv("VALKEY_PASSWORD", ""))
	} else {
		lg.Warn("events: VALKEY_ADDR not set — live notifications only reach clients " +
			"connected to this pod, which is wrong with more than one replica")
	}
	InitReportRoutes(db, r, hub)
	InitTaskRoutes(db, r, hub)
	InitNotificationRoutes(db, r)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"status":"healthy"}`)
	})

	err := chi.Walk(r, func(method, route string, handler http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		log.Printf("%s %s", method, route)
		return nil
	})
	if err != nil {
		log.Printf("Error walking routes: %v", err)
	}

	return r
}
