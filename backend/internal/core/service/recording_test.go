package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ─── El SFU de mentira ───────────────────────────────────────────────────────

// fakeSFU contesta lo que le digas y **apunta lo que le piden**.
//
// Lo segundo es la mitad del valor: casi todo lo que estas pruebas vigilan no
// es lo que el reloj devuelve, sino lo que decide llamar — un egress de más por
// cada cámara, o dos por la misma pista.
type fakeSFU struct {
	people   []*lksdk.ParticipantInfo
	egress   []*lksdk.EgressInfo
	started  []string // sids por los que se pidió un egress, en orden
	stopped  []string
	metadata []string
	failNext bool
}

func (f *fakeSFU) Participants(context.Context, string) ([]*lksdk.ParticipantInfo, error) {
	return f.people, nil
}

func (f *fakeSFU) StartTrackEgress(_ context.Context, _, sid, key string) (*lksdk.EgressInfo, error) {
	f.started = append(f.started, sid)
	if f.failNext {
		f.failNext = false
		return nil, fmt.Errorf("el egress dijo que no")
	}
	info := &lksdk.EgressInfo{
		EgressId: "EG_" + sid, Status: lksdk.EgressStatus_EGRESS_ACTIVE,
	}
	f.egress = append(f.egress, info)
	_ = key
	return info, nil
}

func (f *fakeSFU) StopEgress(_ context.Context, _, id string) (*lksdk.EgressInfo, error) {
	f.stopped = append(f.stopped, id)
	return &lksdk.EgressInfo{EgressId: id}, nil
}

func (f *fakeSFU) ListEgress(context.Context, string) ([]*lksdk.EgressInfo, error) {
	return f.egress, nil
}

func (f *fakeSFU) SetRoomMetadata(_ context.Context, _, md string) error {
	f.metadata = append(f.metadata, md)
	return nil
}

// finish mueve un egress al estado que se le diga, con su fichero.
func (f *fakeSFU) finish(sid string, status lksdk.EgressStatus, filename string, startedAt time.Time) {
	for _, e := range f.egress {
		if e.EgressId != "EG_"+sid {
			continue
		}
		e.Status = status
		if status == lksdk.EgressStatus_EGRESS_COMPLETE {
			e.FileResults = []*lksdk.FileInfo{{
				Filename:  filename,
				Size:      1234,
				StartedAt: startedAt.UnixNano(),
				EndedAt:   startedAt.Add(time.Minute).UnixNano(),
			}}
		}
	}
}

func person(identity string, tracks ...*lksdk.TrackInfo) *lksdk.ParticipantInfo {
	return &lksdk.ParticipantInfo{
		Identity: identity, Kind: lksdk.ParticipantInfo_STANDARD, Tracks: tracks,
	}
}

func track(sid string, source lksdk.TrackSource, muted bool) *lksdk.TrackInfo {
	return &lksdk.TrackInfo{Sid: sid, Source: source, Muted: muted}
}

// ─── La base de usar y tirar ─────────────────────────────────────────────────

func recordingDB(t *testing.T) *gorm.DB {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))),
		&gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Skipf("no database reachable: %v", err)
	}
	name := fmt.Sprintf("cac_test_rec_%d", time.Now().UnixNano()%1_000_000)
	admin.Exec("DROP DATABASE IF EXISTS " + name)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Skipf("cannot create a throwaway database: %v", err)
	}
	adminSQL, _ := admin.DB()
	t.Cleanup(func() {
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		adminSQL.Close()
	})

	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
	})
	if err := db.AutoMigrate(&domain.Recording{}, &domain.RecordingTrack{}, &domain.User{}); err != nil {
		t.Fatal(err)
	}
	// El mismo índice parcial que pone `db.go`. Sin él, «ya se está grabando»
	// dejaría de ser una garantía de la base y pasaría a ser una carrera.
	if err := db.Exec(`CREATE UNIQUE INDEX idx_recording_active_per_space
		ON recordings (space_id) WHERE status = 'recording'`).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func newServiceUnderTest(t *testing.T, sfu *fakeSFU) (*RecordingService, *repository.RecordingRepository) {
	t.Helper()
	repo := repository.NewRecordingRepository(recordingDB(t))
	return NewRecordingService(repo, sfu, nil, "recordings", true, true, 240), repo
}

// ─── Los guardianes ──────────────────────────────────────────────────────────

// Las cámaras no se graban. Nunca.
//
// El mutante que mata: quitar el filtro de `discover`. Se vería en la factura y
// en la cara de quien sale en el vídeo, y no antes: la grabación seguiría
// funcionando.
func TestTheClockNeverRecordsCameras(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1",
			track("TR_cam", lksdk.TrackSource_CAMERA, false),
			track("TR_mic", lksdk.TrackSource_MICROPHONE, false),
			track("TR_scr", lksdk.TrackSource_SCREEN_SHARE, false),
		),
	}}
	svc, _ := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(sfu.started) != 2 {
		t.Fatalf("se arrancaron %d egress: %v", len(sfu.started), sfu.started)
	}
	for _, sid := range sfu.started {
		if sid == "TR_cam" {
			t.Fatal("la cámara se ha grabado, y ésa es la decisión de producto que no se toca")
		}
	}
	_ = rec
}

// Una pista, un egress — aunque el reloj pase mil veces.
//
// Sin esto, cada tick arrancaría otro egress sobre la misma pista: el fichero
// se sobrescribiría, la factura se multiplicaría por el número de ticks y nada
// daría error. El mutante que mata: ignorar lo que devuelve `ClaimTrack`.
func TestOneEgressPerTrackSid(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		svc.Tick(context.Background(), time.Now().UTC().Add(time.Duration(i+1)*time.Second))
	}
	if len(sfu.started) != 1 {
		t.Fatalf("%d egress para una sola pista: %v", len(sfu.started), sfu.started)
	}
	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 1 {
		t.Fatalf("%d filas para una sola pista", len(tracks))
	}
}

// Una pista muteada se graba igual.
//
// Saltarla obligaría a detectar el unmute, y hasta el siguiente tick se
// perderían los primeros segundos de quien vuelve a hablar — que es justo
// cuando dice lo que venía a decir. El fichero de una pista muda no pesa: sin
// paquetes no hay nada que escribir.
func TestMutedTracksAreRecordedToo(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, true)),
	}}
	svc, _ := newServiceUnderTest(t, sfu)

	if _, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1"); err != nil {
		t.Fatal(err)
	}
	if len(sfu.started) != 1 {
		t.Fatalf("un micro muteado también se graba: %v", sfu.started)
	}
}

// El grabador no cuenta como persona.
//
// LiveKit mete su propio participante en la sala para grabar. Si contara, una
// sala en la que ya no queda nadie parecería ocupada y **la grabación no
// pararía nunca**: horas de silencio, y la factura detrás.
func TestTheRecorderIsNotCountedAsAPerson(t *testing.T) {
	grabador := &lksdk.ParticipantInfo{Identity: "EG_x", Kind: lksdk.ParticipantInfo_EGRESS}
	if humans([]*lksdk.ParticipantInfo{grabador}) != 0 {
		t.Fatal("una sala con sólo el grabador está vacía")
	}
	if humans([]*lksdk.ParticipantInfo{grabador, person("u-1")}) != 1 {
		t.Fatal("y con una persona dentro, hay una")
	}
}

// La sala vacía para la grabación **al segundo tick**, no al primero.
//
// Uno solo cortaría la reunión de quien se reconecta: entre que el navegador
// pierde el socket y vuelve pasan segundos, y en ese hueco la sala parece
// vacía. Dos son unos veinte segundos, que caben dentro de una reconexión y
// muy por debajo del `empty_timeout` de cinco minutos del SFU — esperar a ése
// serían cinco minutos de silencio grabado.
func TestAnEmptyRoomStopsOnTheSecondTick(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}

	sfu.people = nil // todos fuera
	svc.Tick(context.Background(), time.Now().UTC().Add(10*time.Second))

	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != domain.RecordingActive {
		t.Fatalf("al primer tick vacío todavía graba, no %q", after.Status)
	}

	svc.Tick(context.Background(), time.Now().UTC().Add(20*time.Second))
	after, err = repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != domain.RecordingFinalizing {
		t.Fatalf("al segundo tick vacío se para, no %q", after.Status)
	}
}

// `ENDING` no es terminal, y confundirlo rompe el montaje.
//
// Mientras Egress está cerrando el fichero, el multipart de S3 puede estar a
// medias. Dar la grabación por cerrada ahí pondría al mux a montar un fichero
// incompleto — y el resultado no daría error: daría un vídeo cortado.
func TestEgressDoneWaitsForEveryTrack(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1",
			track("TR_mic", lksdk.TrackSource_MICROPHONE, false),
			track("TR_scr", lksdk.TrackSource_SCREEN_SHARE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}

	ahora := time.Now().UTC()
	sfu.finish("TR_mic", lksdk.EgressStatus_EGRESS_COMPLETE, "recordings/o/s/r/mic.ogg", ahora)
	sfu.finish("TR_scr", lksdk.EgressStatus_EGRESS_ENDING, "", ahora)
	svc.Tick(context.Background(), ahora.Add(10*time.Second))

	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.EgressDoneAt != nil {
		t.Fatal("con una pista todavía cerrándose, el mux no puede empezar")
	}

	sfu.finish("TR_scr", lksdk.EgressStatus_EGRESS_COMPLETE, "recordings/o/s/r/scr.webm", ahora)
	svc.Tick(context.Background(), ahora.Add(20*time.Second))
	after, err = repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.EgressDoneAt == nil {
		t.Fatal("con todas cerradas, el mux ya puede montar")
	}
}

// La clave que se guarda es la que Egress **escribió**, no la que se pidió.
//
// Medido en la fase 0: `ListParticipants` puede no traer el `mimeType`, así que
// se pide `…-TR_xxx` a secas y Egress escribe `…-TR_xxx.ogg`. Guardar la
// pedida deja al mux buscando un objeto que no existe — y el fallo aparece
// minutos después de colgar, lejos de aquí.
func TestTheObjectKeyIsTheOneEgressWrote(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	ahora := time.Now().UTC().Truncate(time.Millisecond)
	escrita := "recordings/org-1/esp-1/" + rec.ID + "/microphone-u-1-TR_mic.ogg"
	sfu.finish("TR_mic", lksdk.EgressStatus_EGRESS_COMPLETE, escrita, ahora)
	svc.Tick(context.Background(), ahora.Add(10*time.Second))

	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 1 {
		t.Fatalf("%d pistas", len(tracks))
	}
	if tracks[0].ObjectKey != escrita {
		t.Fatalf("la clave guardada es %q y Egress escribió %q", tracks[0].ObjectKey, escrita)
	}
	// Y el ancla, que es de lo que vive el montaje. Sin ella el mux no sabe
	// cuánto desplazar cada pista y las voces se pisan.
	if tracks[0].StartedAt == nil || !tracks[0].StartedAt.Equal(ahora) {
		t.Fatalf("el ancla no se guardó: %v", tracks[0].StartedAt)
	}

	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.FirstMediaAt == nil || !after.FirstMediaAt.Equal(ahora) {
		t.Fatalf("el cero de la línea de tiempo no se guardó: %v", after.FirstMediaAt)
	}
}

// Parar apaga el chip REC de todo el mundo, incluido quien entre después.
//
// El metadata de la sala es lo que ve quien se conecta tarde. Olvidarlo deja
// una sala marcada como «se está grabando» para siempre: nadie lo nota hasta
// que alguien entra a hablar y ve el punto rojo de una grabación que terminó.
func TestStoppingClearsTheRoomMetadata(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, _ := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(sfu.metadata) == 0 || sfu.metadata[len(sfu.metadata)-1] == "{}" {
		t.Fatalf("al empezar hay que marcar la sala: %v", sfu.metadata)
	}
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}
	if sfu.metadata[len(sfu.metadata)-1] != "{}" {
		t.Fatalf("al parar hay que limpiarla: %v", sfu.metadata)
	}
	if len(sfu.stopped) != 1 {
		t.Fatalf("hay que parar el egress de cada pista viva: %v", sfu.stopped)
	}
}

// Grabar una sala vacía guardaría silencio y encendería el chip para nadie.
func TestStartRefusesAnEmptyRoom(t *testing.T) {
	svc, _ := newServiceUnderTest(t, &fakeSFU{})
	if _, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1"); err != ErrRoomEmpty {
		t.Fatalf("%v", err)
	}
}

// Dos personas pulsando «grabar» a la vez son dos INSERT en vuelo.
//
// Lo decide el índice parcial de la base, no una lectura previa: entre leer y
// escribir cabe la otra petición. El mutante que mata: borrar el índice.
func TestOnlyOneRecordingPerSpaceAtATime(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, _ := newServiceUnderTest(t, sfu)

	if _, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Start(context.Background(), "org-1", "esp-1", "u-2")
	if err != repository.ErrAlreadyRecording {
		t.Fatalf("la segunda tiene que chocar, y dijo: %v", err)
	}
}
