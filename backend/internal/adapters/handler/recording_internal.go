package handler

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// El puerto por el que habla el mux. **No sale por el Gateway**: lo sirve un
// `http.Server` aparte en el 8081, dentro del clúster, con su propia
// `CiliumNetworkPolicy` y una llave.
//
// Que sea un puerto y no una ruta más del API público es lo que hace que un
// error de enrutado no exponga «dame la lista de grabaciones sin montar» a
// internet: no hay ninguna regla que lleve tráfico de fuera hasta aquí.

type RecordingInternalHandler interface {
	Pending(http.ResponseWriter, *http.Request)
	Claim(http.ResponseWriter, *http.Request)
	Ready(http.ResponseWriter, *http.Request)
	Failed(http.ResponseWriter, *http.Request)
}

type recordingInternalHandler struct {
	svc *service.RecordingService
	key string
}

func NewRecordingInternalHandler(svc *service.RecordingService, key string) RecordingInternalHandler {
	return &recordingInternalHandler{svc: svc, key: key}
}

// MuxKeyMiddleware exige la llave compartida.
//
// **Con la llave vacía no pasa nadie**, que es lo contrario de lo que suele
// salir por descuido: sin esta guarda, una instalación que no configuró la
// llave compararía "" con "" y dejaría entrar a cualquiera que llegase al
// puerto. Quien no la configure no debería tener el listener encendido, y por
// eso `NewInternalRouter` devuelve `nil` en ese caso — esto es el cinturón.
//
// La comparación es en tiempo constante: el tiempo que tarda un `==` en
// rendirse dice cuántos caracteres acertaste.
func MuxKeyMiddleware(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-API-Key")
			if key == "" || subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
				SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "bad-mux-key")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Pending: lo que hay que montar, con las pistas que sirven.
func (h *recordingInternalHandler) Pending(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.PendingMux(time.Now().UTC(), 10)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list", err.Error())
		return
	}
	// A diferencia de la respuesta pública, **aquí sí van las claves**: el mux
	// tiene que poder bajar los ficheros, y su credencial de IAM sólo alcanza
	// `recordings/`.
	out := make([]domain.MuxJob, 0, len(rows))
	for _, rec := range rows {
		job := domain.MuxJob{
			ID: rec.ID, OrgID: rec.OrgID, SpaceID: rec.SpaceID,
			Prefix: h.svc.Prefix(),
		}
		if rec.FirstMediaAt != nil {
			job.FirstMediaAtNs = rec.FirstMediaAt.UnixNano()
		}
		for _, t := range rec.Tracks {
			mt := domain.MuxTrack{Source: t.Source, ObjectKey: t.ObjectKey, Bytes: t.Bytes}
			if t.StartedAt != nil {
				mt.StartedAtNs = t.StartedAt.UnixNano()
			}
			if t.EndedAt != nil {
				mt.EndedAtNs = t.EndedAt.UnixNano()
			}
			job.Tracks = append(job.Tracks, mt)
		}
		job.FailedTracks = rec.FailedTracks
		out = append(out, job)
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.MuxJob]{Success: true, Data: out})
}

// Claim: 200 si se la queda, 409 si otro llegó antes.
func (h *recordingInternalHandler) Claim(w http.ResponseWriter, r *http.Request) {
	ok, err := h.svc.ClaimMux(chi.URLParam(r, "id"), time.Now().UTC())
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to claim", err.Error())
		return
	}
	if !ok {
		SendErrorResponse(w, http.StatusConflict, "Already claimed", "already-claimed")
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// Ready: el montaje está subido.
func (h *recordingInternalHandler) Ready(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ObjectKey   string `json:"objectKey"`
		ContentType string `json:"contentType"`
		Bytes       int64  `json:"bytes"`
		DurationMs  int64  `json:"durationMs"`
		HasScreen   bool   `json:"hasScreen"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ObjectKey == "" {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid body", "invalid-body")
		return
	}
	if err := h.svc.MuxReady(chi.URLParam(r, "id"), req.ObjectKey, req.ContentType,
		req.Bytes, req.DurationMs, req.HasScreen); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to close", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}

// Failed: el montaje no salió. Las pistas se conservan.
func (h *recordingInternalHandler) Failed(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := h.svc.MuxFailed(chi.URLParam(r, "id"), req.Error); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record the failure", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true})
}
