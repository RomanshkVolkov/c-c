package service

import (
	"context"
	"os"
	"testing"
	"time"

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
