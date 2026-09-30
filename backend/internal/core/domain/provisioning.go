package domain

import "time"

// ProvisioningRun es una vez que alguien aplicó algo a un servidor desde la
// app: un playbook de Ansible, o una rotación de secrets.
//
// Lo ejecuta la laptop de quien lo lanza —las llaves ssh y el `op read` de
// 1Password no salen de ahí—, así que el backend no ve la ejecución: la app
// abre la fila al empezar y la cierra al terminar con el resultado. Es lo que
// convierte «jose configuró el Traefik de tds algún día» en algo que el equipo
// puede leer: qué, a qué máquina, quién, cuándo y cómo acabó.
//
// **Aquí no viaja ningún valor.** De las variables sólo se guardan los
// nombres (`VarNames`); una contraseña de sudo o un secret resuelto de
// 1Password no tienen campo en esta estructura, y eso es la garantía — no un
// `if` que los descarte. Lo fija `TestProvisioningCarriesNoValues`.
type ProvisioningRun struct {
	BaseModel
	ServerID string `gorm:"type:varchar(36);index;not null" json:"serverId"`
	OrgID    string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	// playbook | rotate
	Kind string `gorm:"type:varchar(20);not null" json:"kind"`
	// El repo de Ansible o la carpeta desde la que se lanzó, para saber de
	// dónde salió: «ansible-swarm» y «infra-valkey-swarm» tienen playbooks
	// que se llaman igual.
	Project  string `gorm:"type:varchar(200)" json:"project"`
	Playbook string `gorm:"type:varchar(200);not null" json:"playbook"`
	// El nombre del host en el inventario (lo que va en `--limit`), que no
	// tiene por qué ser la IP del servidor: los inventarios de jose usan los
	// alias de `~/.ssh/config`.
	Target string `gorm:"type:varchar(200)" json:"target"`
	// Sólo los nombres, separados por comas.
	VarNames   string     `gorm:"type:text" json:"varNames"`
	StartedBy  string     `gorm:"type:varchar(36);not null" json:"startedBy"`
	StartedAt  time.Time  `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	ExitCode   *int       `json:"exitCode,omitempty"`
	// running | succeeded | failed | cancelled | interrupted
	Status string `gorm:"type:varchar(20);not null" json:"status"`
	// El PLAY RECAP de Ansible, que es el resumen que se lee de un vistazo.
	Summary string `gorm:"type:text" json:"summary"`
	// Las últimas líneas de la salida, ya tachadas en la laptop. Acotadas aquí
	// también: el backend no se fía de que el cliente las haya cortado.
	LogTail string `gorm:"type:text" json:"logTail"`
}

const (
	ProvisioningKindPlaybook = "playbook"
	ProvisioningKindRotate   = "rotate"

	ProvisioningRunning     = "running"
	ProvisioningSucceeded   = "succeeded"
	ProvisioningFailed      = "failed"
	ProvisioningCancelled   = "cancelled"
	ProvisioningInterrupted = "interrupted"

	// Cuánto log se guarda por ejecución. Lo que importa de una ejecución
	// fallida está al final; lo de arriba es la instalación de paquetes.
	ProvisioningTailLines = 200
	ProvisioningTailBytes = 64 << 10
)

// StartProvisioningRequest abre la fila al empezar.
type StartProvisioningRequest struct {
	Kind     string   `json:"kind"     validate:"required,oneof=playbook rotate"`
	Project  string   `json:"project"  validate:"max=200"`
	Playbook string   `json:"playbook" validate:"required,max=200"`
	Target   string   `json:"target"   validate:"max=200"`
	VarNames []string `json:"varNames" validate:"max=100,dive,max=120"`
}

// FinishProvisioningRequest la cierra con el resultado.
type FinishProvisioningRequest struct {
	Status   string `json:"status"   validate:"required,oneof=succeeded failed cancelled interrupted"`
	ExitCode *int   `json:"exitCode"`
	Summary  string `json:"summary"`
	LogTail  string `json:"logTail"`
}

// ProvisioningRunResponse añade el nombre de quien la lanzó, para pintarlo.
type ProvisioningRunResponse struct {
	ProvisioningRun
	StartedByName string `json:"startedByName"`
}
