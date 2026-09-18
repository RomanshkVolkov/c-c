package handler

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	awshttp "github.com/aws/smithy-go/transport/http"
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
	Media(http.ResponseWriter, *http.Request)
	Delete(http.ResponseWriter, *http.Request)
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

// Media sirve el fichero montado, entero o por trozos.
//
// Fuera del grupo del JWT porque un `<video src>` de un webview **no puede
// mandar cabeceras**: la entrada va por `?token=`, como el proxy de los
// adjuntos y el de las capturas. Y por aquí y no por una URL firmada del
// bucket: una URL firmada que se escapa de una pantalla sigue valiendo hasta
// que caduca, y esto es una reunión entera.
func (h *recordingHandler) Media(w http.ResponseWriter, r *http.Request) {
	rec, err := h.svc.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		// 404 y no 403: quien no pertenece a la organización no tiene por qué
		// enterarse de que esa grabación existe.
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	if !attachmentViewer(r, rec.OrgID) {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}

	obj, err := h.svc.Media(r.Context(), rec, r.Header.Get("Range"))
	if err != nil {
		if errors.Is(err, service.ErrNoMedia) {
			// 409 y no 404: la grabación existe y todavía se está montando.
			// «No encontrado» mandaría a alguien a buscar un fallo que no hay.
			SendErrorResponse(w, http.StatusConflict,
				"This recording is still being processed", "recording-not-ready")
			return
		}
		if isRangeError(err) {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(rec.FinalBytes, 10))
			SendErrorResponse(w, http.StatusRequestedRangeNotSatisfiable,
				"Bad range", "bad-range")
			return
		}
		SendErrorResponse(w, http.StatusBadGateway, "Failed to read the recording", err.Error())
		return
	}
	defer obj.Body.Close()

	// **Sin plazo de escritura.** El servidor tiene `WriteTimeout: 15s`, que
	// está bien para un JSON y corta en seco cualquier vídeo que tarde más de
	// quince segundos en transferirse — o sea, todos. Es el mismo arreglo que
	// necesitó el SSE, y se ve como una descarga que se interrumpe siempre en
	// el mismo punto.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	ct := obj.ContentType
	if ct == "" {
		ct = rec.FinalContentType
	}
	w.Header().Set("Content-Type", ct)
	// Sin esto el navegador no ofrece arrastrar la barra: `Accept-Ranges` es
	// cómo se entera de que puede pedir trozos.
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
	// Una grabación de una reunión no se queda en la caché de nadie.
	w.Header().Set("Cache-Control", "private, no-store")

	status := http.StatusOK
	if obj.ContentRange != "" {
		w.Header().Set("Content-Range", obj.ContentRange)
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	_, _ = io.Copy(w, obj.Body)
}

// Delete borra la grabación y sus ficheros. Quien la empezó, o un admin.
func (h *recordingHandler) Delete(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.recording(w, r, true)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	role, _ := user.RoleInOrg(rec.OrgID)
	if rec.StartedBy != user.UserID && !user.Superadmin && role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden,
			"Only whoever started this recording, or an admin, can delete it",
			"not-the-recorder")
		return
	}
	if err := h.svc.Delete(r.Context(), rec); err != nil {
		// 502 y **la fila no se borra**: si S3 falló, quedarían ficheros en el
		// bucket sin nadie que sepa que existen. Se puede reintentar.
		SendErrorResponse(w, http.StatusBadGateway, "Failed to delete the media", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// isRangeError reconoce el «ese trozo no existe» de S3.
//
// Por el código del error y no por el texto, que cambia con la versión del SDK.
func isRangeError(err error) bool {
	var re *awshttp.ResponseError
	if errors.As(err, &re) {
		return re.HTTPStatusCode() == http.StatusRequestedRangeNotSatisfiable
	}
	return strings.Contains(err.Error(), "InvalidRange")
}
