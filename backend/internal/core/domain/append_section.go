package domain

import "strings"

// AppendToSection: `body` con `text` añadido al final de la sección
// `section` (el texto de su título, sin mirar mayúsculas), antes del siguiente
// título de su nivel o mayor. Si no hay tal sección, se crea al final como
// `## section`.
//
// Existe para `remember` con destino «trampa»: una trampa va a «Trampas que
// ya han mordido» del overview, y hasta el 29-oct-2026 un agente sólo podía
// añadir al final de la pestaña —que cae bajo la última sección, sea cuál
// sea— o reescribir la sección, que pide un permiso que no tiene
// (command-and-control-252).
func AppendToSection(body, section, text string) string {
	text = strings.TrimSpace(text)
	want := strings.ToLower(strings.TrimSpace(section))
	lines := strings.Split(body, "\n")
	start, level, end := -1, 0, len(lines)
	i := 0
	scanMarkdown(body, func(_, heading string, lv int) {
		switch {
		case lv == 0:
		case start < 0 && strings.ToLower(heading) == want:
			start, level = i, lv
		case start >= 0 && end == len(lines) && lv <= level:
			end = i
		}
		i++
	})
	if start < 0 {
		head := strings.TrimRight(body, "\n \t")
		if head == "" {
			return "## " + strings.TrimSpace(section) + "\n\n" + text + "\n"
		}
		return head + "\n\n## " + strings.TrimSpace(section) + "\n\n" + text + "\n"
	}
	// Lo de la sección sin las líneas en blanco del final, el texto, y una
	// línea en blanco antes del título siguiente.
	last := end
	for last > start+1 && strings.TrimSpace(lines[last-1]) == "" {
		last--
	}
	out := append([]string{}, lines[:last]...)
	out = append(out, "", text)
	if end < len(lines) {
		out = append(out, "")
		out = append(out, lines[end:]...)
	} else {
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}
