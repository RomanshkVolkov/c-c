package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// Lo que hace legible la telemetría de una app sin que cac sepa qué app es.
//
// Todo lo de este fichero es puro —sin base de datos ni reloj— porque es donde
// están las reglas: qué es un error, cómo se llama un dispositivo, cuándo una
// ficha está mal. Lo propio de cada app no vive aquí: lo dice la app en el lote
// (`device.label`, `device.subject`) o el proyecto en su `TelemetryConfig`.

// ─── Gravedad ─────────────────────────────────────────────────────────────────

type Severity string

const (
	SeverityInfo  Severity = "info"
	SeverityWarn  Severity = "warn"
	SeverityError Severity = "error"
)

func (s Severity) rank() int {
	switch s {
	case SeverityError:
		return 2
	case SeverityWarn:
		return 1
	}
	return 0
}

// AtLeast dice si s llega a min. Un min vacío o desconocido deja pasar todo.
func (s Severity) AtLeast(min Severity) bool { return s.rank() >= min.rank() }

// ParseSeverity acepta los nombres que mandan los SDK de verdad: `warning` y
// `fatal` también existen.
func ParseSeverity(v string) Severity {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "error", "fatal", "critical":
		return SeverityError
	case "warn", "warning":
		return SeverityWarn
	}
	return SeverityInfo
}

// crumbFacts es lo poco de un breadcrumb que hace falta para clasificarlo, sin
// casarse con el esquema de ningún SDK.
type crumbFacts struct {
	Type   string `json:"type"`
	Level  string `json:"level"`
	Status *int   `json:"status"`
}

func isNetworkType(t string) bool {
	switch t {
	case "network", "request", "fetch", "xhr":
		return true
	}
	return false
}

func isErrorType(t string) bool {
	switch t {
	case "error", "unhandledrejection", "exception":
		return true
	}
	return false
}

// CrumbSeverity es **la** definición de gravedad. La pantalla y el MCP la leen
// del timeline en vez de calcularla cada uno: antes Go contaba una `request`
// fallida como error y el MCP no, y el mismo dispositivo daba dos números.
//
// Un `level` explícito manda sobre el tipo, salvo para subir: un `lifecycle`
// con `level: warn` es un aviso, y un `error` no deja de serlo porque alguien
// le pusiera `level: info`.
func CrumbSeverity(raw json.RawMessage) Severity {
	var c crumbFacts
	if err := json.Unmarshal(raw, &c); err != nil {
		return SeverityInfo
	}
	sev := SeverityInfo
	if c.Level != "" {
		sev = ParseSeverity(c.Level)
	}
	if isErrorType(c.Type) {
		return SeverityError
	}
	// Una petición sin status (o 0) es un fallo de red; con status, sólo si
	// es >= 400. Un crumb de red sin el campo no se puede juzgar y se deja.
	if isNetworkType(c.Type) && c.Status != nil && (*c.Status == 0 || *c.Status >= 400) {
		return SeverityError
	}
	return sev
}

// ─── Identidad del dispositivo ────────────────────────────────────────────────

const maxIdentityLen = 120

// DeviceIdentity saca cómo se llama un dispositivo y de quién es.
//
// Convención del lote: `device.label` (cómo se le enseña) y `device.subject`
// (un identificador estable de la persona: un número de empleado, nunca un
// correo). Sin `label`, el fabricante y el modelo si vienen; sin nada, vacío y
// la pantalla enseña el id.
//
// Se llama sobre el JSON **ya redactado**: un correo que alguien ponga en
// `subject` llega aquí como `[email]` y así se guarda.
func DeviceIdentity(device json.RawMessage) (label, subject string) {
	var d map[string]any
	if len(device) == 0 || json.Unmarshal(device, &d) != nil {
		return "", ""
	}
	label = scalarString(d["label"])
	if label == "" {
		// Lo que mandan expo-device y react-native-device-info, en la raíz o
		// dentro de `device` (GEOCHECK anida el del teléfono ahí).
		for _, src := range []map[string]any{d, asMap(d["device"])} {
			if src == nil {
				continue
			}
			maker := firstString(src, "manufacturer", "brand")
			model := firstString(src, "modelName", "model", "deviceName")
			if model != "" && maker != "" && !strings.HasPrefix(strings.ToLower(model), strings.ToLower(maker)) {
				label = maker + " " + model
			} else if model != "" {
				label = model
			} else {
				label = maker
			}
			if label != "" {
				break
			}
		}
	}
	subject = scalarString(d["subject"])
	return clip(label), clip(subject)
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := scalarString(m[k]); s != "" {
			return s
		}
	}
	return ""
}

// scalarString acepta texto y números: un `employeeId` llega de las dos formas.
func scalarString(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case float64:
		if x == math.Trunc(x) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	}
	return ""
}

func clip(s string) string {
	r := []rune(s)
	if len(r) > maxIdentityLen {
		return string(r[:maxIdentityLen])
	}
	return s
}

// ─── Configuración por proyecto ───────────────────────────────────────────────

// TelemetryConfig es lo que un proyecto dice de su propia telemetría: cuánto
// se guarda, qué es estar sano y cada cuánto late. Vacía, todo funciona como
// antes: retención por defecto, sin alertas, sin vigilante.
type TelemetryConfig struct {
	// RetentionDays: 0 es «el de por defecto» (TELEMETRY_TTL_DAYS).
	RetentionDays int          `json:"retentionDays,omitempty"`
	HealthRules   []HealthRule `json:"healthRules,omitempty"`
	Heartbeat     *Heartbeat   `json:"heartbeat,omitempty"`
}

// Heartbeat le dice al vigilante qué es «callado».
type Heartbeat struct {
	IntervalSeconds int `json:"intervalSeconds"`
	GraceSeconds    int `json:"graceSeconds"`
	// ActiveWhen dice si el dispositivo **debería** estar latiendo, mirando
	// su última ficha. Sin ella, siempre. Es lo que evita que el teléfono de
	// alguien fuera de turno levante una alarma cada noche.
	ActiveWhen *Condition `json:"activeWhen,omitempty"`
}

// Silence es cuánto puede pasar sin latido antes de que cuente como hueco.
func (h Heartbeat) Silence() time.Duration {
	return time.Duration(h.IntervalSeconds+h.GraceSeconds) * time.Second
}

// Condition es una comparación sobre una ruta de la ficha (`device`).
type Condition struct {
	// Path con puntos, relativa a `device`: `snapshot.battery.level`.
	Path  string `json:"path"`
	Op    string `json:"op"`
	Value any    `json:"value,omitempty"`
}

// HealthRule es una condición que, si se cumple, es una alerta.
type HealthRule struct {
	Condition
	Severity Severity `json:"severity"`
	// Message es lo que lee una persona. Lo escribe el proyecto, en su idioma.
	Message string `json:"message"`
}

// HealthAlert es una regla que se cumple, con el valor que la hizo saltar.
type HealthAlert struct {
	Path     string   `json:"path"`
	Severity Severity `json:"severity"`
	Message  string   `json:"message"`
	Actual   any      `json:"actual,omitempty"`
}

var conditionOps = map[string]bool{
	"==": true, "!=": true, ">": true, ">=": true, "<": true, "<=": true,
	"exists": true, "missing": true,
}

const (
	MaxRetentionDays = 90
	maxHealthRules   = 50
)

var ErrInvalidTelemetryConfig = errors.New("invalid telemetry config")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidTelemetryConfig, fmt.Sprintf(format, args...))
}

// Validate rechaza lo que el vigilante no sabría evaluar. Mejor un 400 al
// guardar que una regla que nunca salta sin que nadie sepa por qué.
func (c TelemetryConfig) Validate() error {
	if c.RetentionDays < 0 || c.RetentionDays > MaxRetentionDays {
		return invalid("retentionDays must be between 1 and %d", MaxRetentionDays)
	}
	if len(c.HealthRules) > maxHealthRules {
		return invalid("at most %d health rules", maxHealthRules)
	}
	for i, r := range c.HealthRules {
		if err := r.Condition.validate(); err != nil {
			return invalid("rule %d: %v", i+1, err)
		}
		if r.Severity != SeverityWarn && r.Severity != SeverityError {
			return invalid("rule %d: severity must be warn or error", i+1)
		}
		if strings.TrimSpace(r.Message) == "" {
			return invalid("rule %d: message is required", i+1)
		}
	}
	if h := c.Heartbeat; h != nil {
		if h.IntervalSeconds < 60 || h.IntervalSeconds > 86400 {
			return invalid("heartbeat interval must be between 60 and 86400 seconds")
		}
		if h.GraceSeconds < 0 || h.GraceSeconds > 86400 {
			return invalid("heartbeat grace must be between 0 and 86400 seconds")
		}
		if h.ActiveWhen != nil {
			if err := h.ActiveWhen.validate(); err != nil {
				return invalid("activeWhen: %v", err)
			}
		}
	}
	return nil
}

func (c Condition) validate() error {
	if strings.TrimSpace(c.Path) == "" {
		return errors.New("path is required")
	}
	if !conditionOps[c.Op] {
		return fmt.Errorf("unknown operator %q", c.Op)
	}
	switch c.Op {
	case ">", ">=", "<", "<=":
		if _, ok := toNumber(c.Value); !ok {
			return fmt.Errorf("operator %s needs a number", c.Op)
		}
	}
	return nil
}

// Retention es la ventana de este proyecto, o la de por defecto.
func (c TelemetryConfig) Retention(fallback time.Duration) time.Duration {
	if c.RetentionDays > 0 {
		return time.Duration(c.RetentionDays) * 24 * time.Hour
	}
	return fallback
}

// ─── Evaluación ───────────────────────────────────────────────────────────────

// Lookup sigue una ruta con puntos dentro de un JSON ya decodificado.
func Lookup(doc any, path string) (any, bool) {
	cur := doc
	for _, part := range strings.Split(strings.TrimSpace(path), ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[part]; !ok {
			return nil, false
		}
	}
	return cur, true
}

func toNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// equal compara como lo haría una persona al escribir la regla: un número es
// igual a otro número aunque uno llegue como int y otro como float, y un texto
// se compara tal cual.
func equal(a, b any) bool {
	if an, ok := toNumber(a); ok {
		bn, ok := toNumber(b)
		return ok && an == bn
	}
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

// Holds dice si la condición se cumple sobre la ficha. Una ruta que no existe
// sólo cumple `missing`: una comparación sobre algo que no llegó no es verdad
// ni mentira, y avisar por ella sería ruido.
func (c Condition) Holds(device any) (bool, any) {
	v, found := Lookup(device, c.Path)
	switch c.Op {
	case "exists":
		return found && v != nil, v
	case "missing":
		return !found || v == nil, v
	}
	if !found {
		return false, nil
	}
	switch c.Op {
	case "==":
		return equal(v, c.Value), v
	case "!=":
		return !equal(v, c.Value), v
	}
	got, ok1 := toNumber(v)
	want, ok2 := toNumber(c.Value)
	if !ok1 || !ok2 {
		return false, v
	}
	switch c.Op {
	case ">":
		return got > want, v
	case ">=":
		return got >= want, v
	case "<":
		return got < want, v
	case "<=":
		return got <= want, v
	}
	return false, v
}

// DecodeDevice decodifica la ficha una vez para evaluar varias reglas.
func DecodeDevice(device json.RawMessage) any {
	var doc any
	if len(device) == 0 || json.Unmarshal(device, &doc) != nil {
		return nil
	}
	return doc
}

// EvaluateHealth devuelve las reglas que se cumplen, las de error primero.
func EvaluateHealth(device json.RawMessage, rules []HealthRule) []HealthAlert {
	doc := DecodeDevice(device)
	out := []HealthAlert{}
	if doc == nil {
		return out
	}
	for _, r := range rules {
		if ok, actual := r.Holds(doc); ok {
			out = append(out, HealthAlert{Path: r.Path, Severity: r.Severity, Message: r.Message, Actual: actual})
		}
	}
	// Estable: dentro de la misma gravedad, el orden en que se escribieron.
	errs, rest := []HealthAlert{}, []HealthAlert{}
	for _, a := range out {
		if a.Severity == SeverityError {
			errs = append(errs, a)
		} else {
			rest = append(rest, a)
		}
	}
	return append(errs, rest...)
}

// ShouldBeBeating dice si el vigilante debe esperar latidos de esta ficha.
func (h Heartbeat) ShouldBeBeating(device json.RawMessage) bool {
	if h.ActiveWhen == nil {
		return true
	}
	ok, _ := h.ActiveWhen.Holds(DecodeDevice(device))
	return ok
}

// IsSilent dice si un dispositivo que debería latir lleva callado más de la
// cuenta. Uno que no ha latido nunca no está «callado»: nunca empezó, y no hay
// desde cuándo contar.
func (h Heartbeat) IsSilent(lastBeat *time.Time, now time.Time) bool {
	if lastBeat == nil {
		return false
	}
	return now.Sub(*lastBeat) > h.Silence()
}

// HeartbeatGap es un tramo sin latidos más largo de lo que se esperaba.
type HeartbeatGap struct {
	From    time.Time `json:"from"`
	To      time.Time `json:"to"`
	Seconds int64     `json:"seconds"`
	// Open: el hueco llega hasta ahora; el dispositivo sigue callado.
	Open bool `json:"open,omitempty"`
}

// HeartbeatGaps encuentra los huecos de una serie de latidos ordenada. Con
// `silence` cero no hay latido configurado y no hay huecos que medir. El
// último tramo, hasta `now`, cuenta si ya es más largo que `silence`: es el
// hueco que importa, el de ahora.
func HeartbeatGaps(beats []time.Time, silence time.Duration, now time.Time) []HeartbeatGap {
	out := []HeartbeatGap{}
	if silence <= 0 || len(beats) == 0 {
		return out
	}
	for i := 1; i < len(beats); i++ {
		if d := beats[i].Sub(beats[i-1]); d > silence {
			out = append(out, HeartbeatGap{From: beats[i-1], To: beats[i], Seconds: int64(d / time.Second)})
		}
	}
	last := beats[len(beats)-1]
	if d := now.Sub(last); d > silence {
		out = append(out, HeartbeatGap{From: last, To: now, Seconds: int64(d / time.Second), Open: true})
	}
	return out
}
