package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-playground/validator/v10"
	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var validate = validator.New()

func SendResult[T any](w http.ResponseWriter, status int, data T) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func SendErrorResponse(w http.ResponseWriter, status int, message, errDetail string) {
	SendResult(w, status, domain.APIResponse[any]{
		Success: false,
		Message: message,
		Error:   errDetail,
	})
}

func ValidateRequest[T any](r *http.Request) (T, error) {
	var body T
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return body, err
	}
	if err := validate.Struct(body); err != nil {
		return body, err
	}
	return body, nil
}
