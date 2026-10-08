package domain

import (
	"regexp"
	"strconv"
	"strings"
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

// ─── En el nombre de una rama ────────────────────────────────────────────────

// La convención de Jira (la clave de la tarea en el nombre de la rama), con las
// claves de cac:
//
//	cac-12-login, feature/CAC-12, fix_cac-12   → la tarea 12 del espacio del repo
//	feature/acme-7-fix                          → el folio 7 de `acme`
//	12-login                                    → la tarea 12, sólo con BareRefs (es lo
//	                                              que genera «Create branch» desde un
//	                                              issue de GitHub)
//	cac12, v1.2                                 → nada: sin guion no es una clave
//
// Sin distinguir mayúsculas: Jira escribe las claves en mayúsculas y Linear en
// minúsculas, y las dos llegan. `cac` como slug queda reservado al número del
// espacio, igual que `cac#N` en un texto.
var (
	branchCac   = regexp.MustCompile(`(?:^|[-_.])cac-(\d{1,9})(?:[-_.]|$)`)
	branchBare  = regexp.MustCompile(`^(\d{1,9})(?:[-_.]|$)`)
	branchFolio = regexp.MustCompile(`(?:^|[-_.])([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d{1,9})(?:[-_.]|$)`)
)

// ExtractBranchRefs saca las tareas que nombra el nombre de una rama. Pura:
// resolverlas —y que sean de la org del repo— es cosa del servicio, que además
// prueba los sufijos del slug (`SlugSuffixes`).
func ExtractBranchRefs(branch string, bare bool) []TaskRef {
	var out []TaskRef
	seen := map[TaskRef]bool{}
	add := func(r TaskRef) {
		if r.Seq <= 0 || seen[r] || len(out) >= MaxTaskRefs {
			return
		}
		seen[r] = true
		out = append(out, r)
	}
	for _, seg := range strings.Split(strings.ToLower(branch), "/") {
		seg = strings.ReplaceAll(seg, "_", "-")
		for _, m := range branchCac.FindAllStringSubmatch(seg, -1) {
			n, _ := strconv.Atoi(m[1])
			add(TaskRef{Seq: n})
		}
		if bare {
			if m := branchBare.FindStringSubmatch(seg); m != nil {
				n, _ := strconv.Atoi(m[1])
				add(TaskRef{Seq: n})
			}
		}
		for _, m := range branchFolio.FindAllStringSubmatch(seg, -1) {
			if m[1] == "cac" || strings.HasSuffix(m[1], "-cac") {
				continue // ya contado como número del espacio
			}
			n, _ := strconv.Atoi(m[2])
			add(TaskRef{Slug: m[1], Seq: n})
		}
	}
	return out
}

// SlugSuffixes: los slugs que puede querer decir un prefijo con guiones, del
// más largo al más corto y como mucho tres. `feature-beta-api-7` puede ser el
// folio 7 de `feature-beta-api`, de `beta-api` o de `api`; el servicio se
// queda con el primero que sea un proyecto de verdad de la organización.
func SlugSuffixes(slug string) []string {
	parts := strings.Split(slug, "-")
	var out []string
	for i := 0; i < len(parts) && len(out) < 3; i++ {
		out = append(out, strings.Join(parts[i:], "-"))
	}
	return out
}
