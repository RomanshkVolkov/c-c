package i18n_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// El servidor no escribe en castellano lo que va a leer alguien en inglés.
//
// Éste es el fallo que destapó todo esto: `dm.go` escribía «Ana te escribió» en
// la bandeja de una aplicación en inglés, la fila se guardaba así, y nadie lo
// reportó nunca — quien la leía asumía que cac era así. No es una traducción
// que falta sino lo contrario, y por eso no lo cazaba nada.
//
// **Se miran sólo los literales de cadena**, no las líneas. Los comentarios van
// en castellano por la regla del repositorio y son la mitad de la prosa de
// estos ficheros; distinguirlos por cómo empieza la línea es un heurístico que
// se equivoca. Aquí no hace falta: Go trae su propio analizador, así que se
// parsea el fichero y se recorre el árbol.
func TestElServidorNoEscribeEnCastellano(t *testing.T) {
	raiz := filepath.Join("..", "..", "..", "internal")

	// El catálogo es el único sitio donde el castellano es el trabajo.
	permitidos := map[string]bool{
		filepath.Join("core", "i18n", "catalog.go"): true,
	}
	// Y esto no es una frase sino un dato: el nombre de una organización real,
	// que se llama como se llama.
	literalesPermitidos := map[string]bool{"Dwit México": true}

	var fugas []string
	err := filepath.WalkDir(raiz, func(ruta string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".go") {
			return err
		}
		rel, _ := filepath.Rel(raiz, ruta)
		if permitidos[rel] || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		archivo, err := parser.ParseFile(fset, ruta, nil, 0)
		if err != nil {
			t.Fatalf("no se pudo leer %s: %v", rel, err)
		}
		ast.Inspect(archivo, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			texto := strings.Trim(lit.Value, "`\"")
			if literalesPermitidos[texto] || !tieneCastellano(texto) {
				return true
			}
			fugas = append(fugas, rel+":"+
				fset.Position(lit.Pos()).String()[strings.LastIndex(fset.Position(lit.Pos()).String(), ":")+1:]+
				" "+lit.Value)
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fugas) > 0 {
		t.Fatalf("frases en castellano fuera del catálogo:\n  %s", strings.Join(fugas, "\n  "))
	}
}

// Las letras que el inglés no tiene. Es una heurística y se le escapa una frase
// castellana sin tildes; a cambio no tiene falsos positivos, que es lo que mata
// a un guardián de éstos.
func tieneCastellano(s string) bool {
	return strings.ContainsAny(s, "áéíóúñ¿¡ÁÉÍÓÚÑ")
}
