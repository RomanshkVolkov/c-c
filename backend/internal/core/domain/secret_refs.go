package domain

import "regexp"

// ─── Secrets por referencia a 1Password (R8) ──────────────────────────────────
//
// 1Password es la fuente de verdad. cac guarda, por servicio, **qué** secreto
// va con qué nombre (`DATABASE_URL` ← `op://dwit/Web RRHH/DATABASE_URL`), y un
// registro de cada rotación. **Ningún valor**: los lee la app en la máquina de
// quien rota, y van de ahí al servidor por ssh.
//
// Ninguno de estos tipos tiene un campo que pueda llevar un valor, y la
// petición que trae uno se rechaza (ver TestNoSecretTypeCarriesAValue).

// DeployableSecretRef: un secret del servicio. En el contenedor aparece como
// el fichero `/run/secrets/<Name>`.
type DeployableSecretRef struct {
	BaseModel
	OrgID        string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	DeployableID string `gorm:"type:varchar(36);not null;uniqueIndex:idx_secret_ref_name" json:"deployableId"`
	Name         string `gorm:"type:varchar(40);not null;uniqueIndex:idx_secret_ref_name" json:"name"`
	OpRef        string `gorm:"type:varchar(300);not null" json:"opRef"`
}

// SecretRotation: una vez que alguien llevó los secrets al servidor. Los
// nombres de los secrets de Docker van versionados con un HMAC del valor cuya
// clave sólo vive en el servidor: no revelan nada.
type SecretRotation struct {
	BaseModel
	OrgID        string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	DeployableID string `gorm:"type:varchar(36);index;not null" json:"deployableId"`
	StartedBy    string `gorm:"type:varchar(36);not null" json:"startedBy"`
	// Los nombres rotados, separados por comas.
	Names string `gorm:"type:text" json:"names"`
	// JSON `{nombre: secret de docker}`: qué versión quedó puesta.
	Versions string `gorm:"type:text" json:"versions"`
	// succeeded | failed
	Status string `gorm:"type:varchar(20);not null" json:"status"`
	Error  string `gorm:"type:text" json:"error"`
}

// SecretNamePattern: el nombre de un secret, que es también el de su fichero.
var SecretNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,39}$`)

// OpRefPattern: `op://bóveda/ítem/campo` (con sección opcional).
var OpRefPattern = regexp.MustCompile(`^op://[^/]+/[^/]+/.+$`)

// DockerSecretPattern: lo que deja la rotación (`cac_<NOMBRE>_<hmac16>`).
var DockerSecretPattern = regexp.MustCompile(`^cac_[A-Z_][A-Z0-9_]{0,39}_[0-9a-f]{16}$`)

type SecretRefInput struct {
	Name  string `json:"name"  validate:"required"`
	OpRef string `json:"opRef" validate:"required,max=300"`
}

// PutSecretRefsRequest: la lista entera del servicio (lo que no venga se
// quita).
type PutSecretRefsRequest struct {
	Refs []SecretRefInput `json:"refs" validate:"max=100,dive"`
}

type RecordRotationRequest struct {
	Names    []string          `json:"names"    validate:"required,min=1,max=100"`
	Versions map[string]string `json:"versions"`
	Status   string            `json:"status"   validate:"required,oneof=succeeded failed"`
	Error    string            `json:"error"    validate:"max=2000"`
}

type SecretRotationResponse struct {
	SecretRotation
	StartedByName string `json:"startedByName"`
}
