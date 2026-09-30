package domain

import (
	"regexp"
	"strings"
	"time"
)

// Deployable es un servicio de Swarm que cac sabe desplegar: qué servicio, de
// qué stack, con imágenes de qué repositorio.
//
// Registrarlo **no cambia nada en el servidor**. El servicio sigue como lo dejó
// su CI; lo que se gana es poder desplegar una versión y volver a la anterior
// desde cac, con historial de quién, cuándo y cómo acabó. Es el primer paso de
// la adopción gradual: un proyecto se suma cuando quiere, y su `prod.yml` sigue
// funcionando igual hasta que decida dejar de desplegar él.
//
// Sólo Swarm. Un servidor kubernetes se mira desde el clúster del backend y no
// tiene agente que despliegue.
type Deployable struct {
	BaseModel
	OrgID    string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	ServerID string `gorm:"type:varchar(36);index;not null" json:"serverId"`
	Name     string `gorm:"type:varchar(120);not null" json:"name"`
	// El stack y el servicio tal como los llama Docker (`beta-api-prod`,
	// `beta-api-prod_beta-api-prod-app`).
	Stack       string `gorm:"type:varchar(120);not null" json:"stack"`
	ServiceName string `gorm:"type:varchar(200);not null" json:"serviceName"`
	// El repositorio de imágenes (`ghcr.io/dwit-mexico/api`), sin tag. Toda
	// imagen que cac despliegue en este servicio tiene que ser de aquí: el agente
	// lo vuelve a comprobar y no acepta una imagen libre.
	ImageRepo   string `gorm:"type:varchar(255);not null" json:"imageRepo"`
	Environment string `gorm:"type:varchar(40)" json:"environment"`
	// El repo de código (`owner/name`), opcional. Lo usan la GitHub App y las
	// tareas; para desplegar no hace falta.
	RepoFullName string `gorm:"type:varchar(200)" json:"repoFullName"`
	// Qué hacer cuando el CI avise de una imagen nueva (R3): `record` la apunta
	// y nada más —el CI sigue desplegando él—; `deploy` la despliega.
	OnCINotify string `gorm:"type:varchar(20);not null;default:'record'" json:"onCINotify"`
	// Lo que hay desplegado según el último deploy de cac, y lo de antes, que
	// es a donde vuelve un rollback.
	CurrentImage  string `gorm:"type:varchar(400)" json:"currentImage"`
	PreviousImage string `gorm:"type:varchar(400)" json:"previousImage"`
}

// Deployment es una vez que cac desplegó (o intentó desplegar) un deployable.
type Deployment struct {
	BaseModel
	OrgID        string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	DeployableID string `gorm:"type:varchar(36);index;not null" json:"deployableId"`
	ServerID     string `gorm:"type:varchar(36);index;not null" json:"serverId"`
	// La imagen pedida (`repo:ref`), y la que quedó de verdad en el servicio,
	// con su digest clavado (`repo:ref@sha256:…`).
	Image      string `gorm:"type:varchar(400);not null" json:"image"`
	FinalImage string `gorm:"type:varchar(400)" json:"finalImage"`
	// Lo que había antes, leído del servicio al desplegar. Es a donde vuelve un
	// rollback de este deployment.
	PreviousImage string `gorm:"type:varchar(400)" json:"previousImage"`
	// user | ci | github
	RequestedBy       string     `gorm:"type:varchar(20);not null" json:"requestedBy"`
	RequestedByUserID string     `gorm:"type:varchar(36)" json:"requestedByUserId"`
	Status            string     `gorm:"type:varchar(20);not null;index" json:"status"`
	Log               string     `gorm:"type:text" json:"log,omitempty"`
	Error             string     `gorm:"type:text" json:"error"`
	StartedAt         *time.Time `json:"startedAt,omitempty"`
	FinishedAt        *time.Time `json:"finishedAt,omitempty"`
	RollbackOfID      string     `gorm:"type:varchar(36)" json:"rollbackOfId"`
	// Para que el mismo aviso del CI dos veces sea un solo deployment (R3).
	IdempotencyKey string `gorm:"type:varchar(120)" json:"-"`
}

const (
	DeployQueued     = "queued"
	DeployRunning    = "running"
	DeploySucceeded  = "succeeded"
	DeployFailed     = "failed"
	DeployRolledBack = "rolled_back"

	DeployByUser   = "user"
	DeployByCI     = "ci"
	DeployByGitHub = "github"

	// Lo más que se guarda del log de un deployment. Un deploy normal son
	// veinte líneas; esto es para que uno roto que escupe sin parar no llene la
	// base.
	DeployLogMax = 1 << 20
	// Cuánto puede estar un deployment «en curso» sin que el agente diga nada
	// antes de darlo por perdido. El agente converge en 5 min como mucho; un
	// agente que murió a medias no puede dejar el servicio bloqueado para
	// siempre, porque el siguiente deploy chocaría con él.
	DeployStaleAfter = 15 * time.Minute
)

// refPattern: lo que puede ir detrás de `repo:` — un tag seguro, con digest
// opcional. Es lo que el agente acepta, y lo comprueba él también: esto es la
// primera puerta, no la única.
var refPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(@sha256:[0-9a-f]{64})?$`)

// shaPattern: un deploy pedido a mano o por el CI es de un commit.
var shaPattern = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// ValidSha: un sha de git, corto o entero, y nada más.
func ValidSha(s string) bool { return shaPattern.MatchString(s) }

// ImageRef devuelve la parte de `image` que va tras `repo:`, si la imagen es
// de ese repositorio y la referencia es segura. Es lo que hace imposible que
// un rollback despliegue una imagen de otro sitio.
func ImageRef(repo, image string) (string, bool) {
	ref, ok := strings.CutPrefix(image, repo+":")
	if !ok || !refPattern.MatchString(ref) {
		return "", false
	}
	return ref, true
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

type CreateDeployableRequest struct {
	Name         string `json:"name"         validate:"required,max=120"`
	Stack        string `json:"stack"        validate:"required,max=120"`
	ServiceName  string `json:"serviceName"  validate:"required,max=200"`
	ImageRepo    string `json:"imageRepo"    validate:"required,max=255"`
	Environment  string `json:"environment"  validate:"max=40"`
	RepoFullName string `json:"repoFullName" validate:"max=200"`
}

type UpdateDeployableRequest struct {
	Name         string `json:"name"         validate:"required,max=120"`
	Environment  string `json:"environment"  validate:"max=40"`
	RepoFullName string `json:"repoFullName" validate:"max=200"`
	OnCINotify   string `json:"onCINotify"   validate:"required,oneof=record deploy"`
}

type DeployRequest struct {
	Sha string `json:"sha" validate:"required"`
}

// DeploymentSummary: la fila del historial, sin el log (que puede ser grande).
type DeploymentSummary struct {
	Deployment
	RequestedByName string `json:"requestedByName"`
}

// DeployJob es lo que el backend le da al agente para que despliegue.
type DeployJob struct {
	DeploymentID string `json:"deploymentId"`
	Stack        string `json:"stack"`
	ServiceName  string `json:"serviceName"`
	ImageRepo    string `json:"imageRepo"`
	Image        string `json:"image"`
}

// AgentJob es la respuesta a la pregunta del agente cuando hay trabajo.
type AgentJob struct {
	ID   string    `json:"id"`
	Kind string    `json:"kind"`
	Data DeployJob `json:"data"`
}

type AgentLogRequest struct {
	Lines []string `json:"lines" validate:"max=500"`
}

type AgentFinishRequest struct {
	Status        string `json:"status"        validate:"required,oneof=succeeded failed"`
	Error         string `json:"error"`
	PreviousImage string `json:"previousImage"`
	FinalImage    string `json:"finalImage"`
}
