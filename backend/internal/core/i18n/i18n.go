// Package i18n dice, en el idioma de cada quien, lo que el servidor escribe
// para una persona.
//
// Son dos casos y no se parecen en nada más que en la traducción:
//
//   - Lo **efímero**: el mensaje de un error de la API. Se decide con la
//     cabecera `Accept-Language` de esa llamada y muere con la respuesta.
//   - Lo **persistido**: la fila de un aviso en la bandeja. Se escribe una vez
//     y se lee meses después, así que se decide con el idioma **de quien la va
//     a leer** —no el de quien la provocó— y ya no se puede cambiar.
//
// Lo segundo es lo que obliga a que esto exista en el servidor. Traducir en el
// cliente valdría para los errores; para la bandeja no, porque la frase ya está
// escrita en la base de datos cuando el cliente la ve.
//
// **Sin dependencias y sin plurales.** El catálogo es un mapa y la
// interpolación un `Replacer`: lo que el servidor escribe son media docena de
// frases con un nombre dentro, no prosa. El día que una necesite plural, la
// respuesta es una clave por forma y no traerse ICU entero.
package i18n

import (
	"sort"
	"strconv"
	"strings"
)

// Locale es uno de los idiomas que el producto habla de verdad.
type Locale string

const (
	EN Locale = "en"
	ES Locale = "es"
)

// EN es la reserva y el idioma base: es en el que está escrito el producto, así
// que es el único que se sabe entero. Una clave que falte en otro sale en
// inglés — feo, pero legible, que es mejor que un hueco.
const Fallback = EN

var supported = map[Locale]bool{EN: true, ES: true}

// Resolve convierte lo que se sepa de alguien en un idioma que existe.
//
// Acepta la etiqueta entera —`es-MX`, `es_419`— y se queda con el prefijo: son
// el mismo catálogo, y mantener uno por región sería prometer una diferencia
// que no hay. Lo vacío y lo desconocido caen al inglés.
func Resolve(pref string) Locale {
	if l, ok := Known(pref); ok {
		return l
	}
	return Fallback
}

// Known separa «me pides inglés» de «no te entiendo», que para `Resolve` son
// la misma respuesta y para leer una cabecera no lo son.
func Known(etiqueta string) (Locale, bool) {
	base := strings.ToLower(strings.TrimSpace(etiqueta))
	if i := strings.IndexAny(base, "-_"); i > 0 {
		base = base[:i]
	}
	if supported[Locale(base)] {
		return Locale(base), true
	}
	return Fallback, false
}

// FromAcceptLanguage lee la cabecera de una petición.
//
// `es-MX,es;q=0.9,en;q=0.8` es la forma normal, y el orden del texto **no** es
// el de preferencia: lo es la `q`, que por omisión vale 1. Recorrerla de
// izquierda a derecha funciona casi siempre y falla justo cuando alguien ha
// tocado sus preferencias a mano, que es precisamente quien se da cuenta.
//
// Se devuelve el primero que sepamos hablar, no el primero a secas: quien pide
// «francés, y si no castellano» quiere castellano y no inglés.
func FromAcceptLanguage(header string) Locale {
	type candidato struct {
		lang  Locale
		q     float64
		orden int
	}
	var cands []candidato
	for i, trozo := range strings.Split(header, ",") {
		partes := strings.Split(strings.TrimSpace(trozo), ";")
		etiqueta := strings.TrimSpace(partes[0])
		if etiqueta == "" {
			continue
		}
		q := 1.0
		for _, p := range partes[1:] {
			p = strings.TrimSpace(p)
			if v, ok := strings.CutPrefix(p, "q="); ok {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					q = f
				}
			}
		}
		// `q=0` significa «esto no, expresamente». Tratarlo como uno más lo
		// convertiría en una preferencia débil, que es lo contrario.
		if q <= 0 {
			continue
		}
		cands = append(cands, candidato{lang: Locale(etiqueta), q: q, orden: i})
	}
	// Estable en el empate: `es,en` sin `q` son los dos 1, y ahí manda el orden.
	sort.SliceStable(cands, func(a, b int) bool {
		if cands[a].q != cands[b].q {
			return cands[a].q > cands[b].q
		}
		return cands[a].orden < cands[b].orden
	})
	for _, c := range cands {
		// `Resolve` no vale aquí: cae al inglés tanto cuando le piden inglés
		// como cuando no entiende nada, y esa diferencia es justo la que hace
		// falta — «fr» no es una respuesta, es un «sigue mirando la lista».
		if l, ok := Known(string(c.lang)); ok {
			return l
		}
	}
	return Fallback
}

// T dice la frase de `key` en `l`, con `args` metidos donde el catálogo los
// pida como `{{nombre}}`.
//
// Una clave que no exista devuelve **la propia clave**. Es el mismo trato que
// en el cliente y por el mismo motivo: en pantalla se ve rara —que es como se
// entera alguien— y no deja un hueco donde debería haber una frase.
func T(l Locale, key string, args map[string]string) string {
	frases, ok := catalogo[key]
	if !ok {
		return key
	}
	frase, ok := frases[l]
	if !ok {
		frase = frases[Fallback]
	}
	if len(args) == 0 {
		return frase
	}
	pares := make([]string, 0, len(args)*2)
	for k, v := range args {
		pares = append(pares, "{{"+k+"}}", v)
	}
	return strings.NewReplacer(pares...).Replace(frase)
}
