package domain

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// Lo que un commit o una PR puede nombrar. La regla: `cac#N` siempre; `#N` a
// secas sólo si el repo lo pide, porque en GitHub `#N` es su propio issue; y el
// folio del cliente (`acme-7`) por su slug. Nada más, y nunca de más.
func TestExtractTaskRefs(t *testing.T) {
	cases := []struct {
		name string
		text string
		bare bool
		want []TaskRef
	}{
		{"cac#N siempre", "fix: el login (cac#12)", false, []TaskRef{{Seq: 12}}},
		{"en mayúsculas también", "CAC#7 listo", false, []TaskRef{{Seq: 7}}},
		{"#N a secas, apagado", "closes #12", false, nil},
		{"#N a secas, encendido", "closes #12", true, []TaskRef{{Seq: 12}}},
		{"#N pegado a una palabra no es nada", "abc#12 y repo/x#3", true, nil},
		{"cac#N no cuenta dos veces con #N encendido", "cac#5", true, []TaskRef{{Seq: 5}}},
		{"un folio por su slug", "arregla beta-api-7", false, []TaskRef{{Slug: "beta-api", Seq: 7}}},
		{"sin repetir, en orden", "cac#3 cac#1 cac#3", false, []TaskRef{{Seq: 3}, {Seq: 1}}},
		{"el cero no es una tarea", "cac#0", false, nil},
		{"nada", "refactor sin tarea", false, nil},
		{"un #N dentro de un enlace a otro repo no cuenta", "ver https://github.com/a/b/pull/9#12", true, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ExtractTaskRefs(c.text, c.bare)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("ExtractTaskRefs(%q, %v) = %+v, se esperaba %+v", c.text, c.bare, got, c.want)
			}
		})
	}
}

// Un texto no puede convertirse en cien búsquedas.
func TestATextNamesAtMostTenTasks(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 50; i++ {
		fmt.Fprintf(&b, "cac#%d ", i)
	}
	if got := ExtractTaskRefs(b.String(), false); len(got) != MaxTaskRefs {
		t.Errorf("%d referencias, el tope es %d", len(got), MaxTaskRefs)
	}
}
