package middleware

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

/*
Ningún log imprime configuración ni la URL entera (6-oct-2026).

Los logs del clúster los lee más gente que la que debería saber dónde vive la
base, con qué usuario se entra o cuál es el bucket; y la query de una URL puede
llevar un pase (`?token=`, `?access_token=`, `?__cac=`). Se recorre el código
del backend **y del agente** buscando llamadas de log que impriman una variable
de entorno o `RequestURI` / `URL.String()` / `URL.RawQuery` sin tapar.

Mutantes: volver a poner `GetEnv(...)` en un `lg.Info`; que el agente vuelva a
escribir `r.RequestURI`.
*/

var logCall = regexp.MustCompile(`(?s)\b(?:lg\.(?:Info|Warn|Error|Debug)|log\.(?:Printf|Println|Print|Fatalf|Fatal)|fmt\.(?:Printf|Println|Print))\((.*?)\)\s*$`)

var forbidden = []*regexp.Regexp{
	regexp.MustCompile(`GetEnv\(`),
	regexp.MustCompile(`os\.Getenv\(`),
	regexp.MustCompile(`os\.Environ\(`),
	regexp.MustCompile(`\.RequestURI\b`),
	regexp.MustCompile(`\.URL\.String\(\)`),
	regexp.MustCompile(`\.URL\.RawQuery\b`),
}

func TestNoLogPrintsConfigOrAFullURL(t *testing.T) {
	// El agente (`swarm-manage`) entra en la lista con su v5, que es cuando se
	// publica su arreglo: hasta entonces su log escribe la ruta entera.
	roots := []string{"../../../internal", "../../../cmd"}
	var leaks []string
	for _, root := range roots {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			for i, line := range strings.Split(string(src), "\n") {
				m := logCall.FindStringSubmatch(strings.TrimSpace(line))
				if m == nil {
					continue
				}
				// El logger del backend tapa la query antes de escribir: ése se
				// permite, y sólo ése.
				if strings.Contains(m[1], "redactQuery(") {
					continue
				}
				for _, f := range forbidden {
					if f.MatchString(m[1]) {
						leaks = append(leaks, path+":"+itoa(i+1)+"  "+strings.TrimSpace(line))
						break
					}
				}
			}
			return nil
		})
	}
	if len(leaks) > 0 {
		t.Errorf("logs que imprimen configuración o la URL entera:\n  %s", strings.Join(leaks, "\n  "))
	}
}

// Los pases que viajan en la URL se tapan; los demás parámetros se quedan,
// que son lo que sirve para depurar.
func TestEveryCredentialInAQueryIsRedacted(t *testing.T) {
	for _, k := range []string{"token", "sig", "__cac", "access_token", "state", "code", "key", "pass"} {
		got := redactQuery("/x?" + k + "=SECRETO&space=s1")
		if strings.Contains(got, "SECRETO") {
			t.Errorf("%s no se tapa: %s", k, got)
		}
		if !strings.Contains(got, "space=s1") {
			t.Errorf("se perdió lo que no era secreto: %s", got)
		}
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
