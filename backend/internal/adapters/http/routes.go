package http

import (
	"fmt"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitRoutes(db *gorm.DB) *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.CORS)
	r.Use(middleware.Recovery)
	r.Use(ProxyHostOnly)
	r.Use(StrictTransport)

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
	// Después del hub: cambiar la contraseña cierra los streams abiertos.
	InitAuthRoutes(db, r, hub)
	InitCollectionRoutes(db, r)
	// Después del hub, y no antes: añadir a alguien a una organización tiene que
	// poder avisarle **a él**, y para eso el servicio necesita voz.
	InitOrganizationRoutes(db, r, hub)
	// Los servidores también: un deploy cuenta por el hub por dónde va.
	// La GitHub App la comparten servidores (sigue cada deploy en GitHub) y sus
	// propias rutas (webhooks y la pestaña de la org).
	// Y apunta cada run del CI de los repos de la org (R9, la Actividad).
	gh := service.NewGitHubService(repository.NewGitHubRepository(db), GitHubConfigFromEnv(), hub).
		WithApp(GitHubAppKeyFromEnv()).
		WithActivity(repository.NewActivityRepository(db))
	InitServerRoutesWith(db, r, hub, gh)
	InitReportRoutes(db, r, hub)
	InitTaskRoutes(db, r, hub)
	// La campana al teléfono (W2): Web Push con las llaves VAPID del entorno.
	// Sin ellas el servicio queda apagado y la web no ofrece suscribirse.
	push := service.NewPushService(repository.NewPushRepository(db),
		repository.GetEnv("VAPID_PUBLIC_KEY", ""), repository.GetEnv("VAPID_PRIVATE_KEY", ""),
		repository.GetEnv("VAPID_SUBJECT", ""))
	service.SetPush(push)
	InitNotificationRoutes(db, r, push)
	// Las reuniones periódicas y las grabaciones: los dos relojes de fondo.
	InitMeetingRoutes(db, r, hub)
	recordings := InitRecordingRoutes(db, r, hub)
	// Llamar con gente de fuera (W3): graba con el mismo servicio.
	InitCallRoutes(db, r, recordings)
	InitGitHubRoutesWith(r, gh)
	InitActivityRoutes(db, r)

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

// ProxyHostOnly: el dominio del proxy de integraciones sólo sirve el proxy. Si
// sirviera la API, una herramienta podría llamarla desde su propio origen como
// si fuera cac; y no hay nada más que ofrecer ahí.
func ProxyHostOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if host := handler.ProxyHost(); host != "" && handler.RequestHostOf(req) == host && !handler.IsProxyPath(req.URL.Path) {
			http.NotFound(w, req)
			return
		}
		next.ServeHTTP(w, req)
	})
}

// StrictTransport: cac sólo se habla por https, y el navegador lo recuerda un
// año (HSTS). Sin esto, la primera visita a `http://` se puede interceptar
// antes del salto a https y llevarse la sesión. Sin `includeSubDomains`: sólo
// estos dominios, no lo que cuelgue de guz-studio.dev.
func StrictTransport(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		next.ServeHTTP(w, req)
	})
}
