package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// La gravedad es una sola, y la leen la pantalla y el MCP. Antes Go contaba una
// `request` fallida como error y el MCP no; y un cambio de dispositivo con
// `level: warn` que la API de GEOCHECK mandaba como `error` inflaba el contador.
func TestCrumbSeverity(t *testing.T) {
	for _, c := range []struct {
		crumb string
		want  Severity
	}{
		{`{"type":"lifecycle","level":"warn"}`, SeverityWarn},
		{`{"type":"lifecycle","level":"warning"}`, SeverityWarn},
		{`{"type":"lifecycle"}`, SeverityInfo},
		{`{"type":"lifecycle","level":"fatal"}`, SeverityError},
		{`{"type":"error"}`, SeverityError},
		// Un error no deja de serlo porque alguien le pusiera info.
		{`{"type":"exception","level":"info"}`, SeverityError},
		{`{"type":"unhandledrejection"}`, SeverityError},
		{`{"type":"network","status":200}`, SeverityInfo},
		{`{"type":"request","status":500}`, SeverityError},
		{`{"type":"fetch","status":404}`, SeverityError},
		{`{"type":"xhr","status":0}`, SeverityError},
		{`{"type":"network","status":399}`, SeverityInfo},
		{`{"type":"network","status":400}`, SeverityError},
		// Sin status no se puede juzgar.
		{`{"type":"network"}`, SeverityInfo},
		{`{"type":"network","status":200,"level":"warn"}`, SeverityWarn},
		{`no es json`, SeverityInfo},
	} {
		if got := CrumbSeverity(json.RawMessage(c.crumb)); got != c.want {
			t.Errorf("%s: %s, quería %s", c.crumb, got, c.want)
		}
	}
}

func TestSummarizeCountsWarningsApartFromErrors(t *testing.T) {
	b := IngestEventBatch{Breadcrumbs: []json.RawMessage{
		json.RawMessage(`{"type":"network","status":200}`),
		json.RawMessage(`{"type":"request","status":503}`),
		json.RawMessage(`{"type":"lifecycle","level":"warn","name":"DEVICE_NETWORK_CHANGED"}`),
		json.RawMessage(`{"type":"error"}`),
		json.RawMessage(`{"type":"heartbeat","counts":{"ok":3}}`),
	}}
	got := b.Summarize()
	want := BatchSummary{Requests: 2, Errors: 2, Warnings: 1, Heartbeat: true}
	if got != want {
		t.Fatalf("%+v, quería %+v", got, want)
	}
	if (IngestEventBatch{Breadcrumbs: []json.RawMessage{json.RawMessage(`{"type":"lifecycle"}`)}}).Summarize().Heartbeat {
		t.Fatal("un lote sin latido dice que latió")
	}
}

func TestDeviceIdentity(t *testing.T) {
	for _, c := range []struct {
		name, device, label, subject string
	}{
		{"label y subject explícitos", `{"label":"Caja 3","subject":"E-104"}`, "Caja 3", "E-104"},
		{"subject numérico", `{"label":"x","subject":1042}`, "x", "1042"},
		{"sin label: fabricante y modelo", `{"manufacturer":"Google","modelName":"Pixel 8"}`, "Google Pixel 8", ""},
		{"el modelo ya trae la marca", `{"brand":"samsung","model":"samsung SM-A155"}`, "samsung SM-A155", ""},
		{"anidado en device, como GEOCHECK", `{"device":{"manufacturer":"motorola","modelName":"moto g"}}`, "motorola moto g", ""},
		{"label manda sobre el modelo", `{"label":"Mío","model":"X"}`, "Mío", ""},
		{"nada", `{"platform":"android"}`, "", ""},
		{"no es json", `nope`, "", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			l, s := DeviceIdentity(json.RawMessage(c.device))
			if l != c.label || s != c.subject {
				t.Errorf("(%q, %q), quería (%q, %q)", l, s, c.label, c.subject)
			}
		})
	}
	long := `{"label":"` + strings.Repeat("a", 300) + `"}`
	if l, _ := DeviceIdentity(json.RawMessage(long)); len([]rune(l)) != maxIdentityLen {
		t.Errorf("un label largo no se recortó: %d", len(l))
	}
}

const snapshot = `{"snapshot":{"battery":{"level":0.15,"optimizationEnabled":true},
	"tracking":{"active":true,"lastCallbackAgeSeconds":905},"network":{"type":"WIFI"},"gone":null}}`

func TestEveryOperator(t *testing.T) {
	doc := DecodeDevice(json.RawMessage(snapshot))
	for _, c := range []struct {
		cond Condition
		want bool
	}{
		{Condition{Path: "snapshot.battery.optimizationEnabled", Op: "==", Value: true}, true},
		{Condition{Path: "snapshot.battery.optimizationEnabled", Op: "==", Value: false}, false},
		{Condition{Path: "snapshot.network.type", Op: "==", Value: "WIFI"}, true},
		{Condition{Path: "snapshot.network.type", Op: "!=", Value: "WIFI"}, false},
		{Condition{Path: "snapshot.network.type", Op: "!=", Value: "CELLULAR"}, true},
		{Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: ">", Value: 600.0}, true},
		{Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: ">", Value: 905.0}, false},
		{Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: ">=", Value: 905.0}, true},
		{Condition{Path: "snapshot.battery.level", Op: "<", Value: 0.2}, true},
		{Condition{Path: "snapshot.battery.level", Op: "<", Value: 0.15}, false},
		{Condition{Path: "snapshot.battery.level", Op: "<=", Value: 0.15}, true},
		// Un entero escrito en la regla compara igual que el float del JSON.
		{Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: "==", Value: 905}, true},
		{Condition{Path: "snapshot.tracking.active", Op: "exists"}, true},
		{Condition{Path: "snapshot.gone", Op: "exists"}, false},
		{Condition{Path: "snapshot.gone", Op: "missing"}, true},
		{Condition{Path: "snapshot.nope", Op: "missing"}, true},
		{Condition{Path: "snapshot.tracking.active", Op: "missing"}, false},
		// Lo que no llegó no cumple ninguna comparación.
		{Condition{Path: "snapshot.nope", Op: "!=", Value: "x"}, false},
		{Condition{Path: "snapshot.nope", Op: "<", Value: 1.0}, false},
		// Un texto no es mayor que un número.
		{Condition{Path: "snapshot.network.type", Op: ">", Value: 1.0}, false},
	} {
		if got, _ := c.cond.Holds(doc); got != c.want {
			t.Errorf("%s %s %v: %v, quería %v", c.cond.Path, c.cond.Op, c.cond.Value, got, c.want)
		}
	}
}

func TestEvaluateHealthPutsErrorsFirst(t *testing.T) {
	rules := []HealthRule{
		{Condition: Condition{Path: "snapshot.battery.optimizationEnabled", Op: "==", Value: true}, Severity: SeverityWarn, Message: "batería"},
		{Condition: Condition{Path: "snapshot.network.type", Op: "==", Value: "NONE"}, Severity: SeverityError, Message: "sin red"},
		{Condition: Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: ">", Value: 600.0}, Severity: SeverityError, Message: "rastreo parado"},
	}
	got := EvaluateHealth(json.RawMessage(snapshot), rules)
	if len(got) != 2 || got[0].Message != "rastreo parado" || got[1].Message != "batería" {
		t.Fatalf("%+v", got)
	}
	if got[0].Actual != 905.0 {
		t.Errorf("no dice qué valor hizo saltar la regla: %v", got[0].Actual)
	}
	if n := len(EvaluateHealth(nil, rules)); n != 0 {
		t.Errorf("sin ficha no hay alertas, salieron %d", n)
	}
}

func TestValidateRejectsWhatTheWatcherCannotEvaluate(t *testing.T) {
	ok := HealthRule{Condition: Condition{Path: "a", Op: "==", Value: 1.0}, Severity: SeverityError, Message: "m"}
	for _, c := range []struct {
		name string
		cfg  TelemetryConfig
	}{
		{"retención negativa", TelemetryConfig{RetentionDays: -1}},
		{"retención de más", TelemetryConfig{RetentionDays: MaxRetentionDays + 1}},
		{"operador desconocido", TelemetryConfig{HealthRules: []HealthRule{{Condition: Condition{Path: "a", Op: "~"}, Severity: SeverityError, Message: "m"}}}},
		{"sin ruta", TelemetryConfig{HealthRules: []HealthRule{{Condition: Condition{Op: "exists"}, Severity: SeverityError, Message: "m"}}}},
		{"mayor que un texto", TelemetryConfig{HealthRules: []HealthRule{{Condition: Condition{Path: "a", Op: ">", Value: "x"}, Severity: SeverityError, Message: "m"}}}},
		{"gravedad info", TelemetryConfig{HealthRules: []HealthRule{{Condition: ok.Condition, Severity: SeverityInfo, Message: "m"}}}},
		{"sin mensaje", TelemetryConfig{HealthRules: []HealthRule{{Condition: ok.Condition, Severity: SeverityWarn, Message: " "}}}},
		{"latido de segundos", TelemetryConfig{Heartbeat: &Heartbeat{IntervalSeconds: 5}}},
		{"activeWhen roto", TelemetryConfig{Heartbeat: &Heartbeat{IntervalSeconds: 300, ActiveWhen: &Condition{Path: "a", Op: "?"}}}},
	} {
		if err := c.cfg.Validate(); !errors.Is(err, ErrInvalidTelemetryConfig) {
			t.Errorf("%s: pasó (%v)", c.name, err)
		}
	}
	good := TelemetryConfig{RetentionDays: 30, HealthRules: []HealthRule{ok},
		Heartbeat: &Heartbeat{IntervalSeconds: 300, GraceSeconds: 120, ActiveWhen: &Condition{Path: "a", Op: "==", Value: true}}}
	if err := good.Validate(); err != nil {
		t.Errorf("una configuración buena no pasa: %v", err)
	}
	if err := (TelemetryConfig{}).Validate(); err != nil {
		t.Errorf("la vacía no pasa: %v", err)
	}
}

func TestRetention(t *testing.T) {
	def := 14 * 24 * time.Hour
	if got := (TelemetryConfig{}).Retention(def); got != def {
		t.Errorf("sin configurar: %v", got)
	}
	if got := (TelemetryConfig{RetentionDays: 45}).Retention(def); got != 45*24*time.Hour {
		t.Errorf("con 45 días: %v", got)
	}
}

func TestTheConfigTravelsAsTheScreenWritesIt(t *testing.T) {
	// Las reglas llegan planas: {path, op, value, severity, message}.
	raw := `{"healthRules":[{"path":"a.b","op":">","value":3,"severity":"error","message":"m"}]}`
	var c TelemetryConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatal(err)
	}
	if r := c.HealthRules[0]; r.Path != "a.b" || r.Op != ">" || r.Value != 3.0 || r.Severity != SeverityError {
		t.Fatalf("%+v", r)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeat(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	hb := Heartbeat{IntervalSeconds: 300, GraceSeconds: 60,
		ActiveWhen: &Condition{Path: "snapshot.tracking.active", Op: "==", Value: true}}
	if !hb.ShouldBeBeating(json.RawMessage(snapshot)) {
		t.Error("con el rastreo activo debería latir")
	}
	if hb.ShouldBeBeating(json.RawMessage(`{"snapshot":{"tracking":{"active":false}}}`)) {
		t.Error("fuera de turno no debería latir")
	}
	if !(Heartbeat{IntervalSeconds: 300}).ShouldBeBeating(nil) {
		t.Error("sin activeWhen, siempre")
	}
	at := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	if hb.IsSilent(at(6*time.Minute), now) {
		t.Error("a los 6 minutos con 5+1 todavía no")
	}
	if !hb.IsSilent(at(6*time.Minute+time.Second), now) {
		t.Error("pasado el intervalo más la gracia, sí")
	}
	if hb.IsSilent(nil, now) {
		t.Error("uno que no latió nunca no está callado")
	}
}

func TestHeartbeatGaps(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return now.Add(time.Duration(-m) * time.Minute) }
	beats := []time.Time{at(60), at(55), at(50), at(20), at(15)}
	gaps := HeartbeatGaps(beats, 6*time.Minute, now)
	if len(gaps) != 2 {
		t.Fatalf("%+v", gaps)
	}
	if !gaps[0].From.Equal(at(50)) || !gaps[0].To.Equal(at(20)) || gaps[0].Seconds != 1800 || gaps[0].Open {
		t.Errorf("el hueco del medio: %+v", gaps[0])
	}
	if !gaps[1].Open || !gaps[1].From.Equal(at(15)) || !gaps[1].To.Equal(now) {
		t.Errorf("el hueco de ahora: %+v", gaps[1])
	}
	if n := len(HeartbeatGaps(beats, 0, now)); n != 0 {
		t.Errorf("sin latido configurado no hay huecos: %d", n)
	}
	if n := len(HeartbeatGaps([]time.Time{at(1)}, 6*time.Minute, now)); n != 0 {
		t.Errorf("un latido reciente no es un hueco: %d", n)
	}
}

func TestTimelineFilter(t *testing.T) {
	batch := func() *TelemetryEventView {
		return &TelemetryEventView{Breadcrumbs: []json.RawMessage{
			json.RawMessage(`{"type":"network","status":200}`),
			json.RawMessage(`{"type":"lifecycle","level":"warn"}`),
			json.RawMessage(`{"type":"error"}`),
			json.RawMessage(`{"type":"heartbeat"}`),
		}}
	}
	v := batch()
	if !(TimelineQuery{}).Filter(v) || len(v.Breadcrumbs) != 4 {
		t.Fatalf("sin filtro se pierde algo: %d", len(v.Breadcrumbs))
	}
	want := []Severity{SeverityInfo, SeverityWarn, SeverityError, SeverityInfo}
	for i, s := range v.Severities {
		if s != want[i] {
			t.Errorf("gravedad %d: %s, quería %s", i, s, want[i])
		}
	}
	v = batch()
	if !(TimelineQuery{MinSeverity: SeverityWarn}).Filter(v) || len(v.Breadcrumbs) != 2 {
		t.Errorf("desde warn: %d", len(v.Breadcrumbs))
	}
	v = batch()
	if !(TimelineQuery{Types: []string{"heartbeat", " network"}}).Filter(v) || len(v.Breadcrumbs) != 2 {
		t.Errorf("por tipo: %d", len(v.Breadcrumbs))
	}
	v = batch()
	if (TimelineQuery{Types: []string{"navigation"}}).Filter(v) {
		t.Error("un lote que el filtro deja vacío no debería salir")
	}
}
