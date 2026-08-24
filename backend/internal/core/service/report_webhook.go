package service

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// Outbound webhooks: the same five report events that feed the live stream,
// POSTed to whatever URL a project configured.
//
// Configuration is per project rather than global so a tenant only ever
// receives its own events — with several tenants on one cac, a single global
// endpoint would leak every organization's activity to all of them.
//
// Delivery is best-effort by design. A missed POST loses a *notification*, not
// data: the report is already stored, and the receiving app can read it back
// over the API. Guaranteed delivery would mean an outbox table and a drainer,
// which is a lot of machinery for "someone didn't get a toast".

const (
	webhookTimeout  = 10 * time.Second
	webhookAttempts = 3
)

// webhookPayload is the body receivers verify and parse. `data` is the same
// map the live stream carries, so a receiver can treat both the same way.
type webhookPayload struct {
	// Un id por **evento**, no por intento. Es lo único que deja al receptor
	// distinguir "esto pasó dos veces" de "lo estoy recibiendo dos veces": un
	// reintento repite el cuerpo byte a byte, firma incluida, así que sin esto
	// los dos casos son indistinguibles y la única defensa posible es guardar
	// una huella de tipo+reporte+`at` unos minutos — que además falla si dos
	// eventos legítimos del mismo tipo caen en el mismo segundo.
	//
	// Se genera donde se serializa el cuerpo, que es **una sola vez** para los
	// tres intentos. Generarlo dentro del bucle lo dejaría inservible, y es un
	// error que no se ve en ninguna prueba manual: los duplicados sólo aparecen
	// cuando el receptor va lento.
	EventID   string `json:"eventId"`
	Type      string `json:"type"`
	ReportID  string `json:"reportId"`
	ProjectID string `json:"projectId"`
	Folio     string `json:"folio"`
	// Who filed the report, in the receiving app's own id space — it's the
	// value that app passed to ingest. Present on every event so routing a
	// notification is a field lookup, not a callback or a local index:
	// "your report was answered" needs to know whose report it is, and the
	// comment event alone can't say.
	ReporterID   string         `json:"reporterId"`
	ReporterName string         `json:"reporterName,omitempty"`
	Data         map[string]any `json:"data"`
	At           time.Time      `json:"at"`
}

// signPayload returns the value of the X-Cac-Signature header: HMAC-SHA256 of
// the exact bytes sent, hex-encoded. Receivers must compare against the raw
// body they received, before parsing — re-serializing JSON can reorder keys
// and would break the comparison.
func signPayload(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// dispatchWebhook fires the event at the project's endpoint, off the request's
// goroutine — an ingest must not wait on, or fail because of, a third party's
// server.
func dispatchWebhook(t *domain.ReportEventTarget, eventType, reportID string, data map[string]any) {
	if t == nil {
		return
	}
	// Un proyecto sin webhook deja de comportarse igual que uno que funciona.
	//
	// Esto volvía en silencio, y la pregunta «¿se le está avisando al cliente
	// cuando comento?» no se podía contestar sin leer el código: un proyecto mal
	// configurado y uno bien configurado hacían exactamente lo mismo desde
	// fuera, o sea nada observable. La línea cuesta un log y contesta sola.
	//
	// A nivel de aviso y no de error: no tener webhook es una decisión válida
	// —hay inquilinos que sólo miran el tablero— y llenar de errores el registro
	// por algo que puede ser deliberado enseña a ignorarlo.
	if t.WebhookURL == "" {
		lg.Warn("webhook: " + t.Folio + " (proyecto " + t.ProjectID + ") no tiene URL configurada, " + eventType + " no sale")
		return
	}
	body, err := json.Marshal(webhookPayload{
		EventID: uuid.NewString(),
		Type:    eventType, ReportID: reportID, ProjectID: t.ProjectID,
		Folio: t.Folio, ReporterID: t.ReporterID, ReporterName: t.ReporterName,
		Data: data, At: time.Now().UTC(),
	})
	if err != nil {
		lg.Error("webhook: cannot serialize " + eventType + ": " + err.Error())
		return
	}
	url, secret := t.WebhookURL, t.WebhookSecret

	go func() {
		client := &http.Client{Timeout: webhookTimeout}
		for attempt := 1; attempt <= webhookAttempts; attempt++ {
			req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
			if err != nil {
				lg.Error("webhook: bad url " + url + ": " + err.Error())
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Cac-Event", eventType)
			if secret != "" {
				req.Header.Set("X-Cac-Signature", signPayload(secret, body))
			}

			res, err := client.Do(req)
			if err == nil {
				code := res.StatusCode
				res.Body.Close()
				if code < 300 {
					return
				}
				// 4xx is the receiver saying "this request is wrong" — retrying
				// an unchanged body would just repeat the same rejection.
				if code < 500 {
					lg.Error("webhook: " + url + " refused " + eventType + " with " + res.Status)
					return
				}
			}
			if attempt < webhookAttempts {
				time.Sleep(time.Duration(attempt) * 2 * time.Second)
			}
		}
		lg.Error("webhook: giving up on " + eventType + " to " + url +
			" after " + strconv.Itoa(webhookAttempts) + " attempts")
	}()
}
