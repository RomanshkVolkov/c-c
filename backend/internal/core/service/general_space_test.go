package service

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// La sala general no admite tareas, y eso se comprueba en TODAS las puertas.
//
// Los guardas no se pueden probar llamando al servicio: `TaskService.repo` es un
// `*repository.TaskRepository` concreto, así que `esGeneral` toca Postgres y la
// prueba se saltaría en el CI —que no levanta base de datos— justo donde más
// falta hace. Se comprueba entonces sobre el árbol sintáctico: cada función que
// puede colgarle tareas a un espacio tiene que consultar `esGeneral`.
//
// Lo que caza de verdad: alguien añade mañana un `MoveTaskToSpace`, o quita un
// guarda al refactorizar, y aquí salta. Lo que no caza: que el guarda esté puesto
// del revés. Para eso está la revisión, y el hecho de que la app no ofrezca
// ninguna de estas acciones sobre la sala — el MCP sí, y por eso existen.
//
// Precedente en la casa: `repository.TestLoadEnvNeverLogsAValue` vigila una regla
// leyendo su propio fuente. Aquí se parsea en vez de buscar texto, para que un
// `esGeneral` dentro de un comentario no cuele.
func TestLasPuertasDeLaSalaGeneralEstanVigiladas(t *testing.T) {
	// Cada una es una forma distinta de darle tareas a un espacio, o de
	// quitárselo a la organización.
	puertas := []string{
		"CreateFolder",
		"CreateList",
		"MoveFolderToSpace",
		"MoveListToSpace",
		"BindSpace",
		"DeleteSpace",
	}

	fset := token.NewFileSet()
	archivo, err := parser.ParseFile(fset, "task.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	consulta := map[string]bool{}
	for _, decl := range archivo.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			llamada, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if sel, ok := llamada.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "esGeneral" {
				consulta[fn.Name.Name] = true
			}
			return true
		})
	}

	for _, puerta := range puertas {
		if !consulta[puerta] {
			t.Errorf("%s puede darle tareas a la sala general sin preguntar si lo es", puerta)
		}
	}
}
