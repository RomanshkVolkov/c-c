package handler

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Qué cuerpos acepta editar un usuario.
//
// El que importa es el del correo vacío. `AuthService.UpdateUser` escribe el
// campo cuando el puntero no es nil, así que `""` significa «bórralo» — y el
// validador lo rechazaba, con lo que **cualquier usuario sin correo era
// imposible de editar**: la pantalla mandaba el valor que tenía —vacío— y el
// servidor contestaba «Invalid request» sin decir de qué campo.
//
// Se prueba aquí y no en la pantalla porque el agujero es del contrato: el mismo
// muro se lo come el MCP, un script, o cualquier otro cliente.
func TestEditarUnUsuario(t *testing.T) {
	casos := []struct {
		nombre string
		cuerpo string
		vale   bool
	}{
		{"con correo", `{"name":"Ana","email":"a@b.com"}`, true},
		{"sin el campo, que es «no lo toques»", `{"name":"Ana"}`, true},
		// El caso que estaba roto.
		{"correo vacío, que es «bórralo»", `{"name":"Ana","email":""}`, true},
		// Y lo que sigue teniendo que fallar, o la regla nueva se habría comido
		// la comprobación entera.
		{"un correo que no lo es", `{"name":"Ana","email":"no-soy-un-correo"}`, false},
		{"una contraseña corta", `{"password":"corta"}`, false},
	}

	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			r := httptest.NewRequest("PATCH", "/x", strings.NewReader(c.cuerpo))
			_, err := ValidateRequest[domain.UpdateUserRequest](r)
			if c.vale && err != nil {
				t.Fatalf("debía aceptarse y dio: %v", err)
			}
			if !c.vale && err == nil {
				t.Fatal("debía rechazarse y pasó")
			}
		})
	}
}

// El vacío se traduce en «bórralo» de verdad, no sólo en «se acepta».
func TestElCorreoVacioLlegaComoPunteroNoNil(t *testing.T) {
	r := httptest.NewRequest("PATCH", "/x", strings.NewReader(`{"email":""}`))
	req, err := ValidateRequest[domain.UpdateUserRequest](r)
	if err != nil {
		t.Fatal(err)
	}
	if req.Email == nil {
		t.Fatal("llegó nil: el servicio lo leería como «no lo toques» y no borraría nada")
	}
	if *req.Email != "" {
		t.Fatalf("llegó %q", *req.Email)
	}
}
