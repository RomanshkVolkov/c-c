package domain

import (
	"strings"
	"testing"
)

// cac#203. Roturas que detecta, por caso: dejar acentos o mayúsculas; no
// pasar a kebab-case; dejar un trozo que empieza por número (`proyecto-2026`
// se leería como la tarea 2026 de `proyecto`); pasarse de largo; quedarse
// vacía.
func TestASpaceKeyComesFromItsName(t *testing.T) {
	for name, want := range map[string]string{
		"Proteus":                     "proteus",
		"Command and control":         "command-and-control",
		"Dwit México":                 "dwit-mexico",
		"dr_iñigo":                    "dr-inigo",
		"multi tenant frond end":      "multi-tenant-frond-end",
		"Proyecto 2026":               "proyecto",
		"App móvil (tds-geolocation)": "app-movil-tds-geolocation",
		"3D studio":                   "studio",
		"2026":                        "space",
		"":                            "space",
	} {
		if got := SpaceKeyFrom(name); got != want {
			t.Errorf("SpaceKeyFrom(%q) = %q, quería %q", name, got, want)
		}
	}
	if got := SpaceKeyFrom(strings.Repeat("palabra ", 30)); len(got) > MaxSpaceKey || !ValidSpaceKey(got) {
		t.Errorf("larga: %q", got)
	}
}

// Roturas que detecta: aceptar a mano una clave que no saldría del nombre
// (mayúsculas, trozo numérico, guiones de más), o `cac`, que ya es el prefijo
// de las referencias por número.
func TestOnlyAWellFormedKeyIsAccepted(t *testing.T) {
	for _, ok := range []string{"proteus", "dwit-mexico", "app2", "a-b2"} {
		if !ValidSpaceKey(ok) {
			t.Errorf("%q tenía que valer", ok)
		}
	}
	for _, bad := range []string{"", "Proteus", "proyecto-2026", "a--b", "-a", "a-", "cac", "ñu", "a_b", strings.Repeat("a", 61)} {
		if ValidSpaceKey(bad) {
			t.Errorf("%q no tenía que valer", bad)
		}
	}
}

// Roturas que detecta: repetir una clave tomada, resolver un choque con un
// número (se leería como un número de tarea), o dar `cac`.
func TestAKeyThatIsTakenGetsALetter(t *testing.T) {
	taken := map[string]bool{"proteus": true, "proteus-b": true}
	if got := FreeSpaceKey("proteus", func(k string) bool { return taken[k] }); got != "proteus-c" {
		t.Errorf("choque: %q", got)
	}
	if got := FreeSpaceKey("dwit", func(string) bool { return false }); got != "dwit" {
		t.Errorf("libre: %q", got)
	}
	if got := FreeSpaceKey("cac", func(string) bool { return false }); got == "cac" || !ValidSpaceKey(got) {
		t.Errorf("cac: %q", got)
	}
	all := func(k string) bool { return !strings.HasSuffix(k, "-b2") }
	if got := FreeSpaceKey("x", all); got != "x-b2" || !ValidSpaceKey(got) {
		t.Errorf("sin letras libres: %q", got)
	}
	if SpaceTaskRef("proteus", 12) != "proteus-12" || SpaceTaskRef("", 1) != "" || SpaceTaskRef("x", 0) != "" {
		t.Error("SpaceTaskRef")
	}
}

// Rotura que detecta: no marcar una clave de rama que venía en mayúsculas.
// Sin la marca, `feature/PROTEUS-205`, la rama de una tarea de Jira, se
// enlazaría a la tarea 205 de cac.
func TestABranchKeyInCapitalsIsMarkedAsFolded(t *testing.T) {
	up := ExtractBranchRefs("feature/PROTEUS-205-login", false)
	low := ExtractBranchRefs("feature/proteus-205-login", false)
	if len(up) != 1 || !up[0].Folded || up[0].Slug != "proteus" {
		t.Fatalf("mayúsculas: %+v", up)
	}
	if len(low) != 1 || low[0].Folded {
		t.Fatalf("minúsculas: %+v", low)
	}
}
