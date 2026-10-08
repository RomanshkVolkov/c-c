package service

import (
	"net/url"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El vigilante de la telemetría: avisa cuando un dispositivo que debería latir
// se calla, o cuando su ficha incumple una regla de gravedad `error`.
//
// Avisa **una vez al abrirse** el incidente y **una vez al cerrarse**, no en
// cada pasada: el estado vive en `telemetry_devices` (`silent_since`,
// `unhealthy_since`), así que un reinicio del backend tampoco repite nada. Un
// aviso que se repite cada cinco minutos es un aviso que se aprende a ignorar.
//
// Nada de esto sabe qué app es: qué es «latir» y qué es «estar mal» lo dice la
// configuración del proyecto (TelemetryConfig). Un proyecto sin latido ni
// reglas de error no se mira.

// staleAfter: un dispositivo callado desde hace más de esto no está «callado»,
// está abandonado (se desinstaló, cambió de teléfono). No se le abre incidente:
// al configurar el latido de un proyecto con meses de historia, avisar de cada
// teléfono viejo sería una ráfaga de avisos sobre nada.
const staleAfter = 24 * time.Hour

// TelemetryWatchStore es lo que el vigilante necesita de la base.
type TelemetryWatchStore interface {
	DevicesOfProject(projectID string, since time.Time) ([]domain.TelemetryDevice, error)
	SwapIncidents(id string, oldSilent, oldUnhealthy, silentSince, unhealthySince *time.Time) (bool, error)
}

// TelemetryWatchProjects: los proyectos, y a quién avisar en cada uno.
type TelemetryWatchProjects interface {
	ListAll() ([]domain.ReportProject, error)
}

type TelemetryWatcher struct {
	store    TelemetryWatchStore
	projects TelemetryWatchProjects
	members  func(orgID string) ([]string, error)
	inbox    Notifier
	// publish lleva el aviso al escritorio en vivo (el aviso del sistema). La
	// campana sola sólo se ve al abrirla.
	publish func(events.Event)
	// open descifra la ficha guardada. Inyectable para probar sin llave.
	open func([]byte) []byte
}

func NewTelemetryWatcher(store *repository.TelemetryRepository, projects *repository.ReportProjectRepository, orgs *repository.OrganizationRepository, inbox Notifier, hub *events.Hub) *TelemetryWatcher {
	var publish func(events.Event)
	if hub != nil {
		publish = hub.Publish
	}
	return &TelemetryWatcher{
		store: store, projects: projects, members: orgs.MemberIDs, inbox: inbox, publish: publish,
		open: func(b []byte) []byte { return openSnapshot(b) },
	}
}

// watched dice si el proyecto tiene algo que vigilar.
func watched(c domain.TelemetryConfig) bool {
	if c.Heartbeat != nil {
		return true
	}
	for _, r := range c.HealthRules {
		if r.Severity == domain.SeverityError {
			return true
		}
	}
	return false
}

// Verdict es lo que el vigilante concluye de un dispositivo en una pasada.
type Verdict struct {
	Silent    bool
	Unhealthy bool
	// Reasons: los mensajes de las reglas de error que se cumplen.
	Reasons []string
}

// Judge es la regla entera, pura: qué le pasa a un dispositivo ahora.
func Judge(cfg domain.TelemetryConfig, d domain.TelemetryDevice, snapshot []byte, now time.Time) Verdict {
	var v Verdict
	if hb := cfg.Heartbeat; hb != nil && d.LastBeatAt != nil &&
		now.Sub(*d.LastBeatAt) <= staleAfter &&
		hb.ShouldBeBeating(snapshot) && hb.IsSilent(d.LastBeatAt, now) {
		v.Silent = true
	}
	var errorRules []domain.HealthRule
	for _, r := range cfg.HealthRules {
		if r.Severity == domain.SeverityError {
			errorRules = append(errorRules, r)
		}
	}
	if len(errorRules) > 0 {
		for _, a := range domain.EvaluateHealth(snapshot, errorRules) {
			v.Unhealthy = true
			v.Reasons = append(v.Reasons, a.Message)
		}
	}
	return v
}

// Tick hace una pasada sobre todos los proyectos vigilados.
func (w *TelemetryWatcher) Tick(now time.Time) error {
	projects, err := w.projects.ListAll()
	if err != nil {
		return err
	}
	for i := range projects {
		p := &projects[i]
		if !p.IsActive || !watched(p.TelemetryConfig) {
			continue
		}
		devices, err := w.store.DevicesOfProject(p.ID, now.Add(-staleAfter))
		if err != nil {
			return err
		}
		for j := range devices {
			if err := w.check(p, &devices[j], now); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *TelemetryWatcher) check(p *domain.ReportProject, d *domain.TelemetryDevice, now time.Time) error {
	v := Judge(p.TelemetryConfig, *d, w.open(d.Snapshot), now)
	silentSince, unhealthySince := d.SilentSince, d.UnhealthySince
	var events []string
	switch {
	case v.Silent && silentSince == nil:
		// Desde el último latido, que es cuando de verdad se calló.
		t := *d.LastBeatAt
		silentSince = &t
		events = append(events, "notify.telemetry.silent")
	case !v.Silent && silentSince != nil:
		silentSince = nil
		events = append(events, "notify.telemetry.back")
	}
	switch {
	case v.Unhealthy && unhealthySince == nil:
		t := now
		unhealthySince = &t
		events = append(events, "notify.telemetry.unhealthy")
	case !v.Unhealthy && unhealthySince != nil:
		unhealthySince = nil
		events = append(events, "notify.telemetry.healthy")
	}
	if len(events) == 0 {
		return nil
	}
	// Primero el estado, luego el aviso: si guardar falla, la siguiente pasada
	// lo vuelve a intentar y avisa entonces. Al revés, un fallo al guardar
	// repetiría el aviso cada cinco minutos. Y si otra réplica ya lo cambió,
	// el aviso es suyo.
	won, err := w.store.SwapIncidents(d.ID, d.SilentSince, d.UnhealthySince, silentSince, unhealthySince)
	if err != nil || !won {
		return err
	}
	for _, key := range events {
		body := ""
		if key == "notify.telemetry.unhealthy" {
			body = strings.Join(v.Reasons, " · ")
		}
		w.notify(p, d, key, body)
	}
	return nil
}

// TelemetryAlertEvent es lo que viaja por el stream con cada aviso.
type TelemetryAlertEvent struct {
	// Key: telemetry.silent | telemetry.back | telemetry.unhealthy | telemetry.healthy
	Key     string `json:"key"`
	Device  string `json:"device"`
	Project string `json:"project"`
	Body    string `json:"body,omitempty"`
	Link    string `json:"link"`
}

// deviceName es cómo se le llama al dispositivo en un aviso.
func deviceName(d *domain.TelemetryDevice) string {
	name := d.Label
	if name == "" {
		name = d.DeviceID
		if len(name) > 8 {
			name = name[:8]
		}
	}
	if d.Subject != "" {
		name += " (" + d.Subject + ")"
	}
	return name
}

// DiagnosticsLink abre el dispositivo en la pantalla de Diagnóstico.
func DiagnosticsLink(projectID, deviceID string) string {
	return "/diagnostics?" + url.Values{"project": {projectID}, "device": {deviceID}}.Encode()
}

// notify avisa al responsable del proyecto, o a toda la organización si no
// tiene: la misma regla que un reporte nuevo (ver avisos.reporteNuevo).
func (w *TelemetryWatcher) notify(p *domain.ReportProject, d *domain.TelemetryDevice, key, body string) {
	if w.inbox == nil {
		return
	}
	var who []string
	if p.DefaultAssigneeUserID != nil && *p.DefaultAssigneeUserID != "" {
		who = []string{*p.DefaultAssigneeUserID}
	} else if w.members != nil {
		var err error
		if who, err = w.members(p.OrgID); err != nil {
			return
		}
	}
	seen := map[string]bool{}
	for _, uid := range who {
		if uid == "" || seen[uid] {
			continue
		}
		seen[uid] = true
		link := DiagnosticsLink(p.ID, d.DeviceID)
		w.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: p.OrgID, Kind: "telemetry:alert",
			TitleKey: key, TitleArgs: map[string]string{"device": deviceName(d)},
			Body: body, Link: link,
			Group: domain.TelemetryGroup(p.ID), Label: p.Name,
		})
		if w.publish != nil {
			// A la persona, no a la org: es su campana la que tiene la fila. La
			// app pone el título en su idioma con la misma clave.
			w.publish(events.Event{Type: "telemetry:alert", OrgID: p.OrgID, UserID: uid, Data: TelemetryAlertEvent{
				Key: strings.TrimPrefix(key, "notify."), Device: deviceName(d), Project: p.Name, Body: body, Link: link,
			}})
		}
	}
}
