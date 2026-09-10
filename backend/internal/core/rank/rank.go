// Package rank implements fractional indexing: decimal keys that can always be
// ordered, with a new key derivable *between* any two others.
//
// Why not an integer `position`: moving one card in a board would renumber every
// card after it (N writes, and two people dragging at once corrupt the order).
// With fractional ranks a move is a single-row update and concurrent moves at
// worst end up adjacent, never scrambled.
//
// # Por qué decimales y no texto en base 62
//
// Hasta el 10-sep-2026 las claves eran texto sobre el alfabeto `0-9A-Za-z` y se
// ordenaban lexicográficamente. Funcionaba, pero **quien ordena de verdad es
// Postgres**, con `ORDER BY rank ASC`, y ahí manda la colación de la base: ese
// alfabeto mezcla mayúsculas y minúsculas, así que sólo salía bien si la base
// comparaba por bytes. Con una colación de locale (glibc `en_US.utf8`) las dos
// cajas se entremezclan y **el segundo elemento de un contenedor se pintaba
// antes que el primero**, porque los primeros rangos eran «U» y «k».
//
// Producción estaba en `C` y acertaba, pero por suerte: nada en el esquema lo
// pedía. Un número no tiene ese problema — no hay colación que aplicarle — así
// que la clave es ahora un `NUMERIC` de Postgres y el orden no depende de cómo
// alguien corrió `initdb`.
//
// El algoritmo no cambió: era agnóstico del alfabeto, y con `0-9` una clave es
// literalmente el número que representa. `NUMERIC` admite 16383 decimales, muy
// por encima de lo que hacen falta.
package rank

import "strings"

// digits is the ordered alphabet: the ten decimal digits, so a key is the
// number it spells.
const digits = "0123456789"

// prefix turns the fractional digits into the decimal Postgres stores. Todas
// las claves viven en (0,1), que es lo que deja sitio infinito a los dos lados.
const prefix = "0."

const (
	// First is the rank handed to the first item in an empty container.
	First = prefix + "5" // a mitad, dejando sitio a los dos lados
	minD  = '0'
	maxD  = '9'
)

func indexOf(c byte) int { return strings.IndexByte(digits, c) }

// frac quita el «0.» y deja los dígitos con los que trabaja el algoritmo. La
// cadena vacía —que significa «sin límite»— pasa tal cual.
func frac(s string) string { return strings.TrimPrefix(s, prefix) }

// less compara dos claves **como números**, no como texto.
//
// Rellenar la más corta con ceros es lo que hace que «5» y «50» salgan iguales,
// que es lo que son: 0,5 y 0,50. El algoritmo nunca emite una clave acabada en
// cero, pero un valor que llega de la base pudo escribirlo otro.
func less(a, b string) bool {
	for len(a) < len(b) {
		a += "0"
	}
	for len(b) < len(a) {
		b += "0"
	}
	return a < b
}

// Between returns a rank that sorts strictly after `a` and strictly before `b`.
// Empty strings mean "no bound": Between("", x) yields a rank before x, and
// Between(x, "") one after x.
func Between(a, b string) string {
	a, b = frac(a), frac(b)
	switch {
	case a == "" && b == "":
		return First
	case a == "":
		return prefix + before(b)
	case b == "":
		return prefix + after(a)
	}
	if !less(a, b) {
		// Callers shouldn't invert bounds; degrade to "just after a" rather than
		// returning something that breaks ordering.
		return prefix + after(a)
	}
	return prefix + midpoint(a, b)
}

// midpoint walks both keys digit by digit, and as soon as there's room between
// them emits the middle digit; otherwise it copies and keeps descending.
func midpoint(a, b string) string {
	var out strings.Builder
	for i := 0; ; i++ {
		ca := byte(minD)
		if i < len(a) {
			ca = a[i]
		}
		cb := byte(maxD) + 1 // exclusive upper bound when b runs out
		if i < len(b) {
			cb = b[i]
		}

		if ca == cb {
			out.WriteByte(ca)
			continue
		}

		ia, ib := indexOf(ca), indexOf(cb)
		if ib < 0 { // b exhausted: anything above ca works
			ib = len(digits)
		}
		if ib-ia > 1 {
			out.WriteByte(digits[(ia+ib)/2])
			return out.String()
		}
		// Digits are adjacent: keep a's digit and append a digit that lands
		// after whatever remains of a.
		out.WriteByte(ca)
		return out.String() + after(sliceFrom(a, i+1))
	}
}

func sliceFrom(s string, i int) string {
	if i >= len(s) {
		return ""
	}
	return s[i:]
}

// after returns a rank strictly greater than a.
func after(a string) string {
	if a == "" {
		return frac(First)
	}
	// Bump the last digit when possible; otherwise extend the key.
	last := a[len(a)-1]
	if i := indexOf(last); i >= 0 && i < len(digits)-1 {
		// Land midway between the last digit and the top so there's still room.
		return a[:len(a)-1] + string(digits[(i+len(digits))/2])
	}
	return a + frac(First)
}

// before returns a rank strictly smaller than b.
//
// Una clave no acaba nunca en el dígito más bajo: «00» no dejaría nada por
// debajo en el mundo del texto, y en el de los números 0,50 y 0,5 son el mismo
// sitio. Cuando no queda hueco en un dígito se baja al cajón del «0» y la clave
// nueva se coloca dentro.
func before(b string) string {
	if b == "" {
		return frac(First)
	}
	i := indexOf(b[0])
	switch {
	case i > 1:
		return string(digits[i/2]) // plenty of room below this digit
	case i == 1:
		return string(digits[0]) + frac(First) // 0,05 < 0,1, y no acaba en cero
	default:
		// b already starts at the smallest digit: stay in that bucket.
		return string(digits[0]) + before(b[1:])
	}
}
