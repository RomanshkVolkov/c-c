package rank

import (
	"math/big"
	"strings"
	"testing"
)

// Las claves se comparan **como números**, con `big.Rat` y no con la propia
// `less` del paquete: una prueba que usa la función que está comprobando no
// puede cazar que esa función se equivoque.
func num(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("%q no es un número", s)
	}
	return r
}

func before_(t *testing.T, a, b string) bool { return num(t, a).Cmp(num(t, b)) < 0 }

// Una clave que acaba en cero rompe todo lo demás sin que se note: 0,5 y 0,50
// son el mismo número, así que dos filas distintas podrían caer en el mismo
// sitio y el orden entre ellas lo decidiría el azar.
func assertWellFormed(t *testing.T, k string) {
	t.Helper()
	if !strings.HasPrefix(k, "0.") {
		t.Fatalf("clave %q fuera de (0,1)", k)
	}
	if strings.HasSuffix(k, "0") {
		t.Fatalf("clave %q acaba en cero: 0,50 y 0,5 son el mismo sitio", k)
	}
}

func TestBetweenOrders(t *testing.T) {
	cases := []struct{ a, b string }{
		{"", ""},
		{"", "0.5"},
		{"0.5", ""},
		{"0.5", "0.6"},
		{"0.1", "0.9"},
	}
	for _, c := range cases {
		got := Between(c.a, c.b)
		assertWellFormed(t, got)
		if c.a != "" && !before_(t, c.a, got) {
			t.Fatalf("Between(%q,%q)=%q no va después de a", c.a, c.b, got)
		}
		if c.b != "" && !before_(t, got, c.b) {
			t.Fatalf("Between(%q,%q)=%q no va antes de b", c.a, c.b, got)
		}
	}
}

// El caso patológico del índice fraccionario: meter siempre entre los dos
// mismos vecinos tiene que seguir funcionando. Aquí es donde se acaba la
// precisión de un rango en coma flotante — y por eso esto es `NUMERIC`, que en
// Postgres admite 16383 decimales.
func TestRepeatedMidpointStaysOrdered(t *testing.T) {
	lo, hi := "0.5", "0.6"
	prev := lo
	for i := 0; i < 200; i++ {
		mid := Between(prev, hi)
		assertWellFormed(t, mid)
		if !before_(t, prev, mid) || !before_(t, mid, hi) {
			t.Fatalf("vuelta %d: %q no está estrictamente entre %q y %q", i, mid, prev, hi)
		}
		prev = mid
	}
}

func TestAppendSequence(t *testing.T) {
	last := ""
	for i := 0; i < 500; i++ {
		next := Between(last, "")
		assertWellFormed(t, next)
		if last != "" && !before_(t, last, next) {
			t.Fatalf("vuelta %d: %q no va después de %q", i, next, last)
		}
		last = next
	}
}

func TestPrependSequence(t *testing.T) {
	first := ""
	for i := 0; i < 200; i++ {
		next := Between("", first)
		assertWellFormed(t, next)
		if first != "" && !before_(t, next, first) {
			t.Fatalf("vuelta %d: %q no va antes de %q", i, next, first)
		}
		first = next
	}
}

// Lo que motivó el cambio de alfabeto: con `0-9A-Za-z` el orden de las claves
// dependía de la colación de la base. Con dígitos no hay nada que interpretar
// —el orden de texto y el de número coinciden— así que da igual cómo esté
// configurada.
func TestTextOrderAndNumberOrderAgree(t *testing.T) {
	var keys []string
	last := ""
	for i := 0; i < 60; i++ {
		last = Between(last, "")
		keys = append(keys, last)
	}
	// Y unas cuantas metidas por en medio, que son las que producen claves largas.
	for i := 0; i < 40; i++ {
		mid := Between(keys[0], keys[1])
		keys = append(keys, mid)
		keys[0] = mid
	}
	for _, a := range keys {
		for _, b := range keys {
			if a == b {
				continue
			}
			if (a < b) != before_(t, a, b) {
				t.Fatalf("%q y %q se ordenan distinto como texto que como número", a, b)
			}
		}
	}
}

// La cadena vacía significa «sin límite», no «cero». Es el sentinela con el que
// se pide «el primero» y «el último», y lo usan todos los que llaman.
func TestEmptyMeansNoBound(t *testing.T) {
	if Between("", "") != First {
		t.Fatalf("un contenedor vacío tiene que dar %q", First)
	}
}

// Límites invertidos o iguales: quien llama no debería mandarlos, pero si los
// manda la respuesta tiene que seguir siendo un número válido y por encima de
// `a`, no algo que rompa el orden del tablero.
//
// «0.5» y «0.50» son el mismo número escrito de dos formas, y la base puede
// devolver cualquiera de las dos. Compararlas como texto diría que una va antes
// que la otra, y de ahí saldría una clave metida en un hueco que no existe.
func TestInvertedOrEqualBoundsDegradeSafely(t *testing.T) {
	cases := []struct{ a, b string }{
		{"0.6", "0.5"},  // invertidos
		{"0.5", "0.5"},  // iguales
		{"0.5", "0.50"}, // iguales, escritos distinto
		{"0.50", "0.5"},
	}
	for _, c := range cases {
		got := Between(c.a, c.b)
		assertWellFormed(t, got)
		if !before_(t, c.a, got) {
			t.Fatalf("Between(%q,%q)=%q tendría que ir después de a", c.a, c.b, got)
		}
		// Y **exactamente** el camino de degradación, que es el contrato: «justo
		// después de a». Conformarse con «queda por encima de a» deja pasar el
		// caso de verdad — con «0.5» y «0.50» comparados como texto, la función
		// se cree que hay hueco y devuelve 0,505, que está por encima de a y
		// también por encima de b. Se midió: el mutante sobrevivía.
		if quiere := Between(c.a, ""); got != quiere {
			t.Fatalf("Between(%q,%q)=%q; con los límites así tiene que degradar a %q",
				c.a, c.b, got, quiere)
		}
	}
}
