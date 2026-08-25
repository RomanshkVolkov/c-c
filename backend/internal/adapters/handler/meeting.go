package handler

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type MeetingHandler interface {
	List(w http.ResponseWriter, r *http.Request)
	Agenda(w http.ResponseWriter, r *http.Request)
	Create(w http.ResponseWriter, r *http.Request)
	Update(w http.ResponseWriter, r *http.Request)
	Delete(w http.ResponseWriter, r *http.Request)
	SetRecipients(w http.ResponseWriter, r *http.Request)
}

type meetingHandler struct {
	svc  *service.MeetingService
	orgs *service.OrganizationService
}

func NewMeetingHandler(svc *service.MeetingService, orgs *service.OrganizationService) MeetingHandler {
	return &meetingHandler{svc: svc, orgs: orgs}
}

func mapMeetingError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, repository.ErrMeetingNotFound):
		SendErrorResponse(w, http.StatusNotFound, "Meeting not found", err.Error())
	// 400 y no 500: la regla que mandaron no describe ninguna reunión posible, y
	// el mensaje tiene que decir cuál de las tres cosas está mal.
	case errors.Is(err, service.ErrBadWallTime):
		SendErrorResponse(w, http.StatusBadRequest,
			"The time of day must look like 09:00.", "bad-wall-time")
	case errors.Is(err, service.ErrBadTimezone):
		SendErrorResponse(w, http.StatusBadRequest,
			"That time zone doesn't exist. It should look like America/Mexico_City.", "bad-timezone")
	case errors.Is(err, service.ErrBadFreq):
		SendErrorResponse(w, http.StatusBadRequest,
			"A meeting repeats daily, weekly or monthly.", "bad-freq")
	case errors.Is(err, service.ErrNoWeekdays):
		SendErrorResponse(w, http.StatusBadRequest,
			"A weekly meeting needs at least one weekday, or it would never come round.",
			"no-weekdays")
	case errors.Is(err, service.ErrMeetingNoSpace):
		SendErrorResponse(w, http.StatusConflict,
			"That room belongs to another organization.", "meeting-other-org")
	default:
		return false
	}
	return true
}

// admin resuelve la organización y exige el rol.
//
// Crear una reunión le suena a todo el mundo a la hora que diga quien la crea,
// así que es de quien administra — no de cualquiera que pueda escribir.
func (h *meetingHandler) admin(w http.ResponseWriter, r *http.Request, orgID string) bool {
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return false
	}
	role, member := user.RoleInOrg(orgID)
	if user.Superadmin {
		role, member = domain.OrgRoleAdmin, true
	}
	if !member {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return false
	}
	if role != domain.OrgRoleAdmin {
		SendErrorResponse(w, http.StatusForbidden, "Forbidden", "not-an-admin")
		return false
	}
	return true
}

// deLaReunion carga una reunión y comprueba que quien llama administre su
// organización. El id de la organización no viaja en estas rutas: se deduce de
// la reunión, que es la única fuente que no puede falsear el cliente.
func (h *meetingHandler) deLaReunion(w http.ResponseWriter, r *http.Request) (*domain.MeetingReminder, bool) {
	m, err := h.svc.Find(chi.URLParam(r, "id"))
	if err != nil {
		if !mapMeetingError(w, err) {
			SendErrorResponse(w, http.StatusInternalServerError, "Failed to load the meeting", err.Error())
		}
		return nil, false
	}
	if !h.admin(w, r, m.OrgID) {
		return nil, false
	}
	return m, true
}

func (h *meetingHandler) List(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if _, member := user.RoleInOrg(orgID); !member && !user.Superadmin {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	out, err := h.svc.List(orgID)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list meetings", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.MeetingResponse]{Success: true, Data: out})
}

// Agenda: las ocurrencias concretas de una ventana, para el calendario.
//
// Las expande el servidor y no la app: la regla —con sus dos cambios de hora al
// año— tiene una sola implementación, y es la que ya está probada.
func (h *meetingHandler) Agenda(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	user, ok := currentUser(r)
	if !ok {
		SendErrorResponse(w, http.StatusUnauthorized, "Unauthorized", "no-claims")
		return
	}
	if _, member := user.RoleInOrg(orgID); !member && !user.Superadmin {
		SendErrorResponse(w, http.StatusNotFound, "Not found", "not-found")
		return
	}
	dias, _ := strconv.Atoi(r.URL.Query().Get("days"))
	out, err := h.svc.Agenda(orgID, time.Now(), dias)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to build the agenda", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[[]domain.MeetingOccurrence]{Success: true, Data: out})
}

func (h *meetingHandler) Create(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	if !h.admin(w, r, orgID) {
		return
	}
	req, err := ValidateRequest[domain.CreateMeetingRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	user, _ := currentUser(r)
	m, err := h.svc.Create(orgID, user.UserID, req)
	if err != nil {
		if mapMeetingError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to create the meeting", err.Error())
		return
	}
	SendResult(w, http.StatusCreated, domain.APIResponse[*domain.MeetingReminder]{Success: true, Data: m})
}

func (h *meetingHandler) Update(w http.ResponseWriter, r *http.Request) {
	m, ok := h.deLaReunion(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.UpdateMeetingRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	actualizada, err := h.svc.Update(m.ID, req)
	if err != nil {
		if mapMeetingError(w, err) {
			return
		}
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to update the meeting", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.MeetingReminder]{Success: true, Data: actualizada})
}

func (h *meetingHandler) Delete(w http.ResponseWriter, r *http.Request) {
	m, ok := h.deLaReunion(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(m.ID); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete the meeting", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Meeting deleted"})
}

// SetRecipients reemplaza la lista de excluidos: quién **no** recibe el aviso.
func (h *meetingHandler) SetRecipients(w http.ResponseWriter, r *http.Request) {
	m, ok := h.deLaReunion(w, r)
	if !ok {
		return
	}
	req, err := ValidateRequest[domain.MeetingRecipientsRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.SetExcluded(m.ID, req.ExcludedUserIDs); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to save the recipients", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Recipients saved"})
}
