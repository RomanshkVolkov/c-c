package domain

import (
	"reflect"
	"testing"
)

// La clave de la tarea en el nombre de la rama, con la gramática de cac.
//
// Los mutantes que mata, uno por fila: no pasar a minúsculas (`CAC-12`), hacer
// el guion opcional (`cac12` enlazaría), quitar la guarda de `bare` (`12-login`
// enlazaría sin pedirlo), quitar el límite de segmento (`vcac-12` enlazaría).
func TestExtractBranchRefs(t *testing.T) {
	cases := []struct {
		branch string
		bare   bool
		want   []TaskRef
	}{
		{"cac-12-login", false, []TaskRef{{Seq: 12}}},
		{"feature/CAC-12", false, []TaskRef{{Seq: 12}}},
		{"fix_cac-12", false, []TaskRef{{Seq: 12}}},
		{"feature/acme-7-fix", false, []TaskRef{{Slug: "acme", Seq: 7}}},
		{"12-login", false, nil},
		{"12-login", true, []TaskRef{{Seq: 12}}},
		{"cac12", false, nil},
		{"vcac-12", false, []TaskRef{{Slug: "vcac", Seq: 12}}},
		{"v1.2", false, nil},
		{"main", false, nil},
	}
	for _, c := range cases {
		got := ExtractBranchRefs(c.branch, c.bare)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("ExtractBranchRefs(%q, %v) = %+v, quería %+v", c.branch, c.bare, got, c.want)
		}
	}
}

// Como mucho tres sufijos: un prefijo largo no puede convertirse en diez
// consultas.
func TestSlugSuffixesStopsAtThree(t *testing.T) {
	got := SlugSuffixes("a-b-c-d")
	if !reflect.DeepEqual(got, []string{"a-b-c-d", "b-c-d", "c-d"}) {
		t.Fatalf("SlugSuffixes = %v", got)
	}
}

// Abierta antes que fusionada, fusionada antes que cerrada (Jira).
func TestGitBadgeFollowsJiraPrecedence(t *testing.T) {
	for _, c := range []struct {
		o, m, cl int
		want     string
	}{{1, 1, 1, PRStateOpen}, {0, 1, 1, PRStateMerged}, {0, 0, 1, PRStateClosed}, {0, 0, 0, ""}} {
		if got := GitBadge(c.o, c.m, c.cl); got != c.want {
			t.Errorf("GitBadge(%d,%d,%d) = %q", c.o, c.m, c.cl, got)
		}
	}
}

// GitHub dice `closed` de una PR fusionada y `open` de un borrador.
func TestPRStateOf(t *testing.T) {
	if PRStateOf("closed", false, true) != PRStateMerged {
		t.Fatal("una PR fusionada sale como cerrada")
	}
	if PRStateOf("open", true, false) != PRStateDraft {
		t.Fatal("un borrador sale como abierta")
	}
	if PRStateOf("closed", false, false) != PRStateClosed || PRStateOf("open", false, false) != PRStateOpen {
		t.Fatal("los estados simples no cuadran")
	}
}
