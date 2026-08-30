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
