package domain

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Grabar una llamada: una fila por grabación, una por pista.
//
// El diseño en una frase: **mientras la llamada pasa se guarda cada pista tal
// como llega, y el vídeo se monta al colgar**. Track Egress escribe el flujo ya
// codificado sin decodificarlo (~0,1 núcleo por pista); componer en vivo habría
// costado unos tres núcleos durante toda la reunión para montar cámaras que
// nadie iba a mirar. De ahí sale todo lo demás de este fichero: si el vídeo se
// monta después, hace falta saber **dónde quedó cada pista y cuándo empezó**,
// que es exactamente lo que `RecordingTrack` guarda.
//
// # Una máquina de estados, y sólo una
//
// Dicho aquí a propósito: en este repo ya hay un sitio donde conviven dos
// —`ReportStatus`, ver «Dos máquinas, y por qué»— y costó un botón que no hacía
// nada. Una grabación no tiene flujos: la misma tabla, las mismas reglas,
// siempre. Si algún día hicieran falta dos, que sea porque alguien lo decidió y
// lo escribió, no porque se coló.

// RecordingStatus: dónde está una grabación.
type RecordingStatus string

const (
	// RecordingActive: los egress están escribiendo. La sala enseña REC.
	RecordingActive RecordingStatus = "recording"
	// RecordingFinalizing: ya se dijo «para». Los egress cierran sus ficheros
	// y el mux todavía no ha montado nada.
	RecordingFinalizing RecordingStatus = "finalizing"
	// RecordingReady: hay un fichero montado y se puede ver.
	RecordingReady RecordingStatus = "ready"
	// RecordingPartial: hay fichero, pero alguna pista se perdió. Se distingue
	// de `ready` porque quien la mire tiene derecho a saber que falta alguien;
	// enseñarla como completa sería mentir por omisión.
	RecordingPartial RecordingStatus = "partial"
	// RecordingFailed: no hay nada que ver.
	RecordingFailed RecordingStatus = "failed"
)

// recordingTransitions, escrito entero.
//
// Entero y no calculado por la misma razón que en `report.go`: para que se lea
// de un vistazo qué permite, y para que añadir un estado obligue a decidir aquí
// en vez de heredar «todo vale» por descuido.
//
// `recording → failed` existe para la llamada en la que ninguna pista llegó a
// grabar: no hay nada que finalizar. Los tres finales no salen a ningún sitio —
// volver a montar una grabación es un `retry` que la devuelve a `finalizing`, y
// eso es una transición hacia atrás que esta tabla **no** concede: la escribe
// el servicio con su propio `UPDATE` condicional cuando exista, y entonces se
// añadirá aquí con su nombre.
var recordingTransitions = map[RecordingStatus][]RecordingStatus{
	RecordingActive:     {RecordingFinalizing, RecordingFailed},
	RecordingFinalizing: {RecordingReady, RecordingPartial, RecordingFailed},
	RecordingReady:      {},
	RecordingPartial:    {},
	RecordingFailed:     {},
}

// CanTransitionRecording dice si un cambio de estado es legal.
//
// Quedarse donde está es legal: un tick que reconcilia sin novedad no es un
// error, y obligar al llamante a comprobarlo antes repartiría la regla en dos
// sitios.
func CanTransitionRecording(from, to RecordingStatus) bool {
	if from == to {
		return true
	}
	for _, allowed := range recordingTransitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// Terminal: de aquí no se sale. Lo usa el reloj para dejar de mirar.
func (s RecordingStatus) Terminal() bool {
	return s == RecordingReady || s == RecordingPartial || s == RecordingFailed
}

// ─── Qué se graba, y qué no ──────────────────────────────────────────────────

// Las fuentes que se graban. `CAMERA` **no está**, y no es un olvido: es la
// decisión de producto. Se graba lo que se dijo y lo que se enseñó, no las
// caras. Añadirla algún día es meterla en esta lista y darle una rejilla al
// mux; nada del dominio cambia.
const (
	SourceMicrophone       = "MICROPHONE"
	SourceScreenShare      = "SCREEN_SHARE"
	SourceScreenShareAudio = "SCREEN_SHARE_AUDIO"
)

// Recordable filtra las pistas que se graban.
//
// Se compara contra el nombre del enum de LiveKit, que es lo que devuelve
// `ListParticipants`. Las variantes `SOURCE_*` existen porque el JSON de Twirp
// ha emitido las dos formas según versión, y una pista que no se reconoce se
// descarta en silencio — que para una cámara es lo correcto y para un micro
// sería un fallo mudo. Por eso el guardián prueba las dos formas.
func Recordable(source string) bool {
	switch strings.TrimPrefix(strings.ToUpper(source), "SOURCE_") {
	case SourceMicrophone, SourceScreenShare, SourceScreenShareAudio:
		return true
	default:
		return false
	}
}

// ─── Las filas ───────────────────────────────────────────────────────────────

// Recording es una grabación de la sala de un espacio.
type Recording struct {
	BaseModel
	OrgID   string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	SpaceID string `gorm:"type:varchar(36);index;not null" json:"spaceId"`
	// Room es el nombre de la sala en el SFU. Se guarda y no se deriva cada vez
	// porque una grabación vieja tiene que poder decir a qué sala perteneció
	// aunque el prefijo cambie.
	Room      string `gorm:"type:varchar(120);not null" json:"room"`
	StartedBy string `gorm:"type:varchar(36);not null"  json:"startedBy"`

	Status RecordingStatus `gorm:"type:varchar(20);index;not null" json:"status"`

	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`

	// FirstMediaAt es el cero de la línea de tiempo: el `started_at` más
	// temprano de todas las pistas. **Sale de Egress, no de nuestro reloj**, y
	// ésa es la parte que importa — medido en la fase 0, los dos egress de una
	// misma llamada pueden arrancar con segundos de diferencia y sus `started_at`
	// siguen alineando las pistas dentro de 73 ms. El reloj del backend no.
	FirstMediaAt *time.Time `json:"firstMediaAt,omitempty"`

	// TickedAt y EmptyTicks son del reloj: el testigo del reparto entre réplicas
	// y la cuenta de ticks seguidos sin nadie humano dentro.
	TickedAt   time.Time `gorm:"index" json:"-"`
	EmptyTicks int       `json:"-"`

	// EgressDoneAt se pone cuando ninguna pista sigue en `starting|active`. Es
	// lo que hace que una grabación aparezca en la cola del mux: antes de eso,
	// los ficheros de S3 pueden estar a medio subir.
	EgressDoneAt  *time.Time `gorm:"index" json:"-"`
	MuxLeaseUntil *time.Time `json:"-"`

	// El resultado. `FinalKey` no sale al cliente: se ve por el proxy, nunca
	// por una URL de bucket.
	FinalKey         string `gorm:"type:varchar(400)" json:"-"`
	FinalContentType string `gorm:"type:varchar(60)"  json:"finalContentType,omitempty"`
	FinalBytes       int64  `json:"finalBytes,omitempty"`
	DurationMs       int64  `json:"durationMs,omitempty"`
	HasScreen        bool   `json:"hasScreen"`

	Error string `gorm:"type:varchar(400)" json:"error,omitempty"`
}

func (Recording) TableName() string { return "recordings" }

// Los estados de una pista.
const (
	TrackStarting = "starting"
	TrackActive   = "active"
	TrackComplete = "complete"
	TrackFailed   = "failed"
)

// RecordingTrack es una pista de una grabación: un egress, un fichero.
//
// Quien entra y sale de la llamada varias veces deja varias filas con la misma
// identidad, y está bien: el mux las alinea una a una por su propio `StartedAt`,
// no por persona.
type RecordingTrack struct {
	BaseModel
	RecordingID string `gorm:"type:varchar(36);index;not null" json:"recordingId"`

	// TrackSid es único **en toda la tabla**, no por grabación. Es lo que hace
	// que dos réplicas del reloj no arranquen dos egress para la misma pista:
	// gana quien consigue insertar. Un sid de LiveKit ya es único de por sí, así
	// que la restricción no quita nada legítimo.
	TrackSid            string `gorm:"type:varchar(64);uniqueIndex;not null" json:"trackSid"`
	ParticipantIdentity string `gorm:"type:varchar(64);not null"             json:"participantIdentity"`
	Source              string `gorm:"type:varchar(30);not null"             json:"source"`
	MimeType            string `gorm:"type:varchar(40)"                      json:"mimeType,omitempty"`

	EgressID string `gorm:"type:varchar(64);index" json:"-"`
	Status   string `gorm:"type:varchar(20);not null" json:"status"`

	// ObjectKey se guarda desde `file_results[].filename` y **nunca** desde la
	// clave que se pidió: `ListParticipants` puede no traer el `mimeType`, y
	// entonces Egress le pone la extensión que toca según el códec real. Medido
	// en la fase 0: se pidió `…-TR_xxx` y se escribió `…-TR_xxx.ogg`.
	ObjectKey string `gorm:"type:varchar(400)" json:"-"`

	// StartedAt y EndedAt salen de `FileInfo`, en nanosegundos Unix. No son
	// nuestro reloj: son el ancla con la que el mux pega las pistas.
	StartedAt *time.Time `json:"startedAt,omitempty"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
	Bytes     int64      `json:"bytes,omitempty"`

	// Tres contadores, y **cada señal tiene el suyo**: compartirlos es cómo se
	// anulan entre ellos. Con uno solo, el reconciliador lo ponía a cero en
	// cada tick y el sondeo lo subía a uno, así que nunca llegaba al umbral y
	// la pista no moría nunca — que era justo el fallo que se venía a arreglar.
	//
	//   - Attempts: cuántas veces se intentó arrancar el egress.
	//   - MissingTicks: cuántos ticks seguidos `ListEgress` no supo nada de él
	//     (el bus vaciado).
	//   - ProbeFailures: cuántas veces seguidas nadie contestó al pedirle que
	//     parara (el pod muerto). Ver `probeStopped`.
	Attempts      int    `json:"-"`
	MissingTicks  int    `json:"-"`
	ProbeFailures int    `json:"-"`
	Error         string `gorm:"type:varchar(400)" json:"error,omitempty"`
}

func (RecordingTrack) TableName() string { return "recording_tracks" }

// TrackTerminal: la pista ya no va a cambiar sola.
func TrackTerminal(status string) bool {
	return status == TrackComplete || status == TrackFailed
}

// ─── Dónde van los ficheros ──────────────────────────────────────────────────

// RecordingPrefixDefault es el rincón del bucket donde escribe Egress. La
// credencial que se le dio **sólo puede escribir bajo este prefijo**; cambiarlo
// aquí sin cambiar la política de IAM deja la grabación sin sitio donde caer.
const RecordingPrefixDefault = "recordings"

// RecordingTrackKey: dónde va el fichero de una pista.
//
// La organización y el espacio van en la clave aunque la fila ya los tenga: es
// lo que hace que un listado del bucket se pueda leer sin la base de datos, y
// lo que permitiría algún día una regla de ciclo de vida por organización.
//
// Sin extensión a propósito — la pone Egress según el códec real, y la clave
// buena es la que devuelve después.
func RecordingTrackKey(prefix, orgID, spaceID, recordingID, source, identity, sid string) string {
	return strings.Join([]string{
		keyPrefix(prefix), keySegment(orgID), keySegment(spaceID), keySegment(recordingID),
		keySegment(strings.ToLower(source)) + "-" + keySegment(identity) + "-" + keySegment(sid),
	}, "/")
}

// RecordingFinalKey: dónde va el montaje.
//
// Determinista a propósito: si el mux falla a mitad y lo reintenta, sobrescribe
// en vez de dejar dos ficheros y ninguna forma de saber cuál vale.
func RecordingFinalKey(prefix, orgID, spaceID, recordingID, ext string) string {
	return strings.Join([]string{
		keyPrefix(prefix), keySegment(orgID), keySegment(spaceID), keySegment(recordingID),
		"final." + keySegment(strings.TrimPrefix(ext, ".")),
	}, "/")
}

// keyPrefix limpia el prefijo **conservando sus barras**.
//
// El prefijo no es un tramo más: es configuración, y `recordings/gate` es una
// cosa que alguien escribe con toda la intención. Pasarlo por `keySegment` lo
// convertía en `recordings-gate` — que no es sólo «no funciona»: es un objeto
// escrito **fuera del rincón** que la credencial de Egress tiene permitido, y
// por tanto un `AccessDenied` que aparece minutos después de colgar y lejos de
// aquí. Así salió: la primera vez que esto habló con un S3 de verdad.
//
// Los tramos vacíos y los `.`/`..` se caen. No es una defensa contra nada —S3
// no resuelve rutas, así que `a/../b` es literalmente esa clave— sino contra
// una clave imposible de encontrar en un listado.
func keyPrefix(s string) string {
	tramos := strings.Split(s, "/")
	out := make([]string, 0, len(tramos))
	for _, tramo := range tramos {
		if tramo == "" || tramo == "." || tramo == ".." {
			continue
		}
		out = append(out, keySegment(tramo))
	}
	if len(out) == 0 {
		return RecordingPrefixDefault
	}
	return strings.Join(out, "/")
}

// keySegment deja pasar lo que puede ir en una clave de S3 sin cambiar de sitio.
//
// La identidad de un participante viene del SFU, que la sacó del token que
// firmamos nosotros, así que hoy es un id de cac y no puede traer sorpresas.
// Esto es defensa en profundidad: una barra en una identidad movería el objeto
// a otro prefijo — fuera del rincón que la credencial tiene permitido, o peor,
// dentro del de otra organización.
func keySegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	if b.Len() == 0 {
		return "x"
	}
	return b.String()
}

// ─── Lo que viaja ────────────────────────────────────────────────────────────

// RecordingResponse es la grabación más lo que la pantalla necesita y no está
// en la fila.
type RecordingResponse struct {
	Recording
	StartedByName string           `json:"startedByName,omitempty"`
	Tracks        []RecordingTrack `json:"tracks,omitempty"`
	// FailedTracks: cuántas se perdieron. Es lo que separa `ready` de
	// `partial` — hay vídeo, pero no está toda la gente.
	FailedTracks int `json:"failedTracks,omitempty"`
}

// RecordingPolicy es lo que la app pregunta antes de pintar el botón.
//
// `Enabled` false esconde el botón entero: una instalación sin grabación
// configurada no debe enseñar un botón que siempre falla.
type RecordingPolicy struct {
	Enabled bool               `json:"enabled"`
	Active  *RecordingResponse `json:"active"`
}

// RecordingSignal es lo que viaja por SSE y por el metadata de la sala cuando
// alguien empieza o para de grabar.
//
// Por metadata de sala **también**, y no sólo por SSE: quien entra tarde a la
// llamada recibe el metadata al conectarse, así que ve el chip REC sin que
// nadie tenga que repetir el aviso.
type RecordingSignal struct {
	ID      string    `json:"id"`
	By      string    `json:"by"`
	ByName  string    `json:"byName,omitempty"`
	Since   time.Time `json:"since"`
	SpaceID string    `json:"spaceId,omitempty"`
}

// ─── Lo que ve el mux ────────────────────────────────────────────────────────

// MuxJob es una grabación lista para montar, con lo justo para montarla.
//
// Un tipo aparte y no el `RecordingResponse` de la app, a propósito: lo que el
// mux necesita —las claves de los objetos, las marcas en nanosegundos— es
// exactamente lo que la app **no** debe ver. Compartir el tipo obligaría a
// recordar para siempre qué campo puede salir por dónde.
type MuxJob struct {
	ID      string `json:"id"`
	OrgID   string `json:"orgId"`
	SpaceID string `json:"spaceId"`
	// Prefix para que el mux sepa dónde subir el montaje sin adivinarlo.
	Prefix string `json:"prefix"`
	// FirstMediaAtNs es el cero de la línea de tiempo. De `FileInfo`, nunca de
	// nuestro reloj: es lo que alinea las pistas dentro de 73 ms.
	FirstMediaAtNs int64      `json:"firstMediaAtNs"`
	Tracks         []MuxTrack `json:"tracks"`
	// FailedTracks es lo que convierte el resultado en `partial`: hay vídeo,
	// pero falta alguien.
	FailedTracks int `json:"failedTracks"`
}

type MuxTrack struct {
	Source      string `json:"source"`
	ObjectKey   string `json:"objectKey"`
	StartedAtNs int64  `json:"startedAtNs"`
	EndedAtNs   int64  `json:"endedAtNs"`
	Bytes       int64  `json:"bytes"`
}

// ─── Lo que se dice en el canal ──────────────────────────────────────────────

// RecordingAnnouncement es la línea que se pone en el canal cuando una
// grabación queda lista: el markdown del canal y la frase plana de la bandeja.
//
// Dos cosas que decidir aquí, y las dos tienen respuesta:
//
//   - **En inglés.** Un mensaje de chat es una fila que leen varias personas a
//     la vez, así que no hay «el idioma de quien lo lee» que elegir como sí lo
//     hay en la bandeja (ver `core/i18n`): se escribe una vez, en el idioma
//     base del producto, como el mensaje de una persona.
//   - **Sin nombrar a nadie, y sin primera persona.** La fila lleva de autor a
//     quien grabó, así que una app que no conoce `kind` la pinta firmada por
//     esa persona — y la frase tiene que leerse bien de las dos maneras:
//     firmada («Jose: The recording…») y sin firma. Un «I stopped the
//     recording» sería mentira en la app nueva, y un «Jose's recording is
//     ready» diría el nombre dos veces en la vieja.
//
// El enlace va con el esquema `cac:` que este repo ya decidió para apuntar a
// algo de dentro desde dentro de un cuerpo (ver `domain/refs.go`): lo encuentra
// el buscador, lo pinta el `onInternalLink` que el canal ya tiene para tarjetas
// y documentos, y no colisiona con ninguna ruta.
//
// Devuelve dos cadenas vacías para un estado del que no hay nada que contar —
// una grabación fallida no es una novedad que merezca interrumpir a nadie, y ya
// tiene su sitio en el panel.
func RecordingAnnouncement(id string, status RecordingStatus, durationMs int64) (body, notice string) {
	var what string
	switch status {
	case RecordingReady:
		what = "The recording of this call is ready"
	case RecordingPartial:
		// Se dice aquí y no sólo en el panel: quien abra el enlace tiene
		// derecho a saber que falta alguien antes de fiarse de lo que oye.
		what = "The recording of this call is ready, with a missing track"
	default:
		return "", ""
	}
	if d := RecordingLength(durationMs); d != "" {
		what += " · " + d
	}
	return what + " — [watch it](" + RecordingRef(id) + ").", what + "."
}

// RecordingLength: `12:34`, o vacío si todavía no se sabe cuánto duró.
func RecordingLength(ms int64) string {
	if ms <= 0 {
		return ""
	}
	total := ms / 1000
	return strconv.FormatInt(total/60, 10) + ":" + fmt.Sprintf("%02d", total%60)
}
