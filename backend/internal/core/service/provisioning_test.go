package service

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Del log de una ejecución se guarda el final: de una fallida lo que se lee es
// cómo acabó, y lo de arriba es la instalación de paquetes.
func TestTheLogTailKeepsTheEnd(t *testing.T) {
	var lineas []string
	for i := 1; i <= 500; i++ {
		lineas = append(lineas, "línea "+strings.Repeat("x", i%7))
	}
	lineas[len(lineas)-1] = "PLAY RECAP"
	got := boundTail(strings.Join(lineas, "\n"), 200, 64<<10)

	partes := strings.Split(got, "\n")
	if len(partes) != 200 {
		t.Fatalf("se quedaron %d líneas, se esperaban 200", len(partes))
	}
	if partes[len(partes)-1] != "PLAY RECAP" {
		t.Errorf("se perdió el final: termina en %q", partes[len(partes)-1])
	}
}

// Y por bytes también, sin partir un carácter: Postgres rechaza texto UTF-8
// inválido y se perdería la fila entera.
func TestTheLogTailNeverSplitsACharacter(t *testing.T) {
	s := strings.Repeat("ñ", 100) // 200 bytes
	got := boundTail(s, 1000, 51) // 51 cae a mitad de una «ñ»
	if !utf8.ValidString(got) {
		t.Fatalf("quedó UTF-8 inválido: %q", got)
	}
	if len(got) > 51 || !strings.HasSuffix(s, got) {
		t.Errorf("no es el final de lo que había, o se pasó del tope: %d bytes", len(got))
	}
}

// Una ejecución no lleva ningún valor, sólo nombres.
//
// La garantía es que los campos **no existen**, no un `if` que los descarte: el
// día que alguien añada `Vars map[string]string` «para depurar», esto se cae.
// Una contraseña de sudo o un secret resuelto de 1Password no pueden llegar a la
// base porque no tienen dónde ponerse.
func TestProvisioningCarriesNoValues(t *testing.T) {
	prohibidos := []string{"value", "values", "secret", "secrets", "vars", "password", "token"}
	for _, tipo := range []reflect.Type{
		reflect.TypeOf(domain.ProvisioningRun{}),
		reflect.TypeOf(domain.StartProvisioningRequest{}),
		reflect.TypeOf(domain.FinishProvisioningRequest{}),
	} {
		for i := 0; i < tipo.NumField(); i++ {
			f := tipo.Field(i)
			nombre := strings.ToLower(f.Name)
			json := strings.ToLower(strings.Split(f.Tag.Get("json"), ",")[0])
			for _, p := range prohibidos {
				if nombre == p || json == p {
					t.Errorf("%s.%s: una ejecución de provisioning no puede llevar valores", tipo.Name(), f.Name)
				}
			}
		}
	}
}
