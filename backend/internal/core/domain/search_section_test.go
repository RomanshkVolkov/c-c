package domain

import "testing"

const runbook = "Intro sin título.\n\n" +
	"## Despliegue\n\nSe despliega con el CI.\n\n" +
	"### Variables\n\nEMAIL_FROM y EMAIL_REGION van en el secret.\n\n" +
	"## Correo\n\nAmazon SES en us-east-1, configuración «cac».\n\n" +
	"```bash\n# Correo de prueba\naws ses send-email\n```\n\n" +
	"## Rebotes\n\nLlegan por SNS.\n"

// Roturas que detecta cada caso, en orden: quedarse con la sección madre y no
// con la concreta; distinguir acentos o mayúsculas; no buscar por prefijo;
// tomar un `#` de un bloque de código por un título; elegir la primera
// sección con una palabra en vez de la que tiene más; inventar un título donde
// no lo hay.
func TestSearchSectionPointsAtTheSectionNotTheTab(t *testing.T) {
	cases := []struct{ query, want string }{
		{"EMAIL_REGION", "Variables"},
		{"configuracion", "Correo"},
		{"desplieg", "Despliegue"},
		{"aws send", "Correo"},
		{"sns rebotes", "Rebotes"},
		{"intro", ""},
		{"kubernetes helm", ""},
	}
	for _, c := range cases {
		if got := SearchSection(runbook, c.query); got != c.want {
			t.Errorf("SearchSection(%q) = %q, quería %q", c.query, got, c.want)
		}
	}
}

// Rotura que detecta: que el bloque de código cuente como título («Correo de
// prueba» no existe para el MCP, que no lo reconoce).
func TestACodeCommentIsNotAHeading(t *testing.T) {
	if got := SearchSection(runbook, "prueba"); got != "Correo" {
		t.Errorf("got %q", got)
	}
	if got := SearchSection("# Título #\n\ntexto", "texto"); got != "Título" {
		t.Errorf("los # de cierre no son del título: %q", got)
	}
	if got := SearchSection("#sin espacio\n\ntexto", "texto"); got != "" {
		t.Errorf("sin espacio no es un título: %q", got)
	}
}
