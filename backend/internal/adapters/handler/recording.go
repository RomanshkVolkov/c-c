package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// RecordingHandler: los botones de grabar, parar y ver.
type RecordingHandler interface {
	Policy(http.ResponseWriter, *http.Request)
	Start(http.ResponseWriter, *http.Request)
	Stop(http.ResponseWriter, *http.Request)
	List(http.ResponseWriter, *http.Request)
	Get(http.ResponseWriter, *http.Request)
}

// SpaceFinder es lo único que este handler necesita del módulo de tareas:
// traducir un id de espacio a su organización. Una interfaz de un método en vez
// del `TaskService` entero, que arrastra reportes, organizaciones y el hub para
// contestar algo que sale de una fila.
type SpaceFinder interface {
	FindSpace(id string) (*domain.TaskSpace, error)
}

type recordingHandler struct {
	svc    *service.RecordingService
	spaces SpaceFinder
}

func NewRecordingHandler(svc *service.RecordingService, spaces SpaceFinder) RecordingHandler {
	return &recordingHandler{svc: svc, spaces: spaces}
}

// space resuelve el espacio y comprueba la pertenencia.
//
// **Autoriza antes de mirar si la grabación está encendida**, y ese orden es la
// parte que importa: al revés, un 503 le confirmaría a quien no pertenece a la
// organización que ese espacio existe.
func (h *recordingHandler) space(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.TaskSpace, bool) {
	sp, err := h.spaces.FindSpace(chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, repository.ErrSpaceNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return nil, false
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load space", err.Error())
		return nil, false
	}
	if _, ok := authorizeOrg(w, r, sp.OrgID, needWrite); !ok {
		return nil, false
	}
	return sp, true
}

// enabled contesta 503 si esta instalación no graba. Después de autorizar, y
// **sólo en lo que escribe**: una instalación a la que se le apagó la grabación
// sigue pudiendo enseñar lo que ya grabó. Devolver 503 al listado escondería
// material que existe y que alguien puede necesitar.
func (h *recordingHandler) enabled(w http.ResponseWriter) bool {
	if h.svc.Enabled() {
		return true
	}
	SendErrorResponse(w, http.StatusServiceUnavailable,
		"Recording is not enabled on this server", "recordings-disabled")
	return false
}

// Policy es lo que la app pregunta antes de pintar el botón.
//
// Nunca 503: devuelve `{enabled:false}` y la app esconde el botón. Un error
// aquí obligaría a la pantalla a distinguir «no está montado» de «se cayó», que
// es justo lo que este endpoint viene a evitar.
func (h *recordingHandler) Policy(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.space(w, r, false)
	if !ok {
		return
	}
	pol, err := h.svc.Policy(sp.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to read the policy", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.RecordingPolicy]{Success: true, Data: pol})
}

// Start empieza a grabar. Cualquier miembro que escriba puede — se decidió así:
// grabar no es una operación de administración, y el consentimiento se resuelve
// avisando a la sala, no repartiendo permisos.
func (h *recordingHandler) Start(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.space(w, r, true)
	if !ok || !h.enabled(w) {
		return
	}
	user, _ := currentUser(r)
	rec, err := h.svc.Start(r.Context(), sp.OrgID, sp.ID, user.UserID)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrAlreadyRecording):
			// 409 y no 400: la petición está bien, lo que pasa es que otro
			// pulsó primero. La app reléé la política y enseña el chip.
			SendErrorResponse(w, http.StatusConflict,
				"This call is already being recorded", "already-recording")
		case errors.Is(err, service.ErrRoomEmpty):
			SendErrorResponse(w, http.StatusConflict,
				"There is nobody in this call", "room-empty")
		case errors.Is(err, service.ErrRecordingsDisabled):
			SendErrorResponse(w, http.StatusServiceUnavailable,
				"Recording is not enabled on this server", "recordings-disabled")
		default:
			SendErrorResponse(w, http.StatusBadGateway, "Failed to start recording", err.Error())
		}
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.Recording]{Success: true, Data: rec})
}

// Stop para la grabación. Idempotente: pararla dos veces contesta 200 las dos.
func (h *recordingHandler) Stop(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.recording(w, r, true)
	if !ok || !h.enabled(w) {
		return
	}
	if err := h.svc.Stop(r.Context(), rec, "user"); err != nil {
		SendErrorResponse(w, http.StatusBadGateway, "Failed to stop recording", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.Recording]{Success: true, Data: rec})
}

func (h *recordingHandler) List(w http.ResponseWriter, r *http.Request) {
	sp, ok := h.space(w, r, false)
	if !ok {
		return
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 30)
	if limit > 100 {
		limit = 100
	}
	var before *time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			before = &t
		}
	}
	rows, err := h.svc.List(sp.ID, limit, before)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list recordings", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.RecordingResponse]{Success: true, Data: rows})
}

func (h *recordingHandler) Get(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.recording(w, r, false)
	if !ok {
		return
	}
	out, err := h.svc.Get(rec.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the recording", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.RecordingResponse]{Success: true, Data: out})
}

// recording resuelve una grabación por su id y comprueba la pertenencia **a la
// organización de la grabación**, no a la que diga quien pregunta.
func (h *recordingHandler) recording(w http.ResponseWriter, r *http.Request, needWrite bool) (*domain.Recording, bool) {
	rec, err := h.svc.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, repository.ErrRecordingNotFound) {
			SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
			return nil, false
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the recording", err.Error())
		return nil, false
	}
	if _, ok := authorizeOrg(w, r, rec.OrgID, needWrite); !ok {
		return nil, false
	}
	return rec, true
}
