package domain

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// ─── La configuración de un servidor, en cac ──────────────────────────────────
//
// El repo de Ansible (`infra/ansible`) tiene el **cómo**: playbooks, roles y el
// esquema de las variables de cada playbook. cac tiene el **qué** de cada
// servidor: con qué plantilla se monta, sus valores (dominio, puerto SSH,
// versiones…) y **dónde** están sus secretos en 1Password. Ver la decisión del
// 31-oct-2026 y la página «Diseño · Config de servidores en cac».
//
// Todo se versiona: guardar crea una fila nueva y nunca pisa la anterior, para
// que se pueda leer cómo estaba un servidor cuando se le aplicó algo y volver a
// ello. Restaurar es guardar una vieja como nueva.
//
// **Ningún valor de un secreto.** Los secretos van por nombre → referencia
// (`OpRefs`, como `DeployableSecretRef.OpRef`), y un secreto disfrazado de
// variable se rechaza (`ValidateConfigVars`): ni por el nombre (`*_password`,
// una de las que la plantilla declara secretas) ni por la forma (un `op://`).
// Lo fija `TestNoSecretTypeCarriesAValue` para los tipos, y las pruebas de
// `ValidateConfigVars` para el contenido de los mapas, que el decodificador
// estricto no mira.

// ServerTemplate: una forma de montar un servidor, con nombre, de una org.
// Lo que lleva está en sus versiones.
type ServerTemplate struct {
	BaseModel
	OrgID       string `gorm:"type:varchar(36);not null;uniqueIndex:idx_server_template_name" json:"orgId"`
	Name        string `gorm:"type:varchar(100);not null;uniqueIndex:idx_server_template_name" json:"name"`
	Description string `gorm:"type:text" json:"description"`
	CreatedBy   string `gorm:"type:varchar(36);not null" json:"createdBy"`
}

// ServerTemplateVersion: lo que una plantilla dice en un momento.
type ServerTemplateVersion struct {
	BaseModel
	TemplateID string `gorm:"type:varchar(36);not null;uniqueIndex:idx_server_template_seq" json:"templateId"`
	Seq        int    `gorm:"not null;uniqueIndex:idx_server_template_seq" json:"seq"`
	// Los playbooks del manifiesto que la componen, **en orden**: «Swarm con
	// Traefik y Valkey» es `[baseline, swarm, valkey]`. Aplicar la plantilla
	// los corre así y para en el primero que falla.
	Playbooks []string `gorm:"type:jsonb;serializer:json" json:"playbooks"`
	// Valores compartidos por los playbooks de la secuencia: versiones,
	// imágenes, CIDRs, email de ACME… Un servidor los pisa con los suyos.
	Vars map[string]any `gorm:"type:jsonb;serializer:json" json:"vars"`
	// Nombres de los secretos que un servidor con esta plantilla tiene que
	// traer como referencia (`OPS_PASSWORD`, `CLOUDFLARE_DNS_TOKEN`).
	Requires []string `gorm:"type:jsonb;serializer:json" json:"requires"`
	// De ésos, los que son de cada máquina y no se copian al basar un servidor
	// en otro: dos servidores no comparten la contraseña de sudo.
	PerServer []string `gorm:"type:jsonb;serializer:json" json:"perServer"`
	CreatedBy string   `gorm:"type:varchar(36);not null" json:"createdBy"`
	// app | mcp: si la guardó una persona en la app o un agente con su token.
	Source string `gorm:"type:varchar(10);not null" json:"source"`
	Note   string `gorm:"type:text" json:"note"`
}

// ServerConfigVersion: la configuración de un servidor en un momento.
type ServerConfigVersion struct {
	BaseModel
	OrgID    string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	ServerID string `gorm:"type:varchar(36);not null;uniqueIndex:idx_server_config_seq" json:"serverId"`
	Seq      int    `gorm:"not null;uniqueIndex:idx_server_config_seq" json:"seq"`
	// La plantilla, clavada a una versión: cambiar la plantilla no cambia lo
	// que un servidor ya tenía hasta que se guarda una config nueva.
	TemplateID  string `gorm:"type:varchar(36)" json:"templateId"`
	TemplateSeq int    `json:"templateSeq"`
	// Lo propio del servidor (dominio, puerto SSH, llaves autorizadas) y lo que
	// pisa de la plantilla.
	Vars map[string]any `gorm:"type:jsonb;serializer:json" json:"vars"`
	// Nombre del secreto → referencia de 1Password. Nunca un valor.
	OpRefs    map[string]string `gorm:"type:jsonb;serializer:json" json:"opRefs"`
	CreatedBy string            `gorm:"type:varchar(36);not null" json:"createdBy"`
	Source    string            `gorm:"type:varchar(10);not null" json:"source"`
	Note      string            `gorm:"type:text" json:"note"`
	// De dónde salió, si se copió de otro servidor.
	BasedOn *ConfigOrigin `gorm:"type:jsonb;serializer:json" json:"basedOn,omitempty"`
}

// ConfigOrigin: de qué se copió una config.
type ConfigOrigin struct {
	ServerID string `json:"serverId"`
	Seq      int    `json:"seq"`
}

// AppliedConfig: la foto de lo que se aplicó en una ejecución. Las variables
// ya combinadas y los secretos **por referencia**.
type AppliedConfig struct {
	Vars   map[string]any    `json:"vars"`
	OpRefs map[string]string `json:"opRefs"`
}

const (
	ConfigSourceApp = "app"
	ConfigSourceMCP = "mcp"

	// Lo que se guarda de una config o una plantilla, como JSON. Holgado para
	// cientos de variables; más es alguien metiendo un fichero.
	MaxConfigBytes = 64 << 10
	// Playbooks por plantilla.
	MaxTemplatePlaybooks = 20
)

// ─── Requests / Responses ─────────────────────────────────────────────────────

// PutServerConfigRequest guarda una versión nueva. Sin `basedOnServerId`, lo
// que se manda es la config entera; con él, se copia la última de ese servidor
// (de la misma org) menos sus secretos `perServer`, y lo que se mande encima
// la pisa.
type PutServerConfigRequest struct {
	TemplateID      string            `json:"templateId"      validate:"omitempty,max=36"`
	TemplateSeq     int               `json:"templateSeq"     validate:"min=0"`
	Vars            map[string]any    `json:"vars"`
	OpRefs          map[string]string `json:"opRefs"`
	Note            string            `json:"note"            validate:"max=500"`
	BasedOnServerID string            `json:"basedOnServerId" validate:"omitempty,max=36"`
}

// CreateServerTemplateRequest crea una plantilla con su primera versión.
type CreateServerTemplateRequest struct {
	Name        string `json:"name"        validate:"required,min=1,max=100"`
	Description string `json:"description" validate:"max=2000"`
	PutServerTemplateRequest
}

// PutServerTemplateRequest guarda una versión nueva de una plantilla.
type PutServerTemplateRequest struct {
	Playbooks []string       `json:"playbooks" validate:"required,min=1"`
	Vars      map[string]any `json:"vars"`
	Requires  []string       `json:"requires"`
	PerServer []string       `json:"perServer"`
	Note      string         `json:"note"      validate:"max=500"`
}

// ServerConfigVersionResponse añade quién la guardó, para pintarlo.
type ServerConfigVersionResponse struct {
	ServerConfigVersion
	CreatedByName string `json:"createdByName"`
}

type ServerTemplateVersionResponse struct {
	ServerTemplateVersion
	CreatedByName string `json:"createdByName"`
}

// ServerTemplateResponse: la plantilla con su última versión.
type ServerTemplateResponse struct {
	ServerTemplate
	Current *ServerTemplateVersionResponse `json:"current"`
}

// ServerConfigSummary: la config actual de un servidor y la lista de sus
// versiones (sin cuerpo: se piden por `seq`).
type ServerConfigSummary struct {
	Current  *ServerConfigVersionResponse  `json:"current"`
	Versions []ServerConfigVersionResponse `json:"versions"`
}

// EffectiveConfig: lo que se aplicaría ahora. La plantilla combinada con lo
// del servidor, más la conexión, calculado en un solo sitio para que la app,
// el MCP y la terminal vean lo mismo.
type EffectiveConfig struct {
	ServerID     string            `json:"serverId"`
	ConfigSeq    int               `json:"configSeq"`
	TemplateID   string            `json:"templateId,omitempty"`
	TemplateName string            `json:"templateName,omitempty"`
	TemplateSeq  int               `json:"templateSeq,omitempty"`
	Playbooks    []string          `json:"playbooks"`
	Vars         map[string]any    `json:"vars"`
	OpRefs       map[string]string `json:"opRefs"`
	Requires     []string          `json:"requires"`
	PerServer    []string          `json:"perServer"`
	// Los que la plantilla pide y el servidor aún no tiene.
	Missing    []string         `json:"missing"`
	Connection ServerConnection `json:"connection"`
}

// ServerConnection: cómo se entra, del registro del servidor.
type ServerConnection struct {
	Name    string `json:"name"`
	Host    string `json:"host"`
	SSHPort int    `json:"sshPort"`
	SSHUser string `json:"sshUser"`
}

// ─── Validación ───────────────────────────────────────────────────────────────

var (
	ErrBadVarName      = errors.New("bad-var-name")
	ErrSecretInVars    = errors.New("secret-in-vars")
	ErrBadPlaybookID   = errors.New("bad-playbook-id")
	ErrConfigTooLarge  = errors.New("config-too-large")
	ErrPerServerNotReq = errors.New("per-server-not-required")
	ErrBadConfigRef    = errors.New("bad-op-ref")
	ErrBadConfigSecret = errors.New("bad-secret-name")
)

// VarNamePattern: un nombre de variable de Ansible.
var VarNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// PlaybookIDPattern: el `id` de un playbook en `cac.playbooks.yml`.
var PlaybookIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Lo que un nombre de variable dice de sí mismo cuando es un secreto.
var secretVarSuffixes = []string{"_password", "_passwd", "_pass", "_token", "_secret", "_passphrase", "_private_key"}

// ansible_become_password y compañía: si entraran como variable, el valor
// viajaría en claro y quedaría guardado.
var secretVarNames = map[string]bool{
	"ansible_become_password": true, "ansible_become_pass": true,
	"ansible_password": true, "ansible_ssh_pass": true, "ansible_ssh_password": true,
	"password": true, "token": true, "secret": true,
}

// ValidateConfigVars: las variables de una config o una plantilla no pueden
// llevar un secreto. Ni por el nombre —uno de `requires` (comparado sin
// mayúsculas: `OPS_PASSWORD` es `ops_password`), o uno que termina en
// `_password`, `_token`…— ni por la forma: un valor que es una referencia
// (`op://`) se guardaría como texto y nadie lo leería de 1Password.
func ValidateConfigVars(vars map[string]any, requires []string) error {
	req := map[string]bool{}
	for _, r := range requires {
		req[strings.ToLower(r)] = true
	}
	for k, v := range vars {
		if !VarNamePattern.MatchString(k) {
			return ErrBadVarName
		}
		low := strings.ToLower(k)
		if req[low] || secretVarNames[low] {
			return ErrSecretInVars
		}
		for _, suf := range secretVarSuffixes {
			if strings.HasSuffix(low, suf) {
				return ErrSecretInVars
			}
		}
		if carriesRef(v) {
			return ErrSecretInVars
		}
	}
	if b, _ := json.Marshal(vars); len(b) > MaxConfigBytes {
		return ErrConfigTooLarge
	}
	return nil
}

// carriesRef: alguna cadena, a cualquier profundidad, es una referencia.
func carriesRef(v any) bool {
	switch x := v.(type) {
	case string:
		s := strings.TrimSpace(x)
		return strings.HasPrefix(s, "op://") || strings.HasPrefix(s, "op-env://")
	case []any:
		for _, e := range x {
			if carriesRef(e) {
				return true
			}
		}
	case map[string]any:
		for _, e := range x {
			if carriesRef(e) {
				return true
			}
		}
	}
	return false
}

// ValidateOpRefs: cada nombre es el de un secreto y cada valor una referencia
// de 1Password. Un valor que no es una referencia es, casi seguro, el secreto
// pegado: se rechaza.
func ValidateOpRefs(refs map[string]string) error {
	for k, v := range refs {
		if !SecretNamePattern.MatchString(k) {
			return ErrBadConfigSecret
		}
		if !ValidSecretRef(strings.TrimSpace(v)) {
			return ErrBadConfigRef
		}
	}
	return nil
}

// ValidateTemplate: una versión de plantilla bien formada.
func ValidateTemplate(req PutServerTemplateRequest) error {
	if len(req.Playbooks) == 0 || len(req.Playbooks) > MaxTemplatePlaybooks {
		return ErrBadPlaybookID
	}
	for _, p := range req.Playbooks {
		if !PlaybookIDPattern.MatchString(p) {
			return ErrBadPlaybookID
		}
	}
	required := map[string]bool{}
	for _, r := range req.Requires {
		if !SecretNamePattern.MatchString(r) {
			return ErrBadConfigSecret
		}
		required[r] = true
	}
	for _, p := range req.PerServer {
		if !required[p] {
			return ErrPerServerNotReq
		}
	}
	return ValidateConfigVars(req.Vars, req.Requires)
}

// MergeVars: lo de la plantilla con lo del servidor encima. Plano: una clave
// del servidor sustituye entera a la de la plantilla, también si es una lista
// o un mapa. Combinar en profundidad haría imposible quitar un elemento.
func MergeVars(template, server map[string]any) map[string]any {
	out := make(map[string]any, len(template)+len(server))
	for k, v := range template {
		out[k] = v
	}
	for k, v := range server {
		out[k] = v
	}
	return out
}
