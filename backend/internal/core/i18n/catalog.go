package i18n

// El catálogo del servidor.
//
// Deliberadamente corto: aquí sólo entra lo que **el servidor** escribe para
// una persona. Todo lo que se pinta en una pantalla vive en los catálogos del
// cliente, que es donde se puede cambiar de idioma sin desplegar nada.
//
// Las claves de error son **la etiqueta de código que ya viaja** en cada
// `SendErrorResponse` —`inbox-other-org`, `rate-limited`—, no una clave nueva.
// Esa etiqueta ya era el contrato estable y la frase ya estaba declarada como
// decorativa; lo único que cambia es quién escribe la frase.
var catalogo = map[string]map[Locale]string{
	// ── Avisos de la bandeja ────────────────────────────────────────────────
	// Se escriben una vez, en el idioma de quien los va a leer.
	"notify.dm.wrote": {
		EN: "{{who}} wrote to you",
		ES: "{{who}} te escribió",
	},
	"notify.dm.new": {
		EN: "New direct message",
		ES: "Mensaje directo nuevo",
	},

	// Un agente —o alguien— cambió un documento y pide que se lea.
	"notify.doc.review": {
		EN: "Review requested · {{doc}}",
		ES: "Revisión pedida · {{doc}}",
	},
	"notify.report.new": {
		EN: "New report · {{folio}}",
		ES: "Reporte nuevo · {{folio}}",
	},
	"notify.reply.new": {
		EN: "New reply",
		ES: "Respuesta nueva",
	},
	"notify.reply.by": {
		EN: "{{who}} replied",
		ES: "{{who}} respondió",
	},
	"notify.reply.client": {
		EN: "The client replied",
		ES: "El cliente respondió",
	},
	"notify.item.moved": {
		EN: "Moved to {{status}}",
		ES: "Movida a {{status}}",
	},
	"notify.chat.mentioned": {
		EN: "Mentioned in {{where}}",
		ES: "Te nombraron en {{where}}",
	},
	"notify.item.assigned": {
		EN: "Assigned to you",
		ES: "Te la asignaron",
	},
	"notify.item.moved.open": {
		EN: "Reopened",
		ES: "Reabierta",
	},
	"notify.item.moved.in_progress": {
		EN: "Moved to In progress",
		ES: "Movida a En curso",
	},
	"notify.item.moved.done": {
		EN: "Marked as done",
		ES: "Marcada como hecha",
	},
	"notify.item.moved.closed": {
		EN: "Closed",
		ES: "Cerrada",
	},

	// La actividad de CI (R9): un run que terminó, un deploy que acabó.
	"notify.ci.run.success": {
		EN: "{{workflow}} passed on {{branch}}",
		ES: "{{workflow}} pasó en {{branch}}",
	},
	"notify.ci.run.failure": {
		EN: "{{workflow}} failed on {{branch}}",
		ES: "{{workflow}} falló en {{branch}}",
	},
	"notify.ci.run.cancelled": {
		EN: "{{workflow}} was cancelled on {{branch}}",
		ES: "{{workflow}} se canceló en {{branch}}",
	},
	"notify.ci.run": {
		EN: "{{workflow}} finished: {{conclusion}} · {{branch}}",
		ES: "{{workflow}} terminó: {{conclusion}} · {{branch}}",
	},
	"notify.deploy.succeeded": {
		EN: "{{service}} deployed · {{sha}}",
		ES: "{{service}} desplegado · {{sha}}",
	},
	"notify.deploy.failed": {
		EN: "{{service}} deploy failed · {{sha}}",
		ES: "Falló el deploy de {{service}} · {{sha}}",
	},
	"notify.deploy.expired": {
		EN: "{{service}} deploy expired: the agent stopped responding · {{sha}}",
		ES: "Caducó el deploy de {{service}}: el agente dejó de contestar · {{sha}}",
	},
	"notify.telemetry.silent": {
		EN: "{{device}} stopped sending",
		ES: "{{device}} dejó de mandar",
	},
	"notify.telemetry.back": {
		EN: "{{device}} is sending again",
		ES: "{{device}} volvió a mandar",
	},
	"notify.telemetry.unhealthy": {
		EN: "{{device}} needs attention",
		ES: "{{device}} necesita atención",
	},
	"notify.telemetry.healthy": {
		EN: "{{device}} is healthy again",
		ES: "{{device}} volvió a estar bien",
	},

	// ── Errores de la API ───────────────────────────────────────────────────
	"unauthorized": {
		EN: "Unauthorized",
		ES: "Sin autorización",
	},
	"invalid-request": {
		EN: "Invalid request",
		ES: "Petición inválida",
	},
	"not-found": {
		EN: "Not found",
		ES: "No se encontró",
	},
	"forbidden": {
		EN: "Forbidden",
		ES: "Sin permiso",
	},
	"rate-limited": {
		EN: "Too many requests",
		ES: "Demasiadas peticiones",
	},
	"inbox-other-org": {
		EN: "That list belongs to another organization",
		ES: "Esa lista es de otra organización",
	},
}
