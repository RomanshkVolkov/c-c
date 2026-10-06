package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ─── Avisos al teléfono (W2) ──────────────────────────────────────────────────

// PushOptions: cómo de urgente es un aviso y cuánto vale esperar a entregarlo.
type PushOptions struct {
	// TTL: cuánto guarda el servicio de push el aviso si el teléfono está
	// apagado. Un mensaje vale un día; un timbre, veinte segundos —entregarlo
	// después sería anunciar una llamada que ya no existe—.
	TTL time.Duration
	// High: urgencia alta. Despierta al teléfono aunque esté ahorrando batería.
	High bool
}

// PushTransport manda un aviso cifrado a un dispositivo y dice qué contestó el
// servicio de push. Una interfaz para poder probar las reglas sin red.
type PushTransport interface {
	Send(sub domain.PushSubscription, payload []byte, topic string, opts PushOptions) (status int, err error)
}

// webPushTransport: Web Push estándar con VAPID.
type webPushTransport struct{ public, private, subject string }

func (t webPushTransport) Send(sub domain.PushSubscription, payload []byte, topic string, opts PushOptions) (int, error) {
	urgency := webpush.UrgencyNormal
	if opts.High {
		urgency = webpush.UrgencyHigh
	}
	resp, err := webpush.SendNotification(payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		Subscriber:      t.subject,
		VAPIDPublicKey:  t.public,
		VAPIDPrivateKey: t.private,
		TTL:             int(opts.TTL.Seconds()),
		Urgency:         urgency,
		Topic:           topic,
	})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// PushService manda la campana a los dispositivos de cada quien.
type PushService struct {
	repo      *repository.PushRepository
	transport PushTransport
	publicKey string
	now       func() time.Time
	// async: en producción cada envío va en su goroutine, porque un servicio
	// de push lento no puede frenar el mensaje que causó el aviso. En las
	// pruebas, en el mismo hilo.
	async bool
	wg    sync.WaitGroup
}

// NewPushService: sin las dos llaves VAPID devuelve un servicio apagado, que
// no manda nada y le dice a la web que no ofrezca el botón.
func NewPushService(repo *repository.PushRepository, public, private, subject string) *PushService {
	s := &PushService{repo: repo, publicKey: public, now: time.Now, async: true}
	if public != "" && private != "" {
		if subject == "" {
			subject = "https://cac.guz-studio.dev"
		}
		s.transport = webPushTransport{public: public, private: private, subject: subject}
	}
	return s
}

// WithTransport: otro transporte y en el mismo hilo. Sólo para las pruebas.
func (s *PushService) WithTransport(t PushTransport, public string) *PushService {
	s.transport, s.publicKey, s.async = t, public, false
	return s
}

func (s *PushService) Configured() bool { return s != nil && s.transport != nil && s.publicKey != "" }

func (s *PushService) PublicKey() string {
	if !s.Configured() {
		return ""
	}
	return s.publicKey
}

// ErrBadPushEndpoint: no es un servicio de push conocido por HTTPS.
var ErrBadPushEndpoint = errors.New("bad-push-endpoint")

// ErrTooManyPushDevices: ya hay MaxPushDevicesPerUser.
var ErrTooManyPushDevices = errors.New("too-many-push-devices")

func (s *PushService) Subscribe(userID, userAgent string, req domain.PushSubscribeRequest) error {
	if !domain.ValidPushEndpoint(req.Endpoint) {
		return ErrBadPushEndpoint
	}
	if !s.repo.Has(userID, req.Endpoint) {
		if n, err := s.repo.CountForUser(userID); err != nil {
			return err
		} else if n >= domain.MaxPushDevicesPerUser {
			return ErrTooManyPushDevices
		}
	}
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	return s.repo.Upsert(&domain.PushSubscription{
		UserID: userID, Endpoint: req.Endpoint, P256dh: req.Keys.P256dh, Auth: req.Keys.Auth, UserAgent: userAgent,
	})
}

func (s *PushService) Unsubscribe(userID, endpoint string) error {
	return s.repo.Delete(userID, endpoint)
}

// Send manda un aviso a todos los dispositivos de una persona. Nunca falla
// hacia fuera: un dispositivo que no contesta no es asunto de quien escribió.
// Los que el servicio de push da por muertos (404, 410) se olvidan.
func (s *PushService) Send(userID string, msg domain.PushMessage, opts PushOptions) {
	if !s.Configured() || userID == "" {
		return
	}
	run := func() {
		subs, err := s.repo.ForUser(userID)
		if err != nil || len(subs) == 0 {
			return
		}
		payload, err := json.Marshal(msg)
		if err != nil {
			return
		}
		if opts.TTL <= 0 {
			opts.TTL = 24 * time.Hour
		}
		topic := pushTopic(msg.Tag)
		for _, sub := range subs {
			status, err := s.transport.Send(sub, payload, topic, opts)
			switch {
			case err != nil:
				lg.Warn("push: " + err.Error())
			case status == http.StatusNotFound || status == http.StatusGone:
				_ = s.repo.Forget(sub.Endpoint)
			case status >= 200 && status < 300:
				_ = s.repo.MarkOk(sub.ID, s.now())
			default:
				lg.Warn("push: the push service answered " + http.StatusText(status))
			}
		}
	}
	if !s.async {
		run()
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		run()
	}()
}

// pushTopic: la cabecera `Topic` de Web Push hace que el servicio de push
// **reemplace** un aviso pendiente del mismo tema en vez de guardar los dos. Su
// formato es estricto (32 caracteres de base64url como mucho), y la clave de
// grupo de la campana no cabe —`space:<uuid>`—, así que va resumida. Vacío =
// sin tema: cada aviso se entrega por separado.
func pushTopic(tag string) string {
	if tag == "" {
		return ""
	}
	h := sha256.Sum256([]byte(tag))
	return base64.RawURLEncoding.EncodeToString(h[:])[:32]
}

// ─── El enchufe con la campana ───────────────────────────────────────────────

// pushOut es el servicio de push del proceso. Uno solo y puesto al arrancar
// (SetPush), y no un parámetro de `NotificationService`, porque ése se
// construye en siete sitios distintos y olvidar uno dejaría una clase entera
// de avisos sin llegar al teléfono sin que nada lo delatara.
var pushOut *PushService

// SetPush engancha el push al arrancar. nil lo apaga (las pruebas).
func SetPush(p *PushService) { pushOut = p }

// PushToPhone: lo que hace `Notify` después de escribir la fila. Aparte para
// que el timbre —que no deja fila— pueda usarlo también.
func PushToPhone(userID string, msg domain.PushMessage, opts PushOptions) {
	if pushOut != nil {
		pushOut.Send(userID, msg, opts)
	}
}
