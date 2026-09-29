package handler

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Qué cuerpos acepta crear un usuario.
//
// Correo y nombre son obligatorios al crear, y al revés que al editar: aquí el
// vacío no significa «bórralo», significa que falta. Se prueba en el contrato y
// no en la pantalla porque el MCP o un script llegan por el mismo sitio.
func TestCreatingAUser(t *testing.T) {
	cases := []struct {
		name string
		body string
		ok   bool
	}{
		{"complete", `{"username":"ana","password":"12345678","name":"Ana","email":"a@b.com"}`, true},
		{"without email", `{"username":"ana","password":"12345678","name":"Ana"}`, false},
		{"empty email", `{"username":"ana","password":"12345678","name":"Ana","email":""}`, false},
		{"an email that is not one", `{"username":"ana","password":"12345678","name":"Ana","email":"nope"}`, false},
		{"without name", `{"username":"ana","password":"12345678","email":"a@b.com"}`, false},
		// `required` lo dejaría pasar: por eso el nombre lleva `notblank`.
		{"a name of spaces", `{"username":"ana","password":"12345678","name":"   ","email":"a@b.com"}`, false},
		{"a short password", `{"username":"ana","password":"1234567","name":"Ana","email":"a@b.com"}`, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/x", strings.NewReader(c.body))
			_, err := ValidateRequest[domain.CreateUserRequest](r)
			if c.ok && err != nil {
				t.Fatalf("debía aceptarse y dio: %v", err)
			}
			if !c.ok && err == nil {
				t.Fatal("debía rechazarse y pasó")
			}
		})
	}
}
