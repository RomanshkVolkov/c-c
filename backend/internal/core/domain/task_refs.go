package domain

import (
	"regexp"
	"strconv"
)

// TaskRef es una tarea nombrada en un texto de fuera (un commit, una PR).
//
//   - `cac#12` → la tarea 12 del espacio del repo. Siempre.
//   - `#12`    → lo mismo, pero sólo si el repo lo pide (`BareRefs`): en
//     GitHub `#12` es el issue 12 del propio repo.
//   - `acme-7` → el folio 7 del proyecto `acme`, como lo ve el cliente.
//
// Seq > 0 siempre. Slug vacío = número del espacio; con slug = folio.
type TaskRef struct {
	Slug string
	Seq  int
}

// MaxTaskRefs acota cuántas tareas puede nombrar un solo texto. Un mensaje con
// cien `x-1` no puede convertirse en cien consultas.
const MaxTaskRefs = 10

var (
	cacRef   = regexp.MustCompile(`(?i)\bcac#(\d{1,9})\b`)
	bareRef  = regexp.MustCompile(`(?:^|\W)#(\d{1,9})\b`)
	folioRef = regexp.MustCompile(`\b([a-z0-9][a-z0-9-]{0,118}[a-z0-9])-(\d{1,9})\b`)
)

// ExtractTaskRefs saca las tareas que nombra un texto, sin repetir y en el
// orden en que aparecen. Es pura: resolverlas (y comprobar que son de la org
// del repo) es cosa del servicio.
func ExtractTaskRefs(text string, bare bool) []TaskRef {
	var out []TaskRef
	seen := map[TaskRef]bool{}
	add := func(r TaskRef) {
		if r.Seq <= 0 || seen[r] || len(out) >= MaxTaskRefs {
			return
		}
		seen[r] = true
		out = append(out, r)
	}
	for _, m := range cacRef.FindAllStringSubmatch(text, -1) {
		n, _ := strconv.Atoi(m[1])
		add(TaskRef{Seq: n})
	}
	if bare {
		for _, m := range bareRef.FindAllStringSubmatch(text, -1) {
			n, _ := strconv.Atoi(m[1])
			add(TaskRef{Seq: n})
		}
	}
	for _, m := range folioRef.FindAllStringSubmatch(text, -1) {
		n, _ := strconv.Atoi(m[2])
		add(TaskRef{Slug: m[1], Seq: n})
	}
	return out
}
