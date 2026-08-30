package service

import (
	"strings"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// El idioma de una fila de la bandeja es el de **quien la va a leer**.
//
// Es la regla entera de la parte del servidor, y la que no se puede arreglar
// después: la frase se escribe una vez y se queda escrita. Si se resuelve con
// el idioma de quien provocó el aviso —que es lo que pasa si la frase se arma
// en el sitio que la causa— Ana escribiendo en castellano le deja a Bob una
// fila en castellano para siempre.
func TestElAvisoSeEscribeEnElIdiomaDeQuienLoLee(t *testing.T) {
	a := domain.Aviso{
		UserID:    "u-bob",
		Kind:      "dm:message",
		TitleKey:  "notify.dm.wrote",
		TitleArgs: map[string]string{"who": "Ana"},
	}

	en := titleFor(a, "en")
	es := titleFor(a, "es")
	if en == es {
		t.Fatalf("los dos idiomas escribieron lo mismo: %q", en)
	}
	for _, frase := range []string{en, es} {
		if !strings.Contains(frase, "Ana") {
			t.Errorf("el nombre no llegó a la frase: %q", frase)
		}
		if strings.Contains(frase, "{{") {
			t.Errorf("quedó un hueco sin rellenar: %q", frase)
		}
	}
}

// Quien no ha elegido idioma lo lee en inglés, igual que quien pide uno que no
// hablamos. No puede quedarse sin título.
func TestSinIdiomaElegidoElAvisoSaleEnIngles(t *testing.T) {
	a := domain.Aviso{TitleKey: "notify.dm.new"}
	ingles := titleFor(a, "en")
	for _, locale := range []string{"", "  ", "pt-BR", "klingon"} {
		if got := titleFor(a, locale); got != ingles {
			t.Errorf("con locale %q quiere %q, dio %q", locale, ingles, got)
		}
	}
}

// El título que ya viene escrito es **contenido** —el nombre de un reporte, el
// de una tarjeta— y traducirlo sería traducir lo que escribió una persona.
func TestUnTituloQueYaEsContenidoNoSeToca(t *testing.T) {
	a := domain.Aviso{Title: "Se cayó el login en producción"}
	for _, locale := range []string{"en", "es", ""} {
		if got := titleFor(a, locale); got != a.Title {
			t.Errorf("con locale %q lo cambió: %q", locale, got)
		}
	}
}

// Y si vienen los dos, manda la clave: lo contrario haría que traducir o no
// dependiera del orden en que alguien rellenó el struct.
func TestConLosDosPuestosMandaLaClave(t *testing.T) {
	a := domain.Aviso{
		Title:     "New direct message",
		TitleKey:  "notify.dm.wrote",
		TitleArgs: map[string]string{"who": "Ana"},
	}
	if got := titleFor(a, "es"); got == a.Title {
		t.Fatalf("se quedó con el título escrito en vez de la clave: %q", got)
	}
}
