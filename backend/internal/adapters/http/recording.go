package http

import (
	"context"
	"net/http"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// Diez segundos, y **siempre**.
//
// Es el retraso máximo con el que empieza a grabarse quien entra a la llamada
// tarde, y treinta se llevaría un «hola, ¿me oyes?» entero. Con treinta también
// tardaría un minuto en pararse una sala vacía —hacen falta dos ticks— y eso es
// un minuto de silencio guardado.
//
// Sin grabaciones vivas el tick es un `SELECT` sobre un índice que no devuelve
// nada. Vale la pena.
const recordingTick = 10 * time.Second

// InitRecordingRoutes monta las rutas de grabación y arranca su reloj.
func InitRecordingRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) {
	// El mismo bucket privado que las capturas y los adjuntos. Aquí sólo se
	// comprueba que existe: quien escribe las pistas es Egress con su propia
	// credencial, que **sólo puede escribir bajo `recordings/`**.
	store, err := mediastore.New(
		context.Background(),
		repository.GetEnv("REPORTS_MEDIA_BUCKET", ""),
		repository.GetEnv("REPORTS_MEDIA_REGION", ""),
		repository.GetEnv("REPORTS_MEDIA_ACCESS_KEY_ID", ""),
		repository.GetEnv("REPORTS_MEDIA_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("recording store init failed: " + err.Error())
	}
	lk := lkclient.New(
		repository.GetEnv("LIVEKIT_URL", ""),
		repository.GetEnv("LIVEKIT_API_KEY", ""),
		repository.GetEnv("LIVEKIT_API_SECRET", ""),
	)
	svc := service.NewRecordingService(
		repository.NewRecordingRepository(db), lk, hub, store,
		repository.GetEnv("RECORDINGS_PREFIX", domain.RecordingPrefixDefault),
		repository.GetEnv("RECORDINGS_ENABLED", "false") == "true",
		atoiOr(repository.GetEnv("RECORDINGS_MAX_MINUTES", "240"), 240),
	).WithAnnouncer(
		// El canal del espacio, para contar ahí que la grabación quedó lista.
		// Se construye uno propio en vez de compartir el de `InitTaskRoutes`
		// —igual que `InitMeetingRoutes` se construye su buzón— porque el
		// servicio no tiene estado: es un repositorio y dos colaboradores.
		//
		// **Con el buzón puesto**, que es la mitad de lo que esto viene a
		// arreglar: sin él la línea aparecería en el canal y no avisaría a
		// nadie, que es exactamente el problema de partida.
		service.NewChatService(repository.NewChatRepository(db), hub).
			WithNotifier(service.NewNotificationService(repository.NewNotificationRepository(db))),
	)
	h := handler.NewRecordingHandler(svc, repository.NewTaskRepository(db))

	r.Route("/api/v1/task-spaces/{id}/recordings", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		// La política va primero en el fichero y en la cabeza: es lo que la app
		// pregunta antes de decidir si el botón existe.
		r.Get("/policy", h.Policy)
		r.Get("/", h.List)
		r.Post("/", h.Start)
	})
	r.Route("/api/v1/recordings/{id}", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Get)
		r.Post("/stop", h.Stop)
		r.Delete("/", h.Delete)
	})
	// Fuera del grupo del JWT: un `<video src>` de un webview no manda
	// cabeceras, así que este autoriza por `?token=` igual que el proxy de los
	// adjuntos. Ver `handler.Media`.
	r.Get("/api/v1/recordings/{id}/media", h.Media)

	startRecordingClock(svc)
	buildInternalRouter(svc)
}

// El listener interno, para el mux. `nil` si no hay llave.
//
// Se guarda aquí y lo sirve `main.go` en su propio `http.Server`, porque **no
// puede compartir el del API público**: ése está detrás del Gateway, y una ruta
// más en él sería una ruta alcanzable desde internet con sólo una cabecera.
// Un puerto aparte es una frontera que no depende de acertar con el enrutado.
var internalRouter http.Handler

func buildInternalRouter(svc *service.RecordingService) {
	llave := repository.GetEnv("RECORDINGS_MUX_KEY", "")
	if llave == "" || !svc.Enabled() {
		// Sin llave, el listener **no se enciende**. Es lo contrario de lo que
		// sale por descuido: con la llave vacía, una comparación ingenua
		// dejaría entrar a cualquiera que llegue al puerto.
		return
	}
	h := handler.NewRecordingInternalHandler(svc, llave)
	r := chi.NewRouter()
	r.Route("/internal/v1/recordings", func(r chi.Router) {
		r.Use(handler.MuxKeyMiddleware(llave))
		r.Get("/pending-mux", h.Pending)
		r.Post("/{id}/claim", h.Claim)
		r.Post("/{id}/ready", h.Ready)
		r.Post("/{id}/failed", h.Failed)
	})
	internalRouter = r
}

// InternalRouter es lo que `main.go` sirve en el puerto interno, o `nil` si
// esta instalación no tiene mux.
func InternalRouter() http.Handler { return internalRouter }

// startRecordingClock: lo mismo que el de reuniones, y por lo mismo.
//
// Se apaga con el servidor —timbrar o arrancar egress mientras el pod se cierra
// no es inocuo— y corre en las dos réplicas a la vez: quién se queda cada
// grabación lo decide la base con `ClaimTick`, no este bucle.
func startRecordingClock(svc *service.RecordingService) {
	if !svc.Enabled() {
		// Sin grabación configurada no hay nada que reconciliar, y una
		// goroutine que despierta cada diez segundos para no hacer nada es una
		// goroutine que alguien acabará persiguiendo en un perfil.
		return
	}
	ctx, parar := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer parar()
		ticker := time.NewTicker(recordingTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				svc.Tick(ctx, time.Now().UTC())
			}
		}
	}()
}

func atoiOr(s string, fallback int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
