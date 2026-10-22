package domain

import (
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ─── La clave de un espacio ──────────────────────────────────────────────────
//
// Cómo se nombra una tarea fuera de cac (un commit, una rama, una PR): la clave
// de su espacio y su número, `proteus-12`, como hace Jira (`PROTEUS-12`). Antes
// era `cac#12`, que decía el nombre de la herramienta y no el del proyecto, y
// era una tercera forma aparte del folio (`acme-7`) y de la rama. Decidido con
// jose el 21-oct-2026 (cac#203).
//
//   - **Sale del nombre al crear el espacio** y no cambia al renombrarlo: los
//     commits viejos tienen que seguir enlazando. Cambiarla se hace a
//     propósito, y la vieja se sigue aceptando (`SpaceKeyAlias`).
//   - **En minúsculas y kebab-case.** Sólo se reconoce así, también en una rama:
//     `PROTEUS-205` es la clave de Jira de ese proyecto, que numera por su lado.
//   - **Cada trozo empieza por letra.** `proyecto-2026` en un commit se leería
//     como la tarea 2026 de `proyecto`; por eso un trozo numérico se cae, y un
//     choque se resuelve con una letra (`proteus-b`), no con un número.
//   - **Única en la org**, también frente a los slugs de los proyectos de
//     cliente: con los dos, `acme-7` no diría cuál.

// MaxSpaceKey: lo más que mide una clave.
const MaxSpaceKey = 60

// SpaceKeyFrom: la clave que propone el nombre de un espacio: minúsculas, sin
// acentos, kebab-case, y cada trozo empezando por letra. «Dwit México» →
// `dwit-mexico`, «dr_iñigo» → `dr-inigo`, «Proyecto 2026» → `proyecto`.
// `space` si no queda nada.
func SpaceKeyFrom(name string) string {
	var words []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			words = append(words, string(cur))
			cur = cur[:0]
		}
	}
	for _, r := range norm.NFD.String(strings.ToLower(name)) {
		switch {
		case unicode.Is(unicode.Mn, r):
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			cur = append(cur, r)
		default:
			flush()
		}
	}
	flush()
	var keep []string
	n := 0
	for _, w := range words {
		if w[0] < 'a' || w[0] > 'z' {
			continue
		}
		if n+len(w)+len(keep) > MaxSpaceKey {
			break
		}
		keep = append(keep, w)
		n += len(w)
	}
	if len(keep) == 0 {
		return "space"
	}
	return strings.Join(keep, "-")
}

// ValidSpaceKey: lo que se acepta al cambiar la clave a mano, con las mismas
// reglas. `cac` no: es el prefijo de las referencias por número (`cac#12`,
// `cac-12-…`).
func ValidSpaceKey(k string) bool {
	if k == "" || len(k) > MaxSpaceKey || k == "cac" {
		return false
	}
	for _, w := range strings.Split(k, "-") {
		if w == "" || w[0] < 'a' || w[0] > 'z' {
			return false
		}
		for i := 0; i < len(w); i++ {
			if !(w[i] >= 'a' && w[i] <= 'z') && !(w[i] >= '0' && w[i] <= '9') {
				return false
			}
		}
	}
	return true
}

// FreeSpaceKey: `base`, o con una letra detrás (`-b`, `-c`…) si ya está
// tomada, y después letra y número (`-b2`). `taken` dice si una clave ya la usa
// otro espacio o un proyecto de la org.
func FreeSpaceKey(base string, taken func(string) bool) string {
	if base == "cac" {
		base = "cac-space"
	}
	if !taken(base) {
		return base
	}
	for n := 1; ; n++ {
		for c := 'b'; c <= 'z'; c++ {
			k := base + "-" + string(c)
			if n > 1 {
				k += strconv.Itoa(n)
			}
			if !taken(k) {
				return k
			}
		}
	}
}

// SpaceTaskRef: cómo se nombra fuera una tarea interna de un espacio.
func SpaceTaskRef(key string, seq int) string {
	if key == "" || seq <= 0 {
		return ""
	}
	return key + "-" + strconv.Itoa(seq)
}
