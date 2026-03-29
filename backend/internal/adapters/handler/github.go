package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type GitHubHandler struct {
	svc *service.GitHubService
}

func NewGitHubHandler(svc *service.GitHubService) *GitHubHandler {
	return &GitHubHandler{svc: svc}
}

func (h *GitHubHandler) SetToken(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	req, err := ValidateRequest[domain.SetGitHubTokenRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}
	if err := h.svc.SetToken(serverID, req.Token); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to store token", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Token stored"})
}

func (h *GitHubHandler) DeleteToken(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	_ = h.svc.DeleteToken(serverID) // best-effort
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Token removed"})
}

func (h *GitHubHandler) TokenStatus(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	status := h.svc.TokenStatus(serverID)
	SendResult(w, http.StatusOK, domain.APIResponse[domain.GitHubTokenStatus]{Success: true, Data: status})
}

func (h *GitHubHandler) ListSecrets(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")

	secrets, err := h.svc.ListSecrets(serverID, owner, repo)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list secrets", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GitHubSecretsResponse]{Success: true, Data: secrets})
}

func (h *GitHubHandler) ListVariables(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")

	vars, err := h.svc.ListVariables(serverID, owner, repo)
	if err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to list variables", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[*domain.GitHubVariablesResponse]{Success: true, Data: vars})
}

func (h *GitHubHandler) SetSecret(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	name := chi.URLParam(r, "name")

	req, err := ValidateRequest[domain.SetSecretRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	if err := h.svc.SetSecret(serverID, owner, repo, name, req.Value); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to set secret", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Secret saved"})
}

func (h *GitHubHandler) DeleteSecret(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	name := chi.URLParam(r, "name")

	if err := h.svc.DeleteSecret(serverID, owner, repo, name); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete secret", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Secret deleted"})
}

func (h *GitHubHandler) DeleteVariable(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	name := chi.URLParam(r, "name")

	if err := h.svc.DeleteVariable(serverID, owner, repo, name); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to delete variable", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Variable deleted"})
}

func (h *GitHubHandler) SetVariable(w http.ResponseWriter, r *http.Request) {
	serverID := chi.URLParam(r, "id")
	owner := chi.URLParam(r, "owner")
	repo := chi.URLParam(r, "repo")
	name := chi.URLParam(r, "name")

	req, err := ValidateRequest[domain.SetVariableRequest](r)
	if err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid request", err.Error())
		return
	}

	if err := h.svc.SetVariable(serverID, owner, repo, name, req.Value, req.Exists); err != nil {
		SendErrorResponse(w, http.StatusInternalServerError, "Failed to set variable", err.Error())
		return
	}
	SendResult(w, http.StatusOK, domain.APIResponse[any]{Success: true, Message: "Variable saved"})
}
