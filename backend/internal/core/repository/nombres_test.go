package repository

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Nadie resuelve el nombre de una persona por su cuenta.
//
// La expresión vive en un solo sitio porque tres superficies pintan bylines —la
// documentación, el chat y los directos— y las tres tienen que decir el mismo
// nombre. Escrita por separado bastaba con que alguien arreglara una para que
// las otras dos siguieran diciendo otra cosa sobre la misma persona: eso es
// exactamente lo que pasó, y por eso la campana decía «rvolkov» cuando la
// documentación ya decía «Romanshk Volkov».
//
// Se vigila leyendo el fuente porque el fallo es de **copiar y pegar**: nada
// falla, nada se rompe, y la única señal es que dos pantallas llaman distinto a
// la misma persona. Precedente en la casa: `TestLoadEnvNeverLogsAValue` y
// `TestLasPuertasDeLaSalaGeneralEstanVigiladas`.
func TestNadieResuelveElNombreASuAire(t *testing.T) {
	// `username` sacado de la tabla de usuarios para enseñarlo. Lo que se busca
	// es la forma exacta que había repetida en tres sitios.
	suelto := regexp.MustCompile(`COALESCE\(\s*username`)

	ficheros, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var culpables []string
	for _, f := range ficheros {
		if strings.HasSuffix(f, "_test.go") || f == "nombres.go" {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, linea := range strings.Split(string(b), "\n") {
			if suelto.MatchString(linea) {
				culpables = append(culpables, f+":"+itoa(i+1))
			}
		}
	}
	if len(culpables) > 0 {
		t.Fatalf("resuelven el nombre a mano en vez de usar `nombreVisible`, "+
			"así que enseñarán el usuario donde el resto enseña el nombre: %v", culpables)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
