package domain

import (
	"regexp"
	"strings"
)

// StripAttachmentCitations quita del markdown las citas a un adjunto.
//
// Cierra el círculo que `dropRemovedAttachments` dejó a medias. Ése ya borra el
// fichero cuando se quita su imagen del texto; faltaba el otro sentido, y sin él
// borrar un adjunto citado dejaba **un enlace muerto que nadie podía reparar**
// salvo editando el markdown a mano. El daño caía donde más duele: en un
// reporte, que es el artefacto que se lee después.
//
// Se quita la cita entera y no se sustituye por una frase: cualquier frase
// tendría un idioma, y esto se escribe en un texto compartido que lee gente que
// eligió idiomas distintos. Quien borra sí se entera —el diálogo se lo dice en
// el suyo— y el texto de alrededor se queda intacto.
//
// Pura y aquí porque es lo único de este arreglo que puede **corromper texto de
// alguien**: una expresión demasiado glotona se llevaría por delante el párrafo
// que la rodea, y eso no tiene vuelta atrás.
func StripAttachmentCitations(markdown, attachmentID string) string {
	if markdown == "" || attachmentID == "" {
		return markdown
	}
	// `!?` cubre las dos formas: una imagen incrustada y un enlace a un fichero.
	//
	// `[^)]*` y no `.*`: con `.*` la coincidencia iría desde el primer `](` hasta
	// el último `)` de la línea, y una frase con dos enlaces perdería el de en
	// medio y todas las palabras entre ambos.
	re := regexp.MustCompile(`!?\[[^\]]*\]\([^)]*` + regexp.QuoteMeta(attachmentID) + `[^)]*\)`)

	// Línea a línea, y no sobre el texto entero, para poder distinguir dos casos
	// que se ven iguales al final: una línea que **sólo** tenía la imagen tiene
	// que desaparecer —dejarla vacía abre un hueco donde no había ninguno— y una
	// que tenía texto alrededor tiene que quedarse con su texto.
	lineas := strings.Split(markdown, "\n")
	out := make([]string, 0, len(lineas))
	tocado := false
	for _, linea := range lineas {
		limpia := re.ReplaceAllString(linea, "")
		if limpia == linea {
			out = append(out, linea)
			continue
		}
		tocado = true
		if strings.TrimSpace(limpia) == "" && strings.TrimSpace(linea) != "" {
			continue
		}
		out = append(out, limpia)
	}
	// Nada que quitar: se devuelve **el mismo texto**, sin normalizar nada. Este
	// camino lo recorre cada borrado de adjunto, también los que no están
	// citados, y reescribir la descripción de alguien para «arreglarle» los
	// saltos de línea es tocar lo que no se ha pedido tocar.
	if !tocado {
		return markdown
	}
	// Una imagen entre dos párrafos deja un separador a cada lado, y al irse los
	// dos se juntan en un hueco doble.
	limpio := strings.Join(out, "\n")
	return regexp.MustCompile(`\n{3,}`).ReplaceAllString(limpio, "\n\n")
}
