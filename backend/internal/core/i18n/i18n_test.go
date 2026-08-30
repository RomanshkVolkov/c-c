package i18n

import "testing"

// La cabecera es el sitio donde esto se equivoca sin que nadie se entere: una
// respuesta en el idioma que no era no rompe nada, sólo se lee mal.
func TestElOrdenDeLaCabeceraNoEsElDeLaPreferencia(t *testing.T) {
	casos := []struct {
		nombre   string
		cabecera string
		quiere   Locale
	}{
		{"la forma normal de un navegador", "es-MX,es;q=0.9,en;q=0.8", ES},
		{"sin q manda el orden del texto", "es,en", ES},
		{"y al revés también", "en,es", EN},
		// El que importa: el texto empieza por inglés pero la q dice otra cosa.
		{"la q manda sobre el orden", "en;q=0.5,es;q=0.9", ES},
		{"un idioma que no hablamos se salta", "fr-FR,fr;q=0.9,es;q=0.8", ES},
		{"ninguno conocido cae al inglés", "fr,de,ja", EN},
		{"vacía cae al inglés", "", EN},
		{"basura cae al inglés", ";;;q=", EN},
		// `q=0` es un «esto no» expreso, no una preferencia floja.
		{"q=0 se descarta en vez de rebajarse", "es;q=0,fr;q=0.1", EN},
		{"la región no crea un catálogo aparte", "es-419", ES},
		{"el guión bajo también", "es_MX", ES},
		{"las mayúsculas dan igual", "ES-mx", ES},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			if got := FromAcceptLanguage(c.cabecera); got != c.quiere {
				t.Fatalf("%q: quiere %q, dio %q", c.cabecera, c.quiere, got)
			}
		})
	}
}

func TestLaPreferenciaGuardadaSeLeeIgualQueLaCabecera(t *testing.T) {
	casos := map[string]Locale{"es": ES, "es-MX": ES, "en": EN, "": EN, "  ES  ": ES, "pt": EN}
	for pref, quiere := range casos {
		if got := Resolve(pref); got != quiere {
			t.Fatalf("%q: quiere %q, dio %q", pref, quiere, got)
		}
	}
}

func TestLaFraseSaleEnElIdiomaQueSePide(t *testing.T) {
	en := T(EN, "notify.dm.wrote", map[string]string{"who": "Ana"})
	es := T(ES, "notify.dm.wrote", map[string]string{"who": "Ana"})
	if en == es {
		t.Fatalf("los dos idiomas dicen lo mismo: %q", en)
	}
	for _, s := range []string{en, es} {
		if !contiene(s, "Ana") {
			t.Fatalf("el nombre no se interpoló: %q", s)
		}
		if contiene(s, "{{") {
			t.Fatalf("quedó un hueco sin rellenar: %q", s)
		}
	}
}

// Sin esto, una clave con una errata devolvería una cadena vacía y la fila de
// la bandeja saldría sin título — invisible, que es el peor de los fallos.
func TestUnaClaveQueNoExisteSeVe(t *testing.T) {
	if got := T(EN, "no.existe", nil); got != "no.existe" {
		t.Fatalf("quiere la clave de vuelta, dio %q", got)
	}
}

// La red del catálogo: todas las claves en los dos idiomas. Una que falte en
// castellano sale en inglés sin avisar, que es como se queda medio traducido.
func TestLosDosIdiomasDicenLoMismo(t *testing.T) {
	for clave, frases := range catalogo {
		for _, l := range []Locale{EN, ES} {
			frase, ok := frases[l]
			if !ok {
				t.Errorf("«%s» no está en %q", clave, l)
				continue
			}
			if frase == "" {
				t.Errorf("«%s» está vacía en %q", clave, l)
			}
		}
		if frases[EN] == frases[ES] {
			t.Errorf("«%s» dice lo mismo en los dos idiomas", clave)
		}
	}
}

// Los huecos tienen que ser los mismos: si el castellano pide `{{name}}` y el
// inglés `{{who}}`, uno de los dos sale con el hueco a la vista.
func TestLosHuecosSonLosMismosEnLosDosIdiomas(t *testing.T) {
	for clave, frases := range catalogo {
		if huecos(frases[EN]) != huecos(frases[ES]) {
			t.Errorf("«%s»: %q pide %v y %q pide %v",
				clave, EN, huecos(frases[EN]), ES, huecos(frases[ES]))
		}
	}
}

func huecos(s string) string {
	var out []byte
	for i := 0; i+1 < len(s); i++ {
		if s[i] == '{' && s[i+1] == '{' {
			j := i + 2
			for j+1 < len(s) && !(s[j] == '}' && s[j+1] == '}') {
				j++
			}
			out = append(out, s[i+2:j]...)
			out = append(out, ' ')
			i = j
		}
	}
	return string(out)
}

func contiene(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
