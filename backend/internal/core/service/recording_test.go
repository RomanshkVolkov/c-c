package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"

	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
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
	// workerDead: el pod de Egress se murió. Lo que hace LiveKit entonces —y
	// esto está medido, no supuesto— es **nada**: el registro se queda en
	// `EGRESS_ACTIVE` con `ended_at: 0`, `updated_at` no se mueve (tampoco se
	// movía estando sano) y el participante del egress **sigue en la sala**.
	// Sólo `StopEgress` lo delata.
	workerDead bool
	// timeoutOnce: un solo tiempo de espera agotado y después todo bien. Es el
	// hipo de red que **no** tiene que matar una pista.
	timeoutOnce bool
	// stopSaysFinished: `StopEgress` contesta «ya terminó» mientras
	// `ListEgress` todavía lo da por vivo. No es un caso inventado: son dos
	// llamadas distintas, y la lista puede ir un paso por detrás.
	stopSaysFinished bool
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
	// **Cada egress entra a la sala como un participante más, con su propio id
	// por identidad.** Medido contra un LiveKit de verdad, y no es un detalle
	// decorativo: es la única prueba de vida que hay, porque el estado del
	// egress se queda en `ACTIVE` para siempre si el pod muere.
	f.people = append(f.people, &lksdk.ParticipantInfo{
		Identity: info.EgressId, Kind: lksdk.ParticipantInfo_EGRESS,
	})
	_ = key
	return info, nil
}

// leave saca de la sala al participante de un egress, como hace el de verdad
// al terminar —o al morirse.
func (f *fakeSFU) leave(egressID string) {
	out := f.people[:0]
	for _, p := range f.people {
		if p.Identity != egressID {
			out = append(out, p)
		}
	}
	f.people = out
}

// killWorker mata el pod. **Nada visible cambia**, que es justo el problema:
// el registro sigue `EGRESS_ACTIVE` y el participante sigue en la sala. Lo
// único que cambia es que ya no hay nadie que conteste a `StopEgress`.
func (f *fakeSFU) killWorker() { f.workerDead = true }

func (f *fakeSFU) StopEgress(_ context.Context, _, id string) (*lksdk.EgressInfo, error) {
	f.stopped = append(f.stopped, id)
	// Las tres respuestas que da el SFU de verdad, medidas:
	//
	//	cerrando           → 200 OK
	//	ya terminado       → 412 failed_precondition
	//	nadie al otro lado → 408 deadline_exceeded
	//
	// Las tres importan: contar el 412 como muerte tiraría pistas buenas.
	if f.workerDead || f.timeoutOnce {
		f.timeoutOnce = false
		return nil, twirp.NewError(twirp.DeadlineExceeded, "request timed out")
	}
	if f.stopSaysFinished {
		return nil, twirp.NewError(twirp.FailedPrecondition,
			"egress with status EGRESS_COMPLETE cannot be stopped")
	}
	for _, e := range f.egress {
		if e.EgressId == id && e.Status == lksdk.EgressStatus_EGRESS_COMPLETE {
			return nil, twirp.NewError(twirp.FailedPrecondition,
				"egress with status EGRESS_COMPLETE cannot be stopped")
		}
	}
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
		// Un egress que acaba sale de la sala **ya terminal**: medido, la
		// ventana entre las dos cosas es de 0 s.
		if status == lksdk.EgressStatus_EGRESS_COMPLETE ||
			status == lksdk.EgressStatus_EGRESS_FAILED ||
			status == lksdk.EgressStatus_EGRESS_ABORTED {
			f.leave(e.EgressId)
		}
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
	// Un almacén "encendido" de mentira: estas pruebas no leen ni escriben en
	// S3 —quien escribe es Egress, quien monta es el mux—, sólo necesitan que
	// `Enabled()` diga que sí.
	store := mediastore.Fake()
	return NewRecordingService(repo, sfu, nil, store, "recordings", true, 240), repo
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

// El pod de Egress se muere y la grabación **no** se queda colgada.
//
// Esto no salió de ningún doble: salió de matar el pod de verdad y ver las
// pistas en `active` durante dos minutos y medio sin que nada se enterara.
//
// Lo que hace LiveKit al morir un trabajador es **nada visible**: el registro
// se queda en `EGRESS_ACTIVE` con `ended_at: 0` para siempre, `updated_at` no
// late —no lo hace ni estando sano—, y el participante del egress sigue
// sentado en la sala. Las tres se midieron, y las tres fallan como prueba de
// vida. La única que funciona es preguntar: `StopEgress` contesta un tiempo de
// espera agotado cuando nadie posee ese egress.
//
// Y por eso se pregunta **sólo al cerrar**: preguntarlo durante la grabación
// sería pararla.
//
// El mutante que mata: no contar el fallo de `StopEgress`.
func TestADeadEgressWorkerDoesNotHangTheRecording(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	sfu.killWorker()
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}

	base := time.Now().UTC()
	for i := 1; i <= 4; i++ {
		svc.Tick(context.Background(), base.Add(time.Duration(i*15)*time.Second))
	}
	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tracks[0].Status != domain.TrackFailed {
		t.Fatalf("la pista sigue en %q: la grabación se queda colgada y el mux no la ve nunca",
			tracks[0].Status)
	}
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Y la grabación cierra: sin una sola pista buena, `failed` con su motivo,
	// que es mejor que `finalizing` para siempre.
	if after.Status != domain.RecordingFailed {
		t.Fatalf("la grabación quedó en %q", after.Status)
	}
}

// Y no se lleva por delante a uno que está vivo.
//
// El riesgo del arreglo es el contrario: dar por muerta una pista que sólo
// tardaba en subir su fichero. De ahí los veinte segundos de gracia antes de
// empezar a preguntar y las dos respuestas malas seguidas.
func TestALiveEgressWorkerIsNotKilledByTheProbe(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC()
	for i := 1; i <= 5; i++ {
		svc.Tick(context.Background(), base.Add(time.Duration(i*10)*time.Second))
	}
	tracks, _ := repo.Tracks(rec.ID)
	if tracks[0].Status != domain.TrackActive {
		t.Fatalf("una pista viva acabó en %q: %s", tracks[0].Status, tracks[0].Error)
	}

	// Y al cerrar bien tampoco: el egress contesta y acaba en COMPLETE.
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}
	sfu.finish("TR_mic", lksdk.EgressStatus_EGRESS_COMPLETE, "recordings/o/s/r/mic.ogg", base)
	svc.Tick(context.Background(), base.Add(120*time.Second))
	tracks, _ = repo.Tracks(rec.ID)
	if tracks[0].Status != domain.TrackComplete {
		t.Fatalf("un cierre normal acabó en %q: %s", tracks[0].Status, tracks[0].Error)
	}
}

// Y no se pregunta antes de tiempo.
//
// Durante la grabación, preguntar **es** parar: `StopEgress` es la señal y el
// arma a la vez. Un sondeo mientras se graba cortaría la grabación que venía a
// vigilar.
func TestTheProbeNeverRunsWhileStillRecording(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, _ := newServiceUnderTest(t, sfu)

	if _, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1"); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC()
	for i := 1; i <= 6; i++ {
		svc.Tick(context.Background(), base.Add(time.Duration(i*30)*time.Second))
	}
	if len(sfu.stopped) != 0 {
		t.Fatalf("se pidió parar %d egress mientras la grabación seguía viva: %v",
			len(sfu.stopped), sfu.stopped)
	}
}

// «Ya está terminado» no es «se murió».
//
// Medido contra el SFU: volver a pedir que pare un egress que ya acabó
// contesta **412 `failed_precondition`**, no el 408 del trabajador muerto.
// Contar cualquier error como muerte tiraría pistas buenas — y las tiraría
// justo en el caso más normal, el de una grabación que terminó bien.
func TestAnAlreadyFinishedEgressIsNotMistakenForADeadOne(t *testing.T) {
	if nobodyAnswered(twirp.NewError(twirp.FailedPrecondition,
		"egress with status EGRESS_COMPLETE cannot be stopped")) {
		t.Fatal("un 412 dice que LiveKit sí sabe de ese egress")
	}
	if nobodyAnswered(errors.New("la red se cayó")) {
		t.Fatal("un error sin código no dice nada de quién hay al otro lado")
	}
	if !nobodyAnswered(twirp.NewError(twirp.DeadlineExceeded, "request timed out")) {
		t.Fatal("el tiempo de espera agotado es la señal, y es la única")
	}
}

// Un hipo no mata una pista.
//
// Es la otra cara del arreglo: el 408 también sale cuando el SFU tiene un mal
// momento. Con un solo fallo bastando, un tropiezo de red convertiría en
// `failed` una pista cuyo fichero estaba subiendo bien.
func TestOneTransientTimeoutDoesNotKillATrack(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC()

	sfu.timeoutOnce = true // un solo tropiezo
	svc.Tick(context.Background(), base.Add(15*time.Second))
	svc.Tick(context.Background(), base.Add(30*time.Second))
	svc.Tick(context.Background(), base.Add(45*time.Second))

	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tracks[0].Status == domain.TrackFailed {
		t.Fatalf("un solo tiempo de espera agotado mató la pista: %s", tracks[0].Error)
	}
}

// La carrera entre las dos llamadas no puede matar una pista buena.
//
// `ListEgress` y `StopEgress` son dos preguntas distintas, y la lista puede ir
// un paso por detrás: se puede dar el caso de que la lista todavía diga
// «activo» y el `StopEgress` conteste **412 «ya terminó»**. Es buena noticia —
// el fichero está escrito—, y contarla como muerte convertiría en `failed` una
// grabación que salió bien.
//
// El mutante que mata: contar cualquier error del sondeo en vez de sólo el
// tiempo de espera agotado.
func TestAStaleListingDoesNotKillAFinishedTrack(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)

	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}
	// La lista sigue diciendo «activo»; el que para dice «ya terminó».
	sfu.stopSaysFinished = true
	base := time.Now().UTC()
	for i := 1; i <= 4; i++ {
		svc.Tick(context.Background(), base.Add(time.Duration(i*15)*time.Second))
	}
	tracks, err := repo.Tracks(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tracks[0].Status == domain.TrackFailed {
		t.Fatalf("una pista terminada se dio por muerta: %s", tracks[0].Error)
	}
}

// ─── El reparto del mux ──────────────────────────────────────────────────────

// leaveReadyToMux deja una grabación cerrada y lista para el montador.
func leaveReadyToMux(t *testing.T, svc *RecordingService, repo *repository.RecordingRepository,
	sfu *fakeSFU) *domain.Recording {
	t.Helper()
	rec, err := svc.Start(context.Background(), "org-1", "esp-1", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Stop(context.Background(), rec, "test"); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC()
	sfu.finish("TR_mic", lksdk.EgressStatus_EGRESS_COMPLETE, "recordings/o/s/r/mic.ogg", base)
	svc.Tick(context.Background(), base.Add(10*time.Second))
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.EgressDoneAt == nil {
		t.Fatalf("no quedó lista para montar: %q", after.Status)
	}
	return after
}

func serviceWithOneTrack(t *testing.T) (*RecordingService, *repository.RecordingRepository, *fakeSFU) {
	t.Helper()
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, repo := newServiceUnderTest(t, sfu)
	return svc, repo, sfu
}

// Dos montadores no montan la misma grabación.
//
// El reparto es una columna de la base y no una cola, así que lo decide un
// `UPDATE` condicional. Sin él, dos pasadas simultáneas subirían dos veces el
// mismo fichero y la segunda pisaría a la primera a mitad de subida.
func TestOnlyOneMuxClaimsARecording(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	ahora := time.Now().UTC()

	primero, err := svc.ClaimMux(rec.ID, ahora)
	if err != nil || !primero {
		t.Fatalf("el primero se la queda: %v %v", primero, err)
	}
	segundo, err := svc.ClaimMux(rec.ID, ahora.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if segundo {
		t.Fatal("el segundo montador se llevó la misma grabación")
	}
}

// Y si el montador se muere, el plazo vence y otro la recoge.
//
// Es lo que evita que una grabación se quede sin montar para siempre porque el
// pod que la tenía reservada se cayó. El mutante que mata: reservarla sin
// plazo, o no mirar si el anterior venció.
func TestAnExpiredMuxLeaseIsTakenAgain(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	ahora := time.Now().UTC()

	if ok, err := svc.ClaimMux(rec.ID, ahora); err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	// Quince minutos y un segundo después, el que se murió ya no la tiene.
	despues := ahora.Add(muxLease + time.Second)
	if ok, err := svc.ClaimMux(rec.ID, despues); err != nil || !ok {
		t.Fatalf("un plazo vencido tiene que poder recogerse: %v %v", ok, err)
	}
}

// Lo que el montador ve: las pistas con fichero, y cuántas se perdieron.
//
// Una pista fallida no se monta —no hay nada que montar— pero **sí cuenta**:
// es lo que convierte el resultado en `partial`, y quien lo mire tiene derecho
// a saber que falta alguien.
func TestTheMuxOnlySeesTracksWithAFile(t *testing.T) {
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
	base := time.Now().UTC()
	sfu.finish("TR_mic", lksdk.EgressStatus_EGRESS_COMPLETE, "recordings/o/s/r/mic.ogg", base)
	sfu.finish("TR_scr", lksdk.EgressStatus_EGRESS_FAILED, "", base)
	svc.Tick(context.Background(), base.Add(10*time.Second))

	jobs, err := svc.PendingMux(base.Add(20*time.Second), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("%d trabajos pendientes", len(jobs))
	}
	if len(jobs[0].Tracks) != 1 {
		t.Fatalf("sólo se monta lo que tiene fichero: %d", len(jobs[0].Tracks))
	}
	if jobs[0].FailedTracks != 1 {
		t.Fatalf("la pista perdida tiene que contarse: %d", jobs[0].FailedTracks)
	}

	// Y al cerrar, `partial` y no `ready`: hay vídeo, pero falta gente.
	if err := svc.MuxReady(rec.ID, "recordings/o/s/r/final.mp4", "video/mp4", 100, 1000, true); err != nil {
		t.Fatal(err)
	}
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != domain.RecordingPartial {
		t.Fatalf("con una pista perdida es %q, no %q", domain.RecordingPartial, after.Status)
	}
}

// Sin pistas perdidas, `ready` a secas.
func TestAWholeRecordingBecomesReady(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	if err := svc.MuxReady(rec.ID, "recordings/o/s/r/final.m4a", "audio/mp4", 100, 1000, false); err != nil {
		t.Fatal(err)
	}
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != domain.RecordingReady {
		t.Fatalf("%q", after.Status)
	}
	if after.FinalContentType != "audio/mp4" || after.HasScreen {
		t.Fatalf("una llamada sin pantalla se sirve como audio: %+v", after)
	}
}

// Una grabación reservada no vuelve a salir en la lista de pendientes.
//
// Sin esto, el propio montador que la está montando se la encontraría otra vez
// en la siguiente vuelta —quince segundos después— y empezaría a montarla en
// paralelo consigo mismo. Cuando el plazo vence sí vuelve, que es lo que la
// rescata si el pod se murió.
//
// El mutante que mata: quitar el filtro del plazo de la consulta.
func TestPendingMuxHidesWhatIsAlreadyClaimed(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	ahora := time.Now().UTC()

	if jobs, err := svc.PendingMux(ahora, 10); err != nil || len(jobs) != 1 {
		t.Fatalf("antes de reservarla tiene que salir: %d %v", len(jobs), err)
	}
	if ok, err := svc.ClaimMux(rec.ID, ahora); err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	if jobs, err := svc.PendingMux(ahora.Add(time.Minute), 10); err != nil || len(jobs) != 0 {
		t.Fatalf("reservada, no sale: %d %v", len(jobs), err)
	}
	// Y cuando el plazo vence, vuelve: es lo que rescata la grabación de un
	// montador que se murió con ella en la mano.
	if jobs, err := svc.PendingMux(ahora.Add(muxLease+time.Second), 10); err != nil || len(jobs) != 1 {
		t.Fatalf("con el plazo vencido vuelve: %d %v", len(jobs), err)
	}
}

// Dos réplicas que leyeron lo mismo: sólo una escribe.
//
// Es la carrera que el `UPDATE` condicional del repositorio existe para
// perder. El servicio comprueba antes si está reservada, pero entre esa lectura
// y la escritura cabe la otra réplica — comprobar en Go no vale de nada si la
// escritura no lleva la condición encima.
//
// El mutante que mata: quitar el `WHERE mux_lease_until = ?` de `LeaseMux`.
func TestTwoReplicasThatReadTheSameLeaseOnlyOneWrites(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	ahora := time.Now().UTC()

	// Las dos leen «sin reservar» a la vez.
	visto := rec.MuxLeaseUntil // nil
	primera, err := repo.LeaseMux(rec.ID, visto, ahora.Add(muxLease))
	if err != nil || !primera {
		t.Fatalf("la primera escribe: %v %v", primera, err)
	}
	segunda, err := repo.LeaseMux(rec.ID, visto, ahora.Add(muxLease))
	if err != nil {
		t.Fatal(err)
	}
	if segunda {
		t.Fatal("la segunda escribió sobre la reserva de la primera")
	}
}

// ─── Contarlo en el canal ────────────────────────────────────────────────────

// spyAnnouncer cuenta cuántas líneas se pusieron, y con qué.
type spyAnnouncer struct {
	bodies  []string
	notices []string
	fails   error
	// Las referencias que se pidió retirar, y de qué canal.
	retracted []string
	retractIn []string
}

func (a *spyAnnouncer) PostSystem(spaceID, orgID, actorID, body, notice string) (*domain.ChatMessage, error) {
	if a.fails != nil {
		return nil, a.fails
	}
	a.bodies = append(a.bodies, body)
	a.notices = append(a.notices, notice)
	return &domain.ChatMessage{}, nil
}

func (a *spyAnnouncer) RetractSystem(spaceID, ref string) error {
	if a.fails != nil {
		return a.fails
	}
	a.retractIn = append(a.retractIn, spaceID)
	a.retracted = append(a.retracted, ref)
	return nil
}

// Se anuncia exactamente una vez.
//
// Una grabación lista se cuenta en el canal, y **sólo se cuenta una vez**: dos
// mux montando la misma, o el mismo reintentando tras un tiempo de espera, son
// dos llamadas a `MuxReady` para un mismo hecho. Quien lo garantiza no es este
// código sino el `UPDATE` condicional de `Transition`, que ya es
// exactamente-una-vez; el anuncio lo hereda **por estar detrás de él**.
//
// Los mutantes que matan: anunciar antes de `Transition`, o ignorar su `ok`.
// Los dos dejan la grabación exactamente igual de bien montada y el canal con
// una línea por intento.
func TestItIsAnnouncedExactlyOnce(t *testing.T) {
	svc, repo, sfu := serviceWithOneTrack(t)
	spy := &spyAnnouncer{}
	svc.WithAnnouncer(spy)
	rec := leaveReadyToMux(t, svc, repo, sfu)

	for i := 0; i < 3; i++ {
		if err := svc.MuxReady(rec.ID, "recordings/o/s/r/final.m4a", "audio/mp4", 100, 754_000, false); err != nil {
			t.Fatal(err)
		}
	}
	if len(spy.bodies) != 1 {
		t.Fatalf("tres montajes del mismo hecho, una sola línea en el canal; hubo %d: %+v",
			len(spy.bodies), spy.bodies)
	}
	// Y apunta a la grabación con el esquema de dentro, que es lo que hace que
	// el enlace abra la pestaña en vez de sacar a nadie al navegador.
	if !strings.Contains(spy.bodies[0], domain.RecordingRef(rec.ID)) {
		t.Errorf("la línea apunta a la grabación: %q", spy.bodies[0])
	}
	// El aviso de la bandeja va aparte y sin markdown: ahí nadie lo pinta.
	if strings.Contains(spy.notices[0], "](") {
		t.Errorf("el aviso es una frase plana: %q", spy.notices[0])
	}
}

// Y si el canal falla, la grabación sigue montada.
//
// El anuncio es lo último y su fallo no se propaga: devolvérselo al mux le haría
// volver a montar un fichero ya montado para arreglar un mensaje de chat.
func TestAFailedAnnouncementDoesNotSinkTheRecording(t *testing.T) {
	svc, repo, sfu := serviceWithOneTrack(t)
	svc.WithAnnouncer(&spyAnnouncer{fails: errors.New("el canal no está")})
	rec := leaveReadyToMux(t, svc, repo, sfu)

	if err := svc.MuxReady(rec.ID, "recordings/o/s/r/final.m4a", "audio/mp4", 100, 1000, false); err != nil {
		t.Fatalf("el montaje es lo que importa, y salió bien: %v", err)
	}
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != domain.RecordingReady {
		t.Errorf("la grabación queda lista aunque nadie se entere: %q", after.Status)
	}
}

// ─── Borrar se lleva el aviso ────────────────────────────────────────────────

// countingStore apunta qué claves se borraron.
//
// El `mediastore.Fake()` del resto de las pruebas revienta ante cualquier uso
// real —a propósito, para que nadie lo use sin querer—, y borrar sí toca el
// bucket de verdad.
type countingStore struct{ deleted []string }

func (s *countingStore) Enabled() bool { return true }

func (s *countingStore) GetRange(context.Context, string, string) (*mediastore.Object, error) {
	return nil, mediastore.ErrDisabled
}

func (s *countingStore) Delete(_ context.Context, keys ...string) error {
	s.deleted = append(s.deleted, keys...)
	return nil
}

// serviceThatCanDelete: como `serviceWithOneTrack`, con un bucket que borra.
func serviceThatCanDelete(t *testing.T) (*RecordingService, *repository.RecordingRepository, *fakeSFU, *countingStore) {
	t.Helper()
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	repo := repository.NewRecordingRepository(recordingDB(t))
	store := &countingStore{}
	return NewRecordingService(repo, sfu, nil, store, "recordings", true, 240), repo, sfu, store
}

// Borrar una grabación retira su aviso del canal.
//
// Quien borra lo hace porque no debería existir. Dejar en el hilo «la grabación
// de esta llamada está lista», con el nombre de quien la hizo y un enlace a un
// fichero que ya no está, deshace medio borrado y deja algo sobre lo que nadie
// puede actuar.
//
// El mutante que mata: no llamar a `RetractSystem`. Nada falla — simplemente el
// mensaje se queda ahí para siempre, que es justo lo que se reportó.
func TestDeletingARecordingRetractsItsNotice(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	spy := &spyAnnouncer{}
	svc.WithAnnouncer(spy)

	if err := svc.Delete(context.Background(), rec); err != nil {
		t.Fatal(err)
	}

	if len(spy.retracted) != 1 {
		t.Fatalf("se pidió retirar %d avisos", len(spy.retracted))
	}
	// Por la referencia, que es lo que identifica al aviso dentro del cuerpo.
	if spy.retracted[0] != domain.RecordingRef(rec.ID) {
		t.Fatalf("se retiró %q", spy.retracted[0])
	}
	// Y en el canal de esa grabación, no en otro.
	if spy.retractIn[0] != rec.SpaceID {
		t.Fatalf("se retiró en %q", spy.retractIn[0])
	}
}

// Y si retirar el aviso falla, **la grabación sigue borrada**.
//
// El material ya no existe cuando llega este paso: negarse aquí dejaría una
// grabación a medio borrar —fila en la base, ficheros fuera— por un mensaje de
// chat. El error va al log y ya.
//
// El mutante que mata: devolver el error de `RetractSystem`.
func TestAFailedRetractionDoesNotUndoTheDeletion(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	svc.WithAnnouncer(&spyAnnouncer{fails: errors.New("el chat dijo que no")})

	if err := svc.Delete(context.Background(), rec); err != nil {
		t.Fatalf("borrar no puede fallar por el aviso: %v", err)
	}
	if _, err := repo.FindByID(rec.ID); err == nil {
		t.Fatal("la grabación tenía que estar borrada")
	}
}

// Sin anunciador configurado, borrar sigue funcionando.
func TestDeletingWorksWithoutAnAnnouncer(t *testing.T) {
	svc, repo, sfu, _ := serviceThatCanDelete(t)
	rec := leaveReadyToMux(t, svc, repo, sfu)
	if err := svc.Delete(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.FindByID(rec.ID); err == nil {
		t.Fatal("la grabación tenía que estar borrada")
	}
}
