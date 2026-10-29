package domain

import "testing"

// Una trampa cae en su sección aunque no sea la última, se crea la sección si
// falta, y un `#` dentro de un bloque de código no cuenta como título.
// Roturas que detecta: añadir al final de la pestaña, cortar la sección en un
// título de nivel menor (un `###` de dentro), crearla otra vez si ya está,
// distinguir mayúsculas, irse a la segunda de dos secciones iguales, o tomar un `#` de un bloque de código por un título.
func TestAppendToSectionLandsInItsSection(t *testing.T) {
	overview := "# Proyecto\n\nQué es.\n\n## Trampas que ya han mordido\n\n- Una.\n\n### Detalle\n\nmás\n\n## Enlaces\n\n- x\n"
	got := AppendToSection(overview, "trampas que ya han mordido", "- Dos.")
	want := "# Proyecto\n\nQué es.\n\n## Trampas que ya han mordido\n\n- Una.\n\n### Detalle\n\nmás\n\n- Dos.\n\n## Enlaces\n\n- x\n"
	if got != want {
		t.Errorf("en medio:\n%q\nquería\n%q", got, want)
	}

	if got := AppendToSection("# Proyecto\n\nQué es.\n", "Trampas que ya han mordido", "- Una."); got != "# Proyecto\n\nQué es.\n\n## Trampas que ya han mordido\n\n- Una.\n" {
		t.Errorf("sin la sección: %q", got)
	}
	if got := AppendToSection("", "Trampas que ya han mordido", "- Una."); got != "## Trampas que ya han mordido\n\n- Una.\n" {
		t.Errorf("sin overview: %q", got)
	}
	if got := AppendToSection("## Trampas\n\n- Una.\n", "Trampas", "- Dos."); got != "## Trampas\n\n- Una.\n\n- Dos.\n" {
		t.Errorf("la última: %q", got)
	}
	// Con dos títulos iguales, la primera: es la que enseñan el mapa y get_doc.
	if got := AppendToSection("## Trampas\n\n- Una.\n\n## Trampas\n\n- Otra.\n", "Trampas", "- Dos."); got != "## Trampas\n\n- Una.\n\n- Dos.\n\n## Trampas\n\n- Otra.\n" {
		t.Errorf("con dos iguales: %q", got)
	}
	code := "## Trampas\n\n```sh\n# Enlaces\n```\n\n## Enlaces\n"
	if got := AppendToSection(code, "Trampas", "- Dos."); got != "## Trampas\n\n```sh\n# Enlaces\n```\n\n- Dos.\n\n## Enlaces\n" {
		t.Errorf("con un bloque de código: %q", got)
	}
}
