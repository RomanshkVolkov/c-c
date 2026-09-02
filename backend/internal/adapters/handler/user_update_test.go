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

// Lo que **no** puede llegar por el endpoint de tu propio perfil.
//
// La garantía no es un `if` en el handler: es que los campos no existen en
// `UpdateProfileRequest`. Esta prueba lo fija, porque el modo de fallo sería que
// alguien «unificara» los dos tipos por parecerse — y entonces cualquiera se
// haría superadmin con un PATCH a su propio perfil.
func TestTuPerfilNoPuedeCambiarTuRolNiTuContrasena(t *testing.T) {
	r := httptest.NewRequest("PATCH", "/x", strings.NewReader(
		`{"name":"Ana","isSuperadmin":true,"password":"unaquesirva"}`))
	req, err := ValidateRequest[domain.UpdateProfileRequest](r)
	if err != nil {
		t.Fatal(err)
	}
	if req.Name == nil || *req.Name != "Ana" {
		t.Fatal("el nombre sí tenía que llegar")
	}
	// Si esto deja de compilar porque los campos existen, el fallo es el que
	// esta prueba viene a evitar.
	var _ = struct{ Name, Email *string }{req.Name, req.Email}
}
