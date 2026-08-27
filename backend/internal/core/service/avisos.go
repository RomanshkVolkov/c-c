package service

import (
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// avisos decide a quién le suena la campana, y es lo único que lo decide.
//
// Existe porque la respuesta no era «nadie a quien preguntar» sino «nadie que
// preguntara»: `task:comment` y `report:new` llevaban desde siempre su `case`
// en las preferencias y su pestaña en el panel, y ningún servicio escribía una
// sola fila. Lo que había era un aviso en vivo por el stream, que sólo llega si
// la app está abierta en ese instante — con la app cerrada, un cliente podía
// escribir y no quedaba constancia en ninguna parte.
//
// La regla reparte por **quién habla**, no por quién está apuntado:
//
//   - lo que llega de fuera —un reporter, o la app de un tenant— es de toda la
//     organización. Un cliente hablando no es asunto de quien se apuntó: es
//     asunto de quien pueda contestarle, y en un item que nadie ha cogido
//     todavía no hay apuntados. Ese era el caso exacto que se perdió.
//   - lo que escribe un compañero es de quien está en el hilo: responsables,
//     seguidores y quien ya escribió. Avisar a la organización entera de cada
//     nota interna convierte la campana en ruido, y el ruido es lo que hace que
//     se deje de mirar.
type avisos struct {
	inbox Notifier
	// items para «quién tiene algo que ver con esto»; orgs para «toda la casa».
	items *repository.ReportRepository
	orgs  *repository.OrganizationRepository
}

// comentario reparte el aviso de una respuesta.
//
// `actorID` se salta siempre. Que la app te cuente lo que acabas de escribir es
// el mismo fallo que este codebase ya quitó del chat y de los directos. Cuando
// habla un cliente no hay a quién saltarse —no tiene usuario en cac— y por eso
// le llega a todo el mundo, que es la intención.
func (a *avisos) comentario(externo bool, via, orgID, itemID, actorID, titulo, cuerpo string) {
	if a == nil || a.inbox == nil || orgID == "" || itemID == "" {
		return
	}
	var quienes []string
	var err error
	if externo {
		quienes, err = a.orgs.MemberIDs(orgID)
	} else {
		quienes, err = a.items.Involved(itemID)
	}
	if err != nil {
		return
	}
	a.repartir(quienes, via, orgID, itemID, actorID, "task:comment", titulo, cuerpo)
}

// reporteNuevo avisa de algo que un cliente acaba de levantar.
//
// Al responsable del proyecto, que es esa pregunta ya contestada: quién lleva
// la cuenta de ese cliente. Y a toda la organización cuando no hay ninguno
// puesto — sin ese respaldo, un proyecto sin responsable no avisaría a nadie,
// que es el mismo agujero de antes con otra forma.
func (a *avisos) reporteNuevo(via, orgID, itemID, responsable, titulo, cuerpo string) {
	if a == nil || a.inbox == nil || orgID == "" || itemID == "" {
		return
	}
	quienes := []string{responsable}
	if strings.TrimSpace(responsable) == "" {
		var err error
		if quienes, err = a.orgs.MemberIDs(orgID); err != nil {
			return
		}
	}
	a.repartir(quienes, via, orgID, itemID, "", "report:new", titulo, cuerpo)
}

// repartir escribe una fila por persona, sin repetir.
//
// El enlace no se inventa: `/tasks?task=<id>` es la ruta que abre la tarjeta
// hoy. `/reports?open=<id>` sigue existiendo sólo para las filas antiguas, y
// escribir más de ésas sería alimentar un redirect en vez de usarlo.
// asignada avisa a quien acaba de recibir trabajo.
//
// Sólo a los nuevos. Guardar responsables reemplaza la lista entera, así que sin
// la diferencia se avisaría otra vez a quien ya la tenía cada vez que alguien
// toca cualquier otro campo de la tarjeta.
//
// Es el hueco más grande que había: te ponían trabajo encima y lo único que lo
// decía era un tablero que igual no estabas mirando. Y con un agente escribiendo
// por MCP deja de ser una molestia y pasa a ser trabajo que aparece solo.
func (a *avisos) asignada(via, orgID, itemID, actorID string, nuevos []string, titulo string) {
	if a == nil || a.inbox == nil || orgID == "" || len(nuevos) == 0 {
		return
	}
	a.repartir(nuevos, via, orgID, itemID, actorID, "task:assigned", "Assigned to you", titulo)
}

// estado avisa de que algo que te toca cambió de columna.
//
// A los implicados y no a la organización: un cambio de estado interesa a quien
// lleva la tarjeta o la sigue, no a todo el mundo. Lo dispara tanto el equipo
// como un tenant por server-to-server, así que un cliente cerrando un ticket
// también llega aquí — que es justamente lo que nadie se enteraba.
func (a *avisos) estado(via, orgID, itemID, actorID, titulo, cuerpo string) {
	if a == nil || a.inbox == nil || orgID == "" || itemID == "" {
		return
	}
	quienes, err := a.items.Involved(itemID)
	if err != nil {
		return
	}
	a.repartir(quienes, via, orgID, itemID, actorID, "task:status", titulo, cuerpo)
}

func (a *avisos) repartir(quienes []string, via, orgID, itemID, actorID, clase, titulo, cuerpo string) {
	enlace := "/tasks?task=" + itemID
	vistos := make(map[string]bool, len(quienes))
	for _, uid := range quienes {
		if uid == "" || uid == actorID || vistos[uid] {
			continue
		}
		vistos[uid] = true
		a.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: orgID, Kind: clase,
			Title: titulo, Body: cuerpo, Link: enlace, Via: via,
			// En esta familia los papeles se invierten: el cuerpo es el nombre
			// de la ficha —lo que da nombre al grupo— y el título dice qué pasó
			// («Bea replied», «Moved to Done»).
			Group: domain.ItemGroup(itemID), Label: cuerpo,
		})
	}
}

// tituloDeRespuesta dice quién contestó, que es lo que el panel pinta en negrita.
//
// Con nombre cuando lo hay: «Sebastian Ramirez replied» le dice a un humano de
// un vistazo si le toca. Sin nombre, «The client replied» — nunca inventando
// uno, porque el nombre de alguien de fuera lo *afirma* su tenant y esta app no
// tiene forma de comprobarlo.
func tituloDeRespuesta(externo bool, nombre string) string {
	if !externo {
		return "New reply"
	}
	if n := strings.TrimSpace(nombre); n != "" {
		return n + " replied"
	}
	return "The client replied"
}
