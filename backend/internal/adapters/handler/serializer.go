package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-playground/validator/v10"
	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var validate = nuevoValidador()

// El validador, con la única regla propia que hace falta.
//
// `email` de serie rechaza la cadena vacía, y en un campo opcional que es
// puntero el vacío **significa algo**: `nil` es «no lo toques» y `""` es
// «bórralo» —así lo lee `AuthService.UpdateUser`, que sólo escribe el campo
// cuando el puntero no es nil—.
//
// Sin esta regla, `omitempty` no salvaba nada: para un `*string` mira si el
// puntero es nil, no si la cadena está vacía, así que un `{"email":""}` llegaba
// entero a la comprobación de correo y la fallaba. El efecto era que **cualquier
// usuario sin correo era imposible de editar**: la pantalla mandaba el valor que
// tenía —vacío— y el servidor contestaba «Invalid request» sin decir de qué
// campo.
func nuevoValidador() *validator.Validate {
	v := validator.New()
	if err := v.RegisterValidation("emailorblank", func(fl validator.FieldLevel) bool {
		s := fl.Field().String()
		return s == "" || v.Var(s, "email") == nil
	}); err != nil {
		// Sólo puede fallar con un nombre de etiqueta vacío, que es cosa nuestra
		// y no de una petición: mejor no arrancar que validar de mentira.
		panic(err)
	}
	return v
}

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
