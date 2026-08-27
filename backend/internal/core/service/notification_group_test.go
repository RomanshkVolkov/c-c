package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Nadie notifica sin decir de qué conversación es.
//
// Ésta es la deuda que dejó cambiar siete parámetros por un struct: la lista de
// parámetros obligaba al compilador a preguntar, y un literal de struct que
// omita `Group` compila tan tranquilo. El sitio nuevo produciría filas no
// agrupables **en silencio** — la campana volvería a llenarse de líneas sueltas
// de un canal y nadie sabría por qué.
//
// El servicio tiene una red que deduce la clave cuando falta, pero es una red:
// funciona sólo si el enlace tiene forma conocida, y la deducción se rompe el
// día que un enlace cambie. Quien avisa **tiene** el id en la mano; que lo pase.
//
// Se lee el fuente porque la regla es sobre cómo se escribe el código, no sobre
// lo que devuelve: una prueba de comportamiento no distingue «puso la clave» de
// «se la dedujeron». Y sin base de datos, que es lo que hace que se ejecute.
func TestNadieAvisaSinDecirDeQueConversacionEs(t *testing.T) {
	ficheros, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}

	const apertura = "Notify(domain.Aviso{"
	encontrados := 0

	for _, f := range ficheros {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		fuente, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		texto := string(fuente)

		for i := 0; ; {
			j := strings.Index(texto[i:], apertura)
			if j < 0 {
				break
			}
			inicio := i + j
			literal, fin := literalHasta(texto, inicio+len(apertura))
			if fin < 0 {
				t.Fatalf("%s: no se pudo leer el literal que empieza en %d", f, inicio)
			}
			encontrados++
			if !strings.Contains(literal, "Group:") {
				t.Errorf("%s: un aviso sin `Group:` — se agrupará por deducción o no se agrupará:\n%s",
					f, recorte(literal))
			}
			i = fin
		}
	}

	// Si un día alguien renombra el struct o la interfaz, esta prueba se
	// quedaría mirando a la nada y pasaría vacía, que es la peor forma de pasar.
	if encontrados == 0 {
		t.Fatal("no se encontró ningún aviso: ¿cambió la forma de notificar?")
	}
}

// literalHasta devuelve el contenido del literal de struct que empieza en `desde`
// (justo tras la llave de apertura) y el índice donde acaba.
func literalHasta(texto string, desde int) (string, int) {
	nivel := 1
	for i := desde; i < len(texto); i++ {
		switch texto[i] {
		case '{':
			nivel++
		case '}':
			nivel--
			if nivel == 0 {
				return texto[desde:i], i
			}
		}
	}
	return "", -1
}

func recorte(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
