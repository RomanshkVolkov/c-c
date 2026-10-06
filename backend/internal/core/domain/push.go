package domain

import (
	"net/url"
	"strings"
	"time"
)

// ─── Avisos al teléfono (W2) ──────────────────────────────────────────────────
//
// La campana de cac, empujada a los dispositivos donde cada quien la pidió: la
// versión web instalada en un teléfono (o un navegador de escritorio). Es Web
// Push estándar —VAPID, sin Firebase ni la cuenta de Apple—, y sale del mismo
// sitio que la fila de la campana: `NotificationService.Notify`, que es el único
// que decide qué quiere cada quien. Nada llega al teléfono que no estuviera ya
// en la campana.

// PushSubscription es un dispositivo que pidió avisos.
//
// Lo que guarda es lo que el navegador entrega al suscribirse: a dónde mandar
// (`Endpoint`, la URL del servicio de push de ese navegador) y las dos llaves
// con las que se cifra cada aviso para que sólo ese navegador lo lea. El
// servicio de push del fabricante sólo ve un blob cifrado.
type PushSubscription struct {
	BaseModel
	UserID string `gorm:"type:varchar(36);index;not null" json:"-"`
	// Endpoint identifica el dispositivo: el mismo navegador que se vuelve a
	// suscribir trae el mismo, y se actualiza en vez de duplicarse.
	Endpoint string `gorm:"type:text;uniqueIndex;not null" json:"endpoint"`
	P256dh   string `gorm:"type:varchar(200);not null" json:"-"`
	Auth     string `gorm:"type:varchar(100);not null" json:"-"`
	// UserAgent: para que la persona reconozca cuál es cada dispositivo.
	UserAgent string `gorm:"type:varchar(300)" json:"userAgent"`
	// LastOkAt: el último aviso que el servicio de push aceptó. Uno que lleva
	// meses sin aceptar nada es un dispositivo que ya no existe.
	LastOkAt *time.Time `json:"lastOkAt,omitempty"`
}

// PushSubscribeRequest es lo que manda la web: el `PushSubscription.toJSON()`
// del navegador, tal cual.
type PushSubscribeRequest struct {
	Endpoint string `json:"endpoint" validate:"required,url,max=2000"`
	Keys     struct {
		P256dh string `json:"p256dh" validate:"required,max=200"`
		Auth   string `json:"auth"   validate:"required,max=100"`
	} `json:"keys"`
}

// pushHosts son los servicios de push de los navegadores. Un endpoint sólo se
// acepta si es HTTPS a uno de ellos: si no, el backend haría una petición a la
// URL que le diera cualquiera, en cada aviso (barrido, 6-oct-2026).
var pushHosts = []string{
	"fcm.googleapis.com",                // Chrome, Edge, Android
	"updates.push.services.mozilla.com", // Firefox
	"push.apple.com",                    // Safari (web.push.apple.com y demás)
	"notify.windows.com",                // Edge en Windows (WNS)
}

// ValidPushEndpoint: HTTPS, sin credenciales en la URL, y a un servicio de push
// conocido (o uno de sus subdominios).
func ValidPushEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range pushHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			return true
		}
	}
	return false
}

// MaxPushDevicesPerUser: cuántos dispositivos puede tener suscritos una
// persona. Un teléfono, un par de navegadores… diez es de sobra, y sin tope una
// cuenta podía llenar la tabla y multiplicar las peticiones de cada aviso.
const MaxPushDevicesPerUser = 10

// PushKeyResponse: la llave pública VAPID con la que el navegador se suscribe.
// Vacía = este servidor no tiene push configurado, y la web no ofrece el botón.
type PushKeyResponse struct {
	Key string `json:"key"`
}

// PushMessage es lo que viaja cifrado al dispositivo y lee el service worker.
// Corto a propósito: los servicios de push limitan el tamaño (unos 4 KB).
type PushMessage struct {
	// ID de la fila de la campana: al pulsar, la web la marca leída.
	ID    string `json:"id,omitempty"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
	// Link: la ruta dentro de la app (`/tasks?task=…`), la misma de la campana.
	Link string `json:"link,omitempty"`
	// Tag: avisos con el mismo tag se **reemplazan** en el teléfono en vez de
	// apilarse. Es la clave de grupo de la campana: diez mensajes de un canal
	// son una notificación que se actualiza, no diez.
	Tag   string `json:"tag,omitempty"`
	OrgID string `json:"orgId,omitempty"`
}

// PushAllows: si un aviso que ya pasó por `Allows` (la campana) va además al
// teléfono. La campana manda; esto sólo puede quitar.
//
//   - `PushQuiet` apaga todo el teléfono.
//   - La actividad de CI no va al teléfono salvo que se pida (`PushCI`): un push
//     son tantos avisos como workflows, y en la campana del escritorio se
//     pliegan, pero en un teléfono serían una ráfaga.
func (p NotificationPrefs) PushAllows(kind string) bool {
	if p.PushQuiet {
		return false
	}
	if strings.HasPrefix(kind, "ci:") || strings.HasPrefix(kind, "deploy:") {
		return p.PushCI
	}
	return true
}
