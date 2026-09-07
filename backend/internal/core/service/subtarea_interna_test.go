package service

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Una subtarea nunca hereda el canal de su padre.
//
// La razón original: heredarlo gastaría un folio del cliente en una línea de
// checklist y la pondría en su tablero como si fuera un ticket propio.
//
// Y desde que hay dos máquinas de estados, de esto depende algo más que no se ve
// desde aquí: el check de «hecho» del panel salta directo de Open a Done, y eso
// sólo es legal en el flujo interno. Si alguien quita esa línea al refactorizar,
// el botón vuelve a no hacer nada y a no decir por qué — que es exactamente el
// fallo del que salió todo esto, y no dejó rastro en ninguna prueba.
//
// Sobre el árbol sintáctico y no llamando al servicio, por lo mismo que
// `TestLasPuertasDeLaSalaGeneralEstanVigiladas`: crear una tarea toca Postgres, y
// en integración continua no hay base de datos.
func TestUnaSubtareaNoHeredaElCanal(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "task.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	var cuerpo *ast.FuncDecl
	ast.Inspect(f, func(n ast.Node) bool {
		fd, ok := n.(*ast.FuncDecl)
		if ok && fd.Name.Name == "CreateTask" {
			cuerpo = fd
		}
		return cuerpo == nil
	})
	if cuerpo == nil {
		t.Fatal("CreateTask ya no está donde se buscaba: hay que rehacer esta guarda")
	}

	// `t.ProjectID = ""` dentro de la rama que mira `req.ParentID`.
	limpia := false
	ast.Inspect(cuerpo, func(n ast.Node) bool {
		asg, ok := n.(*ast.AssignStmt)
		if !ok || len(asg.Lhs) != 1 || len(asg.Rhs) != 1 {
			return true
		}
		sel, ok := asg.Lhs[0].(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "ProjectID" {
			return true
		}
		lit, ok := asg.Rhs[0].(*ast.BasicLit)
		if ok && lit.Value == `""` {
			limpia = true
		}
		return true
	})
	if !limpia {
		t.Fatal("una subtarea heredaría el canal del padre: gastaría un folio del cliente, " +
			"y el check de «hecho» del panel dejaría de funcionar en silencio")
	}
}
