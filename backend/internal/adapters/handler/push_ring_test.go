package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

type pushFalso struct {
	mu     sync.Mutex
	envios []struct {
		msg  domain.PushMessage
		opts service.PushOptions
	}
}

func (f *pushFalso) Send(_ domain.PushSubscription, payload []byte, _ string, opts service.PushOptions) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var m domain.PushMessage
	_ = json.Unmarshal(payload, &m)
	f.envios = append(f.envios, struct {
		msg  domain.PushMessage
		opts service.PushOptions
	}{m, opts})
	return 201, nil
}

func conPush(t *testing.T, db *gorm.DB, user string) *pushFalso {
	t.Helper()
	fake := &pushFalso{}
	p := service.NewPushService(repository.NewPushRepository(db), "", "", "").WithTransport(fake, "BPublica")
	service.SetPush(p)
	t.Cleanup(func() { service.SetPush(nil) })
	req := domain.PushSubscribeRequest{Endpoint: "https://fcm.googleapis.com/fcm/send/" + user}
	req.Keys.P256dh, req.Keys.Auth = "p", "a"
	if err := p.Subscribe(user, "", req); err != nil {
		t.Fatal(err)
	}
	return fake
}

// Un timbre llega también al teléfono de quien llamas: urgente y con la vida
// del timbre, para que un teléfono que se enciende tarde no anuncie una llamada
// que ya colgó. Y colgar lo quita con la misma etiqueta. Mutantes: sin urgencia,
// sin TTL (un día por defecto), o una etiqueta distinta al colgar.
func TestARingReachesThePhoneAndHangingUpTakesItBack(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	fake := conPush(t, db, "u-bea")
	h := ringHandler(db, events.NewHub())

	if rec := httptest.NewRecorder(); func() int { h.VoiceRing(rec, ringReq("esp-1", `{"userId":"u-bea"}`, ana())); return rec.Code }() != http.StatusOK {
		t.Fatal("timbrar falló")
	}
	h.VoiceRingCancel(httptest.NewRecorder(), cancelReq("esp-1", "u-bea", ana()))

	if len(fake.envios) != 2 {
		t.Fatalf("%d envíos al teléfono; se esperaban el timbre y su cancelación", len(fake.envios))
	}
	ring, cancel := fake.envios[0], fake.envios[1]
	if ring.msg.Kind != "voice.ring" || ring.msg.Title != "ana" || !strings.Contains(ring.msg.Link, "esp-1") {
		t.Errorf("el timbre no dice quién llama ni a dónde: %+v", ring.msg)
	}
	if !ring.opts.High || ring.opts.TTL != service.TimbreTTL || ring.opts.TTL > time.Minute {
		t.Errorf("el timbre tiene que ser urgente y vivir lo que el timbre: %+v", ring.opts)
	}
	if cancel.msg.Kind != "voice.ring.cancel" || cancel.msg.Tag != ring.msg.Tag || ring.msg.Tag == "" {
		t.Errorf("colgar tiene que quitar esa misma notificación: %q vs %q", cancel.msg.Tag, ring.msg.Tag)
	}
}

// Una app anterior a un interruptor manda las preferencias sin él, y eso no
// puede devolverlo a su valor por defecto. Con el push: callar el teléfono desde
// la web y luego tocar otro interruptor en una app vieja volvía a encenderlo.
// Mutante: decodificar sobre un cero en vez de sobre lo guardado.
func TestPrefsFromAnOldAppKeepWhatTheyDoNotSend(t *testing.T) {
	db, cleanup := ringDB(t)
	defer cleanup()
	svc := service.NewNotificationService(repository.NewNotificationRepository(db))
	saved := domain.DefaultPrefs("u-ana")
	saved.PushQuiet, saved.PushCI = true, true
	if err := svc.SavePrefs(saved); err != nil {
		t.Fatal(err)
	}
	h := NewNotificationHandler(svc)
	body := `{"mentions":true,"dms":false,"comments":true,"reports":true,"messages":true,"workQuiet":false,"meetingsQuiet":false}`
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/notifications/preferences", strings.NewReader(body))
	r = r.WithContext(ringReq("x", "", ana()).Context())
	rec := httptest.NewRecorder()
	h.SavePrefs(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("guardar → %d %s", rec.Code, rec.Body.String())
	}
	got, _ := svc.Prefs("u-ana")
	if got.DMs {
		t.Error("lo que sí manda tiene que guardarse")
	}
	if !got.PushQuiet || !got.PushCI {
		t.Errorf("lo que no manda se perdió: %+v", got)
	}
}
