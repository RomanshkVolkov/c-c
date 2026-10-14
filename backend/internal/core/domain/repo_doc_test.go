package domain

import "testing"

// Qué ficheros de un repo salen en Documentación. Mutantes: no mirar las
// carpetas con punto (entran las plantillas de `.github`); casar `.mdx`; no
// mirar las carpetas de dependencias.
func TestWhichFilesAreRepoDocs(t *testing.T) {
	for p, want := range map[string]bool{
		"README.md":                        true,
		"docs/deploy/k8s.md":               true,
		"backend/NOTES.markdown":           true,
		"docs/Guía.MD":                     true,
		".github/PULL_REQUEST_TEMPLATE.md": false,
		"docs/.drafts/idea.md":             false,
		"app/node_modules/react/README.md": false,
		"vendor/github.com/x/README.md":    false,
		"site/dist/index.md":               false,
		"docs/page.mdx":                    false,
		"main.go":                          false,
		"docs/md":                          false,
	} {
		if got := IsRepoDocPath(p); got != want {
			t.Errorf("IsRepoDocPath(%q) = %v, want %v", p, got, want)
		}
	}
}

// El título: el primer `# ` fuera de un bloque de código, o el nombre.
// Mutante: tomar el primer `#` de cualquier línea (sale «instala»).
func TestRepoDocTitle(t *testing.T) {
	body := "```sh\n# instala\nmake\n```\n\n# Desplegar en k8s #\n\n## Pasos\n"
	if got := RepoDocTitle("docs/k8s.md", body); got != "Desplegar en k8s" {
		t.Fatalf("título = %q", got)
	}
	if got := RepoDocTitle("docs/k8s.md", "## Sólo un dos\n"); got != "k8s" {
		t.Fatalf("sin #, el nombre: %q", got)
	}
}

// La ruta de una imagen no puede servir para leer otra cosa del repo.
// Mutante: no mirar `..`; aceptar cualquier extensión.
func TestRepoImagePathOnlyLetsImagesThrough(t *testing.T) {
	for raw, want := range map[string]string{
		"docs/img/arq.png": "docs/img/arq.png",
		"./logo.SVG":       "logo.SVG",
		"docs//a.jpg":      "docs/a.jpg",
		"../secret.png":    "",
		"docs/../../x.png": "",
		".env":             "",
		"docs/key.pem":     "",
		"docs\\a.png":      "",
		"":                 "",
	} {
		got, _, ok := RepoImagePath(raw)
		if (want == "") == ok || got != want {
			t.Errorf("RepoImagePath(%q) = %q,%v; want %q", raw, got, ok, want)
		}
	}
}

// El `.cacignore`, con lo de `.gitignore` que se usa de verdad.
// Mutantes: sin `!`; `/` al final que también tape ficheros; un patrón sin
// barra sólo en la raíz; `**` como `*`; la primera regla que case en vez de
// la última.
func TestRepoIgnore(t *testing.T) {
	ig := ParseRepoIgnore(`
# fuera lo que no se lee
CHANGELOG.md
packages/**/README.md
/drafts
plantillas/
*.tmp.md
docs/
!docs/guia.md
!guia-de-estilo.md
plantillas.md
viejo*/
`)
	for p, want := range map[string]bool{
		"README.md":                   false,
		"CHANGELOG.md":                true,
		"app/CHANGELOG.md":            true,
		"packages/ui/README.md":       true,
		"packages/ui/forms/README.md": true,
		"packages/ui/GUIDE.md":        false,
		"drafts/idea.md":              true,
		"app/drafts/idea.md":          false,
		"plantillas/bug.md":           true,
		"x/plantillas/bug.md":         true,
		"notas.tmp.md":                true,
		"docs/deploy.md":              true,
		"docs/guia.md":                false,
		"plantillas.md":               true,
		"guia-de-estilo.md":           false,
		// `viejo*/` es sólo carpetas: un fichero que se llame así se queda.
		"viejo/plan.md": true,
		"viejo-plan.md": false,
	} {
		if got := ig.Ignored(p); got != want {
			t.Errorf("Ignored(%q) = %v, want %v", p, got, want)
		}
	}
	var none *RepoIgnore
	if none.Ignored("CHANGELOG.md") {
		t.Fatal("sin .cacignore no se tapa nada")
	}
}
