package domain

import "context"

// Via dice **por dónde** entró una escritura: la app, o el agente por MCP.
//
// No es seguridad y no puede serlo. El servidor MCP escribe con el token de su
// dueño, así que una petición suya es indistinguible de una tuya salvo por lo
// que ella misma declare. Quien tenga tu token puede omitir la marca o mentir.
// Su trabajo es ser honesta con quien lee la campana, no impedir nada — y por
// eso se acepta tal cual llega, sin comprobaciones que darían una falsa
// sensación de garantía.
//
// Lista cerrada a propósito: sin ella, cualquier cadena acabaría pintada como
// etiqueta en el panel de todo el mundo.
const (
	ViaApp = ""    // la app de escritorio, o cualquier cliente que no diga nada
	ViaMCP = "mcp" // un agente a través del servidor MCP
)

// HeaderVia es la cabecera que lo transporta.
const HeaderVia = "X-Cac-Via"

type claveVia struct{}

// NormalizeVia deja pasar sólo lo conocido; lo demás es como no haber dicho nada.
func NormalizeVia(v string) string {
	if v == ViaMCP {
		return ViaMCP
	}
	return ViaApp
}

func WithVia(ctx context.Context, via string) context.Context {
	return context.WithValue(ctx, claveVia{}, NormalizeVia(via))
}

// ViaFrom saca la marca del contexto. Un contexto sin ella —una tarea de fondo,
// un test— es la app, que es el caso corriente y el que no lleva etiqueta.
func ViaFrom(ctx context.Context) string {
	if ctx == nil {
		return ViaApp
	}
	v, _ := ctx.Value(claveVia{}).(string)
	return v
}
