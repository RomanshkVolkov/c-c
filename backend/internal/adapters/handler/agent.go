package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"strconv"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// AgentHandler: lo que el agente de un servidor le pide al backend, y la
// identidad con la que se presenta.
type AgentHandler struct {
	servers *service.ServerService
	deploys *service.DeployService
	// El reloj, inyectable para las pruebas del latido.
	now func() time.Time
	// maxWait: cuánto se sostiene una pregunta sin trabajo. 25 s, la misma
	// cadencia que el ping del SSE: por debajo de lo que cortan los proxies.
	maxWait time.Duration
	// Cada cuánto se mira la cola mientras se sostiene la pregunta. Un segundo:
	// lo que tarda un deploy en empezar desde que se pulsa, y nada que se note.
	tick time.Duration
}

func NewAgentHandler(servers *service.ServerService, deploys *service.DeployService) *AgentHandler {
	return &AgentHandler{servers: servers, deploys: deploys, now: time.Now, maxWait: 25 * time.Second, tick: time.Second}
}

// AgentServer: el servidor autenticado por `AgentTokenMiddleware`.
func AgentServer(r *http.Request) (*domain.Server, bool) {
	s, ok := r.Context().Value(repository.AgentServerContextKey).(*domain.Server)
	return s, ok && s != nil
}

// MintToken acuña la identidad del agente. Sólo admin: reacuñar revoca la
// anterior, así que es tumbar el agente hasta que se reinstale.
func (h *AgentHandler) MintToken(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleAdmin)
	if !ok {
		return
	}
	if server.Type != domain.ServerTypeDockerSwarm {
		// El agente es el de swarm. Un servidor kubernetes se lee desde el
		// clúster del backend y no instala nada.
		SendErrorResponse(w, http.StatusBadRequest, "Only swarm servers run an agent", "agent-needs-swarm")
		return
	}
	res, err := h.servers.MintAgentToken(server.ID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to mint agent token", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.AgentTokenResponse]{Success: true, Data: res})
}

// Session firma un pase corto para hablarle al agente desde la app. Basta con
// ser de la org: ver los logs de un servicio es lo que hace un viewer.
func (h *AgentHandler) Session(w http.ResponseWriter, r *http.Request) {
	server, ok := scopeServer(w, r, h.servers, domain.OrgRoleViewer)
	if !ok {
		return
	}
	user, _ := currentUser(r)
	res, err := h.servers.AgentSession(server.ID, user.UserID, h.now())
	switch {
	case errors.Is(err, service.ErrNoAgentToken):
		SendErrorResponse(w, http.StatusConflict, "This agent has no identity yet", "agent-has-no-token")
		return
	case err != nil:
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to sign session", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.AgentSessionResponse]{Success: true, Data: res})
}

// Jobs es la pregunta del agente: «¿hay algo para mí?».
//
// Preguntar **es** el latido: cada llamada deja al servidor en línea. Sin
// trabajo, se sostiene la conexión hasta `wait` segundos (tope `maxWait`) y
// se contesta 204; el agente vuelve a preguntar. Es un long-poll y no un
// websocket porque no hace falta más: los trabajos llegan de uno en uno y un
// segundo de retraso no se nota. Mientras se sostiene se mira la cola cada
// `tick`; en cuanto hay un deploy para esta máquina, se contesta con él.
func (h *AgentHandler) Jobs(w http.ResponseWriter, r *http.Request) {
	server, ok := AgentServer(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-agent")
		return
	}
	// La versión que dice el agente; uno de antes de decirla cuenta como 0.
	version, _ := strconv.Atoi(r.Header.Get("X-Agent-Version"))
	if err := h.servers.Heartbeat(server.ID, version, h.now()); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to record heartbeat", err.Error())
		return
	}
	wait := h.maxWait
	if s, err := strconv.Atoi(r.URL.Query().Get("wait")); err == nil && s >= 0 {
		if d := time.Duration(s) * time.Second; d < wait {
			wait = d
		}
	}
	if wait > 0 {
		// El servidor corta toda respuesta a los 15 s (`WriteTimeout` en
		// cmd/main.go), y esta se sostiene hasta 25: sin mover el plazo, cada
		// pregunta moría a medias y el agente la contaba como un fallo, con su
		// backoff. Se mueve lo justo —lo que se sostiene más un margen—, no se
		// quita: una conexión sin plazo es la que se queda colgada para siempre.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(wait + 10*time.Second)); err != nil {
			SendErrorResponse(w, http.StatusInternalServerError, "Cannot hold the poll", err.Error())
			return
		}
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	tick := time.NewTicker(h.tick)
	defer tick.Stop()
	for {
		if h.deploys != nil {
			job, err := h.deploys.Claim(server.ID)
			if err != nil {
				SendErrorResponse(w, http.StatusInternalServerError, "Failed to claim a job", err.Error())
				return
			}
			if job != nil {
				SendResult(w, http.StatusOK, job)
				return
			}
		}
		select {
		case <-deadline.C:
			w.WriteHeader(http.StatusNoContent)
			return
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

// JobLog: el agente cuenta por dónde va. Sólo de un deploy en curso **de su
// máquina**: con el id de otro servidor, 409, como si no existiera.
func (h *AgentHandler) JobLog(w http.ResponseWriter, r *http.Request) {
	server, ok := AgentServer(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-agent")
		return
	}
	req, err := ValidateRequest[domain.AgentLogRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.deploys.AppendLog(server.ID, chi.URLParam(r, "jid"), req.Lines); err != nil {
		agentJobError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// JobFinish: el agente dice cómo acabó.
func (h *AgentHandler) JobFinish(w http.ResponseWriter, r *http.Request) {
	server, ok := AgentServer(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-agent")
		return
	}
	req, err := ValidateRequest[domain.AgentFinishRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.deploys.Finish(server.ID, chi.URLParam(r, "jid"), req); err != nil {
		agentJobError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func agentJobError(w http.ResponseWriter, err error) {
	if errors.Is(err, repository.ErrDeployNotRunning) {
		SendErrorResponse(w, http.StatusConflict, "That job is not running here", "deploy-not-running")
		return
	}
	SendErrorResponse(w, http.StatusInternalServerError, "Failed to record", err.Error())
}
