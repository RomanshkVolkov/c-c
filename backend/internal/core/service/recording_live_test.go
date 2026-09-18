package service

import (
	"context"
	"os"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// La única prueba de este paquete que necesita un SFU de verdad y **una persona
// dentro de una llamada**.
//
// Salta siempre salvo que se le diga la sala a mirar:
//
//	RECORDINGS_LIVE_ROOM=voice:<spaceId> \
//	LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
//	DB_HOST=… go test ./internal/core/service/ -run LiveSFU -v
//
// # Por qué existe teniendo dobles
//
// Los dobles contestan por la lógica —qué se descubre, qué se descarta, cuándo
// se cierra— y no pueden contestar por el contrato: que el cliente Twirp
// **generado** hable de verdad con este LiveKit, que `Source` llegue con el
// nombre que `domain.Recordable` espera, y que `FileInfo` traiga el ancla donde
// se la busca. Eso sólo lo sabe un SFU.
//
// Es la puerta de la fase 1, escrita para poder repetirse: cuando algo de esto
// se rompa al subir de versión, aquí está el guion.
func TestLiveSFURecordsWhatIsInTheRoom(t *testing.T) {
	room := os.Getenv("RECORDINGS_LIVE_ROOM")
	if room == "" {
		t.Skip("no live room: set RECORDINGS_LIVE_ROOM=voice:<spaceId>")
	}
	lk := lkclient.New(os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"),
		os.Getenv("LIVEKIT_API_SECRET"))
	if lk == nil {
		t.Skip("no livekit keys in the environment")
	}
	ctx := context.Background()

	// 1. Descubrir. Sin gente dentro no hay nada que medir, y decirlo es más
	//    útil que un fallo a mitad.
	people, err := lk.Participants(ctx, room)
	if err != nil {
		t.Fatalf("ListParticipants: %v", err)
	}
	if humans(people) == 0 {
		t.Fatalf("nobody is in %s — join the call and run this again", room)
	}
	graba, descarta := 0, 0
	for _, p := range people {
		t.Logf("  %-24s kind=%v", p.Identity, p.Kind)
		for _, tr := range p.Tracks {
			ok := domain.Recordable(tr.Source.String())
			if ok {
				graba++
			} else {
				descarta++
			}
			t.Logf("      %-22s %-22s muted=%v  →  %s",
				tr.Sid, tr.Source.String(), tr.Muted,
				map[bool]string{true: "SE GRABA", false: "se descarta"}[ok])
		}
	}
	if graba == 0 {
		t.Fatal("nothing recordable in the room: is the microphone published?")
	}

	// 2. El servicio entero, con la base de verdad y el SFU de verdad.
	repo := repository.NewRecordingRepository(recordingDB(t))
	svc := NewRecordingService(repo, lk, nil,
		os.Getenv("RECORDINGS_PREFIX"), true, true, 240)
	spaceID := room[len("voice:"):]

	rec, err := svc.Start(ctx, "org-live", spaceID, "u-live")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Logf("grabación %s en marcha", rec.ID)

	// 3. Un par de ticks mientras escribe.
	for i := 0; i < 2; i++ {
		time.Sleep(8 * time.Second)
		svc.Tick(ctx, time.Now().UTC())
	}
	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != graba {
		t.Fatalf("%d pistas grabándose y %d se tenían que grabar", len(tracks), graba)
	}
	for _, tr := range tracks {
		if tr.EgressID == "" {
			t.Fatalf("la pista %s no tiene egress: %s", tr.TrackSid, tr.Error)
		}
	}

	// 4. Parar, y esperar a que los ficheros se cierren.
	if err := svc.Stop(ctx, rec, "live-test"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	deadline := time.Now().Add(90 * time.Second)
	var after *domain.Recording
	for time.Now().Before(deadline) {
		time.Sleep(6 * time.Second)
		svc.Tick(ctx, time.Now().UTC())
		after, err = repo.FindByID(rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if after.EgressDoneAt != nil || after.Status == domain.RecordingFailed {
			break
		}
	}
	if after == nil || after.EgressDoneAt == nil {
		// Lo que dijo cada pista, que es lo que explica el fallo. Sin esto el
		// mensaje es «no cerraron» y hay que ir a la base a mano.
		if fallidas, e := repo.Tracks(rec.ID); e == nil {
			for _, tr := range fallidas {
				t.Logf("  %-18s %-10s key=%q error=%q",
					tr.Source, tr.Status, tr.ObjectKey, tr.Error)
			}
		}
		t.Fatalf("los egress no cerraron a tiempo: estado %v  %s", after.Status, after.Error)
	}

	// 5. Y lo que el mux va a necesitar: la clave que Egress escribió y el ancla.
	tracks, err = repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range tracks {
		t.Logf("  %-22s %-18s %s", tr.Source, tr.Status, tr.ObjectKey)
		if tr.Status != domain.TrackComplete {
			t.Errorf("%s acabó en %q: %s", tr.TrackSid, tr.Status, tr.Error)
			continue
		}
		if tr.ObjectKey == "" || tr.StartedAt == nil || tr.Bytes == 0 {
			t.Errorf("%s no trae lo que el mux necesita: key=%q started=%v bytes=%d",
				tr.TrackSid, tr.ObjectKey, tr.StartedAt, tr.Bytes)
		}
	}
	if after.FirstMediaAt == nil {
		t.Error("sin FirstMediaAt el mux no tiene cero de línea de tiempo")
	}
	t.Logf("primer media: %v  ·  egress cerrados: %v", after.FirstMediaAt, after.EgressDoneAt)
}

// Qué pasa cuando el pod de Egress se muere a mitad.
//
// Es la última puerta de la fase 1, y la que no se puede simular con un doble
// de forma honesta: el doble contestaría lo que yo le diga que contesta. Lo que
// hay que saber es qué dice **este** LiveKit cuando el egress que arrancó ya no
// existe — y de eso depende que una grabación se quede colgada para siempre en
// `finalizing` o que cierre con lo que tenga.
//
//	RECORDINGS_LIVE_ROOM=voice:… RECORDINGS_LIVE_KILL=1 \
//	  go test ./internal/core/service/ -run LiveSFUSurvives -v
//
// Quien mata el pod es el guion de fuera, no esta prueba: un test que hace
// `kubectl` contra producción es un test que alguien corre sin querer.
func TestLiveSFUSurvivesAnEgressRestart(t *testing.T) {
	room := os.Getenv("RECORDINGS_LIVE_ROOM")
	if room == "" || os.Getenv("RECORDINGS_LIVE_KILL") == "" {
		t.Skip("no live kill run: set RECORDINGS_LIVE_ROOM and RECORDINGS_LIVE_KILL")
	}
	lk := lkclient.New(os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"),
		os.Getenv("LIVEKIT_API_SECRET"))
	if lk == nil {
		t.Skip("no livekit keys in the environment")
	}
	ctx := context.Background()

	repo := repository.NewRecordingRepository(recordingDB(t))
	svc := NewRecordingService(repo, lk, nil, os.Getenv("RECORDINGS_PREFIX"), true, true, 240)

	rec, err := svc.Start(ctx, "org-live", room[len("voice:"):], "u-live")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Logf("grabación %s en marcha — el guion de fuera matará el pod", rec.ID)

	// Se graba un rato con el pod ya muerto —y **no se detecta**, que es lo
	// medido: LiveKit no da ninguna señal pasiva— y después se para, que es
	// cuando se puede preguntar. Lo que mide esta prueba es que la grabación
	// **cierra** en vez de quedarse colgada, y en cuánto.
	time.Sleep(45 * time.Second)
	if err := svc.Stop(ctx, rec, "live-kill-test"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	t.Log("parada pedida; a partir de aquí el reloj puede preguntar")

	arranque := time.Now()
	var cerrado time.Time
	for i := 0; i < 25; i++ {
		time.Sleep(6 * time.Second)
		svc.Tick(ctx, time.Now().UTC())
		vivas, err := repo.LiveTracks(rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		todas, _ := repo.Tracks(rec.ID)
		estados := ""
		for _, tr := range todas {
			estados += " " + tr.Source + "=" + tr.Status
		}
		// Y lo que el SFU dice en ese mismo instante, que es lo que decide el
		// reloj: quién sigue en la sala y en qué estado está cada egress. Sin
		// esto, un fallo aquí sólo dice «siguieron vivas» y hay que adivinar
		// por qué.
		enSala := ""
		if gente, e := lk.Participants(ctx, room); e == nil {
			for _, p := range gente {
				if p.Kind == lksdk.ParticipantInfo_EGRESS {
					enSala += " " + p.Identity
				}
			}
		} else {
			enSala = " (no contesta: " + e.Error() + ")"
		}
		egr := ""
		if items, e := lk.ListEgress(ctx, room); e == nil {
			for _, it := range items {
				egr += " " + it.EgressId + "=" + it.Status.String()
			}
		} else {
			egr = " (no contesta: " + e.Error() + ")"
		}
		t.Logf("  t+%3.0fs %s | en sala:%s | egress:%s",
			time.Since(arranque).Seconds(), estados, enSala, egr)
		if len(vivas) == 0 {
			cerrado = time.Now()
			break
		}
	}
	if cerrado.IsZero() {
		t.Fatal("las pistas siguieron vivas: una grabación así se queda colgada para siempre")
	}

	todas, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range todas {
		t.Logf("  %-16s %-10s key=%q error=%q", tr.Source, tr.Status, tr.ObjectKey, tr.Error)
	}
	final, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status == domain.RecordingFinalizing && final.EgressDoneAt == nil {
		t.Fatal("la grabación se quedó en finalizing sin cerrar: el mux no la verá nunca")
	}
	t.Logf("cerró en %.0f s desde la parada, en estado %q",
		cerrado.Sub(arranque).Seconds(), final.Status)
}
