package repository

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Con DB_HOST puesto, una base que no contesta es un fallo, no un salto.
//
// El 21-oct-2026, `cac-test-pg` llevaba diez horas apagada y cada prueba con
// base se saltaba en silencio: `go test` salía en verde sin haber corrido ni
// una. Sin DB_HOST se siguen saltando (una máquina sin base no puede correrlas);
// con DB_HOST, quien la configuró quiere que corran. Las ayudas de base se
// copian de fichero en fichero, así que esto mira todos: copiar una vieja
// devolvería el salto callado.
func TestADatabaseThatDoesNotAnswerFailsInsteadOfSkipping(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	silent := regexp.MustCompile(`t\.Skipf?\("(no database reachable|cannot create a throwaway database)`)
	var bad []string
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, "_test.go") {
			return nil
		}
		body, err := os.ReadFile(p)
		if err == nil && silent.Match(body) {
			rel, _ := filepath.Rel(root, p)
			bad = append(bad, rel)
		}
		return nil
	})
	if len(bad) > 0 {
		t.Fatalf("se saltan en silencio con la base caída: %v", bad)
	}
}
