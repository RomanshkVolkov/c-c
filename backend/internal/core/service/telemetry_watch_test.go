package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
)

// El vigilante avisa una vez al abrirse un incidente y una vez al cerrarse.
// Sin base de datos: el almacén y la campana son de mentira, y la ficha va en
// claro (open es la identidad).

type fakeWatchStore struct {
	devices []domain.TelemetryDevice
	saves   int
}

func (f *fakeWatchStore) DevicesOfProject(string, time.Time) ([]domain.TelemetryDevice, error) {
	return f.devices, nil
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// Como la base: sólo cambia si el estado sigue siendo el que se leyó.
func (f *fakeWatchStore) SwapIncidents(id string, oldSilent, oldUnhealthy, silent, unhealthy *time.Time) (bool, error) {
	for i := range f.devices {
		d := &f.devices[i]
		if d.ID == id && sameTime(d.SilentSince, oldSilent) && sameTime(d.UnhealthySince, oldUnhealthy) {
			f.saves++
			d.SilentSince, d.UnhealthySince = silent, unhealthy
			return true, nil
		}
	}
	return false, nil
}

type fakeProjects struct{ list []domain.ReportProject }

func (f fakeProjects) ListAll() ([]domain.ReportProject, error) { return f.list, nil }

type fakeInbox struct{ got []domain.Aviso }

func (f *fakeInbox) Notify(a domain.Aviso) { f.got = append(f.got, a) }

func (f *fakeInbox) keys() []string {
	out := []string{}
	for _, a := range f.got {
		out = append(out, a.TitleKey+"→"+a.UserID)
	}
	return out
}

const onShift = `{"snapshot":{"tracking":{"active":true,"lastCallbackAgeSeconds":30}}}`
const offShift = `{"snapshot":{"tracking":{"active":false,"lastCallbackAgeSeconds":30}}}`
const stuck = `{"snapshot":{"tracking":{"active":true,"lastCallbackAgeSeconds":5000}}}`

func watchConfig() domain.TelemetryConfig {
	return domain.TelemetryConfig{
		Heartbeat: &domain.Heartbeat{IntervalSeconds: 300, GraceSeconds: 60,
			ActiveWhen: &domain.Condition{Path: "snapshot.tracking.active", Op: "==", Value: true}},
		HealthRules: []domain.HealthRule{
			{Condition: domain.Condition{Path: "snapshot.tracking.lastCallbackAgeSeconds", Op: ">", Value: 600.0},
				Severity: domain.SeverityError, Message: "rastreo parado"},
			// Un warn no abre incidente: sólo se pinta.
			{Condition: domain.Condition{Path: "snapshot.tracking.active", Op: "==", Value: true},
				Severity: domain.SeverityWarn, Message: "sólo un aviso"},
		},
	}
}

func setup(snapshot string, lastBeat time.Time) (*TelemetryWatcher, *fakeWatchStore, *fakeInbox) {
	owner := "u-owner"
	store := &fakeWatchStore{devices: []domain.TelemetryDevice{{
		BaseModel: domain.BaseModel{ID: "row-1"}, ProjectID: "p1", DeviceID: "dev-1",
		Label: "Pixel 8", Subject: "E-104", LastBeatAt: &lastBeat, Snapshot: []byte(snapshot),
	}}}
	inbox := &fakeInbox{}
	w := &TelemetryWatcher{
		store: store,
		projects: fakeProjects{list: []domain.ReportProject{{
			BaseModel: domain.BaseModel{ID: "p1"}, OrgID: "o1", Name: "GEOCHECK", IsActive: true,
			DefaultAssigneeUserID: &owner, TelemetryConfig: watchConfig(),
		}}},
		inbox: inbox,
		open:  func(b []byte) []byte { return b },
	}
	return w, store, inbox
}

var t0 = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

func TestASilentDeviceIsReportedOnceAndAgainWhenItComesBack(t *testing.T) {
	w, store, inbox := setup(onShift, t0)

	// Dentro del intervalo más la gracia: nada.
	_ = w.Tick(t0.Add(5 * time.Minute))
	if len(inbox.got) != 0 {
		t.Fatalf("avisó antes de tiempo: %v", inbox.keys())
	}
	// Pasado: un aviso, al responsable.
	_ = w.Tick(t0.Add(7 * time.Minute))
	if k := inbox.keys(); len(k) != 1 || k[0] != "notify.telemetry.silent→u-owner" {
		t.Fatalf("%v", k)
	}
	a := inbox.got[0]
	if a.Kind != "telemetry:alert" || a.TitleArgs["device"] != "Pixel 8 (E-104)" ||
		a.Link != "/diagnostics?device=dev-1&project=p1" || a.Group != domain.TelemetryGroup("p1") {
		t.Errorf("el aviso: %+v", a)
	}
	if s := store.devices[0].SilentSince; s == nil || !s.Equal(t0) {
		t.Errorf("el incidente se cuenta desde el último latido: %v", s)
	}
	// Las pasadas siguientes no repiten.
	_ = w.Tick(t0.Add(12 * time.Minute))
	_ = w.Tick(t0.Add(17 * time.Minute))
	if len(inbox.got) != 1 {
		t.Fatalf("repitió: %v", inbox.keys())
	}
	// Vuelve a latir: un aviso de cierre.
	back := t0.Add(18 * time.Minute)
	store.devices[0].LastBeatAt = &back
	_ = w.Tick(t0.Add(19 * time.Minute))
	if k := inbox.keys(); len(k) != 2 || k[1] != "notify.telemetry.back→u-owner" {
		t.Fatalf("%v", k)
	}
	if store.devices[0].SilentSince != nil {
		t.Error("el incidente sigue abierto")
	}
}

func TestOffShiftSilenceIsNotAnIncident(t *testing.T) {
	w, _, inbox := setup(offShift, t0)
	_ = w.Tick(t0.Add(2 * time.Hour))
	if len(inbox.got) != 0 {
		t.Fatalf("avisó de alguien fuera de turno: %v", inbox.keys())
	}
}

func TestAnAbandonedDeviceIsNotAnIncident(t *testing.T) {
	w, _, inbox := setup(onShift, t0)
	_ = w.Tick(t0.Add(staleAfter + time.Minute))
	if len(inbox.got) != 0 {
		t.Fatalf("avisó de un teléfono abandonado: %v", inbox.keys())
	}
}

func TestAnErrorRuleOpensAndClosesAHealthIncident(t *testing.T) {
	w, store, inbox := setup(stuck, t0)
	_ = w.Tick(t0.Add(time.Minute))
	if k := inbox.keys(); len(k) != 1 || k[0] != "notify.telemetry.unhealthy→u-owner" {
		t.Fatalf("%v", k)
	}
	if inbox.got[0].Body != "rastreo parado" {
		t.Errorf("el cuerpo dice qué regla, y sólo las de error: %q", inbox.got[0].Body)
	}
	_ = w.Tick(t0.Add(2 * time.Minute))
	if len(inbox.got) != 1 {
		t.Fatalf("repitió: %v", inbox.keys())
	}
	store.devices[0].Snapshot = []byte(onShift)
	_ = w.Tick(t0.Add(3 * time.Minute))
	if k := inbox.keys(); len(k) != 2 || k[1] != "notify.telemetry.healthy→u-owner" {
		t.Fatalf("%v", k)
	}
}

// Un reinicio del backend no repite: el estado está en la fila, no en memoria.
func TestARestartDoesNotRepeat(t *testing.T) {
	w, store, inbox := setup(onShift, t0)
	_ = w.Tick(t0.Add(7 * time.Minute))
	again := &TelemetryWatcher{store: store, projects: w.projects, inbox: inbox, open: w.open}
	_ = again.Tick(t0.Add(8 * time.Minute))
	if len(inbox.got) != 1 {
		t.Fatalf("repitió tras reiniciar: %v", inbox.keys())
	}
}

// Dos réplicas leen el mismo estado: sólo avisa la que gana el cambio.
func TestTwoReplicasDoNotBothReport(t *testing.T) {
	w, store, inbox := setup(onShift, t0)
	stale := store.devices[0] // lo que leyó la otra réplica, antes del cambio
	_ = w.Tick(t0.Add(7 * time.Minute))
	if err := w.check(&w.projects.(fakeProjects).list[0], &stale, t0.Add(7*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(inbox.got) != 1 {
		t.Fatalf("avisaron las dos: %v", inbox.keys())
	}
}

func TestTheAlertAlsoGoesLiveToEachPerson(t *testing.T) {
	w, _, _ := setup(onShift, t0)
	var got []events.Event
	w.publish = func(e events.Event) { got = append(got, e) }
	_ = w.Tick(t0.Add(7 * time.Minute))
	if len(got) != 1 || got[0].Type != "telemetry:alert" || got[0].UserID != "u-owner" {
		t.Fatalf("%+v", got)
	}
	ev := got[0].Data.(TelemetryAlertEvent)
	if ev.Key != "telemetry.silent" || ev.Device != "Pixel 8 (E-104)" || ev.Link == "" {
		t.Errorf("%+v", ev)
	}
}

func TestWithoutAnOwnerTheWholeOrgIsTold(t *testing.T) {
	w, _, inbox := setup(onShift, t0)
	p := w.projects.(fakeProjects)
	p.list[0].DefaultAssigneeUserID = nil
	w.members = func(string) ([]string, error) { return []string{"a", "b", "a"}, nil }
	_ = w.Tick(t0.Add(7 * time.Minute))
	if k := inbox.keys(); len(k) != 2 {
		t.Fatalf("%v", k)
	}
}

func TestAProjectWithNothingToWatchIsSkipped(t *testing.T) {
	w, _, inbox := setup(stuck, t0)
	p := w.projects.(fakeProjects)
	p.list[0].TelemetryConfig = domain.TelemetryConfig{HealthRules: []domain.HealthRule{
		{Condition: domain.Condition{Path: "snapshot.tracking.active", Op: "==", Value: true},
			Severity: domain.SeverityWarn, Message: "sólo un aviso"},
	}}
	_ = w.Tick(t0.Add(time.Hour))
	if len(inbox.got) != 0 {
		t.Fatalf("%v", inbox.keys())
	}
}
