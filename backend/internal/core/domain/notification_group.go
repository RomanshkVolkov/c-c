package domain

import (
	"net/url"
	"strings"
)

// De qué conversación es un aviso.
//
// La campana pliega en una sola fila todo lo que viene del mismo sitio: diez
// mensajes de un canal son una línea con un contador, no diez. Para eso hace
// falta una clave que diga «esto y aquello son el mismo sitio», y este fichero
// es el único que decide cómo se escribe.
//
// **Las claves no se escriben a mano en ninguna parte.** Si un sitio pusiera
// `"space:"+id` y otro `"space-"+id`, los dos serían válidos, ninguno daría
// error, y sus avisos **nunca se agruparían juntos** — un fallo sin excepción,
// sin traza en el log y sin nada que lo delate salvo mirar la campana y ver dos
// filas del mismo canal. La gramática tiene que ser imposible de falsificar, y
// por eso se pasa por estas constructoras.

const (
	groupChannel = "space"
	groupDM      = "dm"
	groupItem    = "item"
	groupMeeting = "meeting"
)

// ChannelGroup: todo lo que pasa en un canal —mensajes y menciones— es del
// mismo sitio.
func ChannelGroup(spaceID string) string { return prefijo(groupChannel, spaceID) }

// DMGroup: una conversación privada.
func DMGroup(conversationID string) string { return prefijo(groupDM, conversationID) }

// ItemGroup: una tarea o un reporte. Los comentarios, las asignaciones y los
// cambios de estado de la misma ficha van juntos.
func ItemGroup(itemID string) string { return prefijo(groupItem, itemID) }

// MeetingGroup: **la reunión**, no su sala.
//
// Dos reuniones semanales distintas pueden ocurrir en el mismo canal, así que
// agruparlas por sala juntaría la daily con la retro. Confundir dos citas del
// calendario es peor que no plegarlas.
func MeetingGroup(meetingID string) string { return prefijo(groupMeeting, meetingID) }

func prefijo(familia, id string) string {
	if id == "" {
		return ""
	}
	return familia + ":" + id
}

// DeriveGroup reconstruye la clave de una fila escrita antes de que existiera la
// columna.
//
// Vive en el servidor y no en la app **a propósito**. Si el cliente dedujera por
// su cuenta habría dos algoritmos obligados a estar de acuerdo para siempre, y
// el día que discreparan las filas viejas y las nuevas del mismo canal formarían
// dos grupos: un fallo que se ve raro y no se explica. Además la app de
// escritorio se actualiza a mano, así que una regla puesta en el cliente se
// congela en las builds que nadie ha actualizado.
//
// **La familia sale del `kind`; el enlace sólo aporta el id.** Ésa es la regla
// entera, y no es un detalle: `/chat?space=X` es tanto un mensaje de ese canal
// como el recordatorio de una reunión que ocurre ahí. Deducir la familia del
// enlace metería las dos cosas en el mismo grupo.
//
// Devuelve `""` cuando no se puede saber, y eso significa «no agrupable»: la
// campana la pinta suelta, exactamente como antes de que existiera todo esto. El
// fallo degradado es «como antes», nunca «en el grupo equivocado».
func DeriveGroup(kind, link string) string {
	switch {
	case strings.HasPrefix(kind, "chat:"):
		return ChannelGroup(paramDe(link, "space"))
	case strings.HasPrefix(kind, "dm:"):
		return DMGroup(paramDe(link, "c"))
	case strings.HasPrefix(kind, "task:"), strings.HasPrefix(kind, "report:"):
		id := paramDe(link, "task")
		if id == "" {
			// `open` es el formato viejo de la pantalla de reportes, y sigue
			// vivo en filas de hace meses.
			id = paramDe(link, "open")
		}
		return ItemGroup(id)
	default:
		// Incluye `meeting:*`: una fila antigua lleva el enlace de la sala y
		// **ninguna identidad de la reunión**, así que no hay nada que deducir.
		// No se la puede arreglar, sólo dejarla suelta.
		return ""
	}
}

// paramDe saca un parámetro de una ruta interna como `/chat?space=abc`.
func paramDe(link, nombre string) string {
	i := strings.IndexByte(link, '?')
	if i < 0 {
		return ""
	}
	valores, err := url.ParseQuery(link[i+1:])
	if err != nil {
		return ""
	}
	return valores.Get(nombre)
}

// Aviso es lo que se le deja a alguien en la campana.
//
// Un struct y no una lista de parámetros porque son nueve cadenas y seis de
// ellas —título, cuerpo, enlace, vía, clave y rótulo— son del mismo tipo: dos
// intercambiadas compilan sin una queja y el fallo sale por la pantalla de todo
// el mundo.
//
// A cambio se pierde lo que daba la lista de parámetros: el compilador ya no
// obliga a contestar. Un literal que omita `Group` es válido, así que
// `NotificationService.Notify` lo deduce cuando falta — ver ahí.
type Aviso struct {
	UserID string
	OrgID  string
	Kind   string
	Title  string
	Body   string
	Link   string
	// Via: por dónde entró la acción. Ver via.go.
	Via string
	// Group: de qué conversación es. **Siempre por las constructoras de arriba.**
	Group string
	// Label: cómo se llama esa conversación para un humano.
	Label string
	// TitleKey y TitleArgs: el título **sin escribir todavía**.
	//
	// Puestos, mandan sobre `Title`: el servicio los resuelve en el idioma de
	// quien va a leer la fila, que no es el de quien la provocó. Ana escribe en
	// castellano y a Bob le llega «Ana wrote to you» — eso es lo que no se
	// puede hacer si la frase se arma en el sitio que la causa.
	//
	// `Title` sigue existiendo y sigue valiendo: hay avisos cuyo título es
	// contenido de una persona —el nombre de un reporte— y ésos no se traducen
	// ni se deben traducir.
	TitleKey  string
	TitleArgs map[string]string
}

// Frase es un título **sin escribir todavía**: la clave del catálogo y sus
// huecos.
//
// Existe para que los servicios que provocan un aviso dejen de armar la frase.
// El que la provoca no sabe quién la va a leer —chat y directos publican para
// varias personas a la vez— y una fila de la bandeja se escribe una vez y se lee
// meses después. Quien resuelve el idioma es `Notify`, que es el único punto que
// conoce al destinatario.
type Frase struct {
	Clave string
	Args  map[string]string
}

// FraseDeEstado dice a qué columna se movió algo.
//
// **Una clave entera por estado**, no una plantilla con el nombre dentro. La
// primera versión metía el rótulo como argumento, y eso obligaba a resolver una
// clave dentro de otra: una mini-lengua en el catálogo por cuatro frases.
//
// Con una clave por caso, cada idioma escribe la oración completa y con la
// concordancia que le toque — «Moved to Done», «Movida a Hecha»— que es la misma
// regla que ya siguen los plurales y la regla de una reunión.
//
// El identificador nunca sale: antes esto concatenaba `"Moved to " + next` y
// escribía literalmente «Moved to in_progress», que ya estaba mal en inglés.
// Un estado que el catálogo no conozca cae en la clave genérica.
func FraseDeEstado(estado string) Frase {
	switch estado {
	case "open", "in_progress", "done", "closed":
		return Frase{Clave: "notify.item.moved." + estado}
	default:
		return Frase{Clave: "notify.item.moved", Args: map[string]string{"status": estado}}
	}
}
