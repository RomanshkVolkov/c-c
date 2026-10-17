package domain

import "strings"

// SelfNoticeKind: la clase de un aviso que un agente le manda a la persona de
// su token. Se calla con lo mismo que el resto del trabajo que te llega
// (`WorkQuiet`), y en el teléfono con el interruptor general.
const SelfNoticeKind = "agent:notice"

// SelfNoticeRequest: lo que manda el agente. Nunca a quién: es siempre la
// persona del token.
type SelfNoticeRequest struct {
	// OrgID: en qué organización aparece. Puede faltar si la persona sólo está
	// en una.
	OrgID string `json:"orgId"`
	Title string `json:"title" validate:"required,min=1,max=120"`
	Body  string `json:"body" validate:"max=1000"`
	// Link: adónde lleva al pulsarlo, una ruta de la app («/tasks?item=…»).
	Link string `json:"link" validate:"max=500"`
}

// SelfNoticeResult: lo que contesta un aviso mandado.
type SelfNoticeResult struct {
	Sent  bool   `json:"sent"`
	OrgID string `json:"orgId"`
}

// SelfNoticeOrg: una organización entre las que elegir, para que el error de
// «¿en cuál?» se pueda arreglar sin otra consulta.
type SelfNoticeOrg struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// InternalLink dice si un enlace es una ruta de la app. Un aviso lo escribe
// un agente, y lo que lleva fuera —`https://…`, `//otro.sitio`, `javascript:`—
// convertiría la campana en un sitio desde el que mandar a alguien a una
// página cualquiera con la cara de cac. Sólo rutas que empiezan por una barra
// y no por dos.
func InternalLink(s string) bool {
	return strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") && !strings.Contains(s, `\`)
}

// SelfNoticeGroup: todos los avisos de agentes de una persona en una
// organización van juntos en la campana.
func SelfNoticeGroup(userID string) string { return prefijo(groupAgent, userID) }
