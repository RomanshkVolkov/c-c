package handler

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	lkclient "github.com/guz-studio/cac/backend/internal/adapters/livekit"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// recordingLiveDB: una base de usar y tirar con las tablas de grabación y su
// índice parcial, el mismo que pone `db.go`.
func recordingLiveDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, cleanup := voiceDB(t)
	t.Cleanup(cleanup)
	if err := db.AutoMigrate(&domain.Recording{}, &domain.RecordingTrack{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_active_per_space
		ON recordings (space_id) WHERE status = 'recording'`).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

// La cadena de la fase 2, entera: grabar, cerrar, montar y quedar `ready`.
//
// Levanta el listener interno de verdad sobre una base de usar y tirar, y
// lanza **el montador de verdad** —`python -m transcriber.mux`, con su ffmpeg y
// su boto3— contra él. Lo único que no es producción es que corre aquí en vez
// de en un pod.
//
//	RECORDINGS_LIVE_ROOM=voice:… RECORDINGS_LIVE_MUX=1 \
//	AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… RECORDINGS_BUCKET=… \
//	  go test ./internal/core/service/ -run LiveMux -v -timeout 12m
func TestLiveMuxClosesARecording(t *testing.T) {
	room := os.Getenv("RECORDINGS_LIVE_ROOM")
	if room == "" || os.Getenv("RECORDINGS_LIVE_MUX") == "" {
		t.Skip("no live mux run: set RECORDINGS_LIVE_ROOM and RECORDINGS_LIVE_MUX")
	}
	lk := lkclient.New(os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"),
		os.Getenv("LIVEKIT_API_SECRET"))
	if lk == nil {
		t.Skip("no livekit keys in the environment")
	}
	ctx := context.Background()

	store, err := mediastore.New(ctx, os.Getenv("RECORDINGS_BUCKET"),
		os.Getenv("AWS_DEFAULT_REGION"), os.Getenv("AWS_ACCESS_KEY_ID"),
		os.Getenv("AWS_SECRET_ACCESS_KEY"))
	if err != nil || !store.Enabled() {
		t.Skipf("no bucket: %v", err)
	}
	repo := repository.NewRecordingRepository(recordingLiveDB(t))
	svc := service.NewRecordingService(repo, lk, nil, store,
		os.Getenv("RECORDINGS_PREFIX"), true, 240)

	// 1. Grabar un poco y cerrar.
	rec, err := svc.Start(ctx, "org-live", room[len("voice:"):], "u-live")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Logf("grabación %s", rec.ID)
	time.Sleep(25 * time.Second)
	svc.Tick(ctx, time.Now().UTC())
	if err := svc.Stop(ctx, rec, "live-mux-test"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	for i := 0; i < 15; i++ {
		time.Sleep(6 * time.Second)
		svc.Tick(ctx, time.Now().UTC())
		after, _ := repo.FindByID(rec.ID)
		if after.EgressDoneAt != nil || after.Status.Terminal() {
			break
		}
	}
	after, err := repo.FindByID(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.EgressDoneAt == nil {
		t.Fatalf("los egress no cerraron: %q %s", after.Status, after.Error)
	}

	// 2. El listener interno, el de verdad.
	const key = "una-llave-de-prueba-larga"
	h := NewRecordingInternalHandler(svc, key)
	r := chi.NewRouter()
	r.Route("/internal/v1/recordings", func(r chi.Router) {
		r.Use(MuxKeyMiddleware(key))
		r.Get("/pending-mux", h.Pending)
		r.Post("/{id}/claim", h.Claim)
		r.Post("/{id}/ready", h.Ready)
		r.Post("/{id}/failed", h.Failed)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 3. El montador de verdad, contra ese listener.
	work := t.TempDir()
	// `--extra mux`: `boto3` es opcional a propósito —el spike y el banco de
	// pruebas no lo quieren— y la imagen del montador se construye con ese
	// mismo extra.
	cmd := exec.CommandContext(ctx, "uv", "run", "--frozen", "--extra", "mux",
		"python", "-m", "transcriber.mux")
	cmd.Dir = "../../../../transcriber"
	cmd.Env = append(os.Environ(),
		"CAC_INTERNAL_URL="+srv.URL,
		"RECORDINGS_MUX_KEY="+key,
		"MUX_WORKDIR="+work,
	)
	var salida bytes.Buffer
	cmd.Stdout, cmd.Stderr = &salida, &salida
	if err := cmd.Start(); err != nil {
		t.Fatalf("no arrancó el montador: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		t.Logf("el montador dijo:\n%s", salida.String())
	}()

	// 4. Esperar a que la cierre.
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Second)
		after, err = repo.FindByID(rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if after.Status.Terminal() {
			break
		}
	}
	if after.Status != domain.RecordingReady && after.Status != domain.RecordingPartial {
		t.Fatalf("acabó en %q: %s", after.Status, after.Error)
	}
	t.Logf("montada: %s · %s · %d bytes · %d ms · pantalla=%v",
		after.Status, after.FinalKey, after.FinalBytes, after.DurationMs, after.HasScreen)
	if after.FinalKey == "" || after.FinalBytes == 0 || after.DurationMs == 0 {
		t.Fatal("el montaje no trae lo que la app necesita para enseñarlo")
	}

	// 5. Y el proxy sabe servir un trozo, que es la otra mitad de la fase 2.
	obj, err := svc.Media(ctx, after, "bytes=0-99")
	if err != nil {
		t.Fatalf("Media con rango: %v", err)
	}
	defer obj.Body.Close()
	if obj.ContentRange == "" {
		t.Fatal("sin Content-Range no hay 206, y sin 206 no se puede buscar en el vídeo")
	}
	t.Logf("rango: %s", obj.ContentRange)
}
