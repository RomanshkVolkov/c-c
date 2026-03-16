package handler

import (
	"encoding/json"
	"net/http"

	"github.com/guz-studio/cac/swarm-manage/internal/core/domain"
)

func send[T any](w http.ResponseWriter, status int, data T) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func ok[T any](w http.ResponseWriter, data T) {
	send(w, http.StatusOK, domain.APIResponse[T]{Success: true, Data: data})
}

func fail(w http.ResponseWriter, status int, msg string) {
	send(w, status, domain.APIResponse[any]{Success: false, Error: msg})
}
