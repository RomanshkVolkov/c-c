package service

import (
	"context"
	"strings"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Las llamadas, guardadas: una por sala, las cierra el reloj y dejan un solo
// resumen en el canal, con la grabación dentro. Ver domain/call_session.go.
//
// Mutantes: abrir sin el índice parcial (dos sesiones); cerrar al primer tick
// vacío; resumir dos veces; resumir un clic por error; anunciar la grabación
// aparte de su llamada; reescribir el resumen sin la grabación.

type fakeSummarizer struct {
	posts   []string
	updates map[string]string
}

func (f *fakeSummarizer) PostSystem(_, _, _, body, _ string) (*domain.ChatMessage, error) {
	f.posts = append(f.posts, body)
	m := &domain.ChatMessage{Body: body}
	m.ID = "msg-" + string(rune('a'+len(f.posts)))
	return m, nil
}

func (f *fakeSummarizer) UpdateSystem(id, body string) error {
	if f.updates == nil {
		f.updates = map[string]string{}
	}
	f.updates[id] = body
	return nil
}

var callT0 = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func callsUnderTestDB(t *testing.T, sfu *fakeSFU) (*CallSessionService, *fakeSummarizer, *gorm.DB) {
	t.Helper()
	db := recordingDB(t)
	if err := db.AutoMigrate(&domain.CallSession{}, &domain.CallSessionParticipant{}); err != nil {
		t.Fatal(err)
	}
	sum := &fakeSummarizer{}
	svc := NewCallSessionService(repository.NewCallSessionRepository(db), repository.NewRecordingRepository(db), sfu).
		WithSummarizer(sum)
	svc.now = func() time.Time { return callT0 }
	return svc, sum, db
}

func inCall(identity, name string) *lksdk.ParticipantInfo {
	return &lksdk.ParticipantInfo{Identity: identity, Name: name, Kind: lksdk.ParticipantInfo_STANDARD}
}

func openSessions(t *testing.T, db *gorm.DB, room string) []domain.CallSession {
	t.Helper()
	var out []domain.CallSession
	if err := db.Where("room = ?", room).Find(&out).Error; err != nil {
		t.Fatal(err)
	}
	return out
}

func TestARoomHasOneOpenCall(t *testing.T) {
	svc, _, db := callsUnderTestDB(t, &fakeSFU{})
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-bea")
	if n := len(openSessions(t, db, "voice:esp-1")); n != 1 {
		t.Fatalf("dos entradas a la misma sala son una llamada, no %d", n)
	}
}

// El reloj, de punta a punta: gente dentro, un tick vacío que no cierra, otro
// que sí, y un solo resumen aunque el reloj siga.
func TestTheClockClosesAfterTwoEmptyTicksAndSummarizesOnce(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{inCall("u-ana", "Ana"), inCall("u-bea", "Bea")}}
	svc, sum, db := callsUnderTestDB(t, sfu)
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	ctx := context.Background()

	svc.Tick(ctx, callT0.Add(10*time.Minute))
	sfu.people = nil
	svc.Tick(ctx, callT0.Add(10*time.Minute+10*time.Second))
	if s := openSessions(t, db, "voice:esp-1")[0]; s.EndedAt != nil {
		t.Fatal("un tick vacío no cierra: una reconexión de diez segundos partiría la llamada")
	}
	svc.Tick(ctx, callT0.Add(10*time.Minute+20*time.Second))
	s := openSessions(t, db, "voice:esp-1")[0]
	if s.EndedAt == nil {
		t.Fatal("dos ticks vacíos cierran la llamada")
	}
	// El final es la última vez que hubo alguien, no el tick que cerró.
	if !s.EndedAt.Equal(callT0.Add(10 * time.Minute)) {
		t.Errorf("terminó a las %v; la última vez que hubo gente fue %v", s.EndedAt, callT0.Add(10*time.Minute))
	}
	svc.Tick(ctx, callT0.Add(11*time.Minute))
	if len(sum.posts) != 1 {
		t.Fatalf("un resumen por llamada, salieron %d", len(sum.posts))
	}
	if !strings.Contains(sum.posts[0], "10 min") || !strings.Contains(sum.posts[0], "2 people") ||
		!strings.Contains(sum.posts[0], domain.CallRef(s.ID)) {
		t.Errorf("el resumen dice cuánto, cuántos y enlaza la llamada: %q", sum.posts[0])
	}
}

func TestAMisclickLeavesNoSummary(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{inCall("u-ana", "Ana")}}
	svc, sum, _ := callsUnderTestDB(t, sfu)
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	ctx := context.Background()
	svc.Tick(ctx, callT0.Add(10*time.Second))
	sfu.people = nil
	svc.Tick(ctx, callT0.Add(20*time.Second))
	svc.Tick(ctx, callT0.Add(30*time.Second))
	if len(sum.posts) != 0 {
		t.Errorf("diez segundos sola no dejan línea en el canal: %v", sum.posts)
	}
}

func readyRecording(t *testing.T, db *gorm.DB, room string, startedAt time.Time) *domain.Recording {
	t.Helper()
	rec := &domain.Recording{OrgID: "org-1", SpaceID: "esp-1", Room: room, StartedBy: "u-ana",
		Status: domain.RecordingReady, StartedAt: startedAt, TickedAt: startedAt, DurationMs: 60_000}
	rec.ID = "11111111-aaaa-4aaa-8aaa-111111111111"
	if err := db.Create(rec).Error; err != nil {
		t.Fatal(err)
	}
	return rec
}

// La grabación que queda lista después de colgar reescribe el resumen y no
// pone otra línea.
func TestAReadyRecordingRewritesTheSummary(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{inCall("u-ana", "Ana"), inCall("u-bea", "Bea")}}
	svc, sum, db := callsUnderTestDB(t, sfu)
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	ctx := context.Background()
	svc.Tick(ctx, callT0.Add(5*time.Minute))
	sfu.people = nil
	svc.Tick(ctx, callT0.Add(5*time.Minute+10*time.Second))
	svc.Tick(ctx, callT0.Add(5*time.Minute+20*time.Second))
	if len(sum.posts) != 1 {
		t.Fatalf("el resumen tenía que estar: %v", sum.posts)
	}

	rec := readyRecording(t, db, "voice:esp-1", callT0.Add(time.Minute))
	if !svc.RecordingReady(rec) {
		t.Fatal("la grabación de una llamada resumida va en su resumen, no aparte")
	}
	if len(sum.posts) != 1 {
		t.Errorf("ni una línea más en el canal: %v", sum.posts)
	}
	var got string
	for _, b := range sum.updates {
		got = b
	}
	if !strings.Contains(got, domain.RecordingRef(rec.ID)) {
		t.Errorf("el resumen reescrito enlaza la grabación: %q", got)
	}
}

// Lista con la llamada todavía en marcha: sale en el resumen al terminar.
func TestARecordingDuringTheCallGoesInTheSummary(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{inCall("u-ana", "Ana"), inCall("u-bea", "Bea")}}
	svc, sum, db := callsUnderTestDB(t, sfu)
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	rec := readyRecording(t, db, "voice:esp-1", callT0.Add(time.Minute))
	if !svc.RecordingReady(rec) {
		t.Fatal("con la llamada abierta, la grabación espera a su resumen")
	}
	if len(sum.posts) != 0 {
		t.Fatalf("y no se anuncia sola: %v", sum.posts)
	}
	ctx := context.Background()
	svc.Tick(ctx, callT0.Add(5*time.Minute))
	sfu.people = nil
	svc.Tick(ctx, callT0.Add(5*time.Minute+10*time.Second))
	svc.Tick(ctx, callT0.Add(5*time.Minute+20*time.Second))
	if len(sum.posts) != 1 || !strings.Contains(sum.posts[0], domain.RecordingRef(rec.ID)) {
		t.Errorf("el resumen lleva la grabación: %v", sum.posts)
	}
}

// Sin llamada guardada —grabaciones de antes de esto—, la grabación se anuncia
// como siempre.
func TestWithoutACallTheRecordingAnnouncesItself(t *testing.T) {
	svc, _, db := callsUnderTestDB(t, &fakeSFU{})
	rec := readyRecording(t, db, "voice:esp-1", callT0)
	if svc.RecordingReady(rec) {
		t.Error("sin llamada no hay resumen donde meterla: tiene que anunciarse sola")
	}
}

func TestWhatIsWorthSummarizing(t *testing.T) {
	for _, c := range []struct {
		d        time.Duration
		people   int
		messages int
		want     bool
	}{
		{10 * time.Second, 1, 0, false},
		{10 * time.Second, 0, 0, false},
		{10 * time.Second, 2, 0, true},
		{10 * time.Second, 1, 1, true},
		{domain.CallMinimum, 1, 0, true},
		{time.Hour, 0, 0, false},
	} {
		if got := domain.WorthSummarizing(c.d, c.people, c.messages); got != c.want {
			t.Errorf("%v, %d personas, %d mensajes: %v, quería %v", c.d, c.people, c.messages, got, c.want)
		}
	}
	for d, want := range map[time.Duration]string{
		45 * time.Second: "45 s", 12*time.Minute + 20*time.Second: "12 min",
		12*time.Minute + 40*time.Second: "13 min",
		65 * time.Minute: "1 h 05 min", 0: "",
	} {
		if got := domain.CallLength(d); got != want {
			t.Errorf("CallLength(%v) = %q, quería %q", d, got, want)
		}
	}
}

// Dos réplicas cerrando la misma llamada: sólo una cierra, y sólo ésa resume.
// El reloj de un solo proceso no lo enseña —una cerrada ya no vuelve a él—,
// así que se mira donde se decide.
func TestOnlyOneCloseWins(t *testing.T) {
	svc, _, db := callsUnderTestDB(t, &fakeSFU{})
	sp := "esp-1"
	svc.Open("org-1", &sp, "voice:esp-1", nil, "u-ana")
	id := openSessions(t, db, "voice:esp-1")[0].ID
	repo := repository.NewCallSessionRepository(db)
	first, err := repo.Close(id, callT0)
	if err != nil || !first {
		t.Fatalf("la primera cierra: %v %v", first, err)
	}
	if again, _ := repo.Close(id, callT0.Add(time.Minute)); again {
		t.Error("la segunda no puede cerrar otra vez: pondría un segundo resumen")
	}
}

// Reescribir el resumen cambia la línea sin avisar otra vez: ya avisó al
// ponerse. Y sólo una línea del sistema: el mensaje de una persona no lo
// reescribe nadie más que ella.
func TestRewritingASummaryDoesNotNotifyAgain(t *testing.T) {
	db, cleanup := chatFollowDB(t)
	defer cleanup()
	espia := &notificadorEspia{}
	chat := NewChatService(repository.NewChatRepository(db), nil).WithNotifier(espia)
	m, err := chat.PostSystem("esp-1", "org-1", ana, "Call ended · 3 min", "Call ended.")
	if err != nil {
		t.Fatal(err)
	}
	antes := len(espia.avisos)
	if err := chat.UpdateSystem(m.ID, "Call ended · 3 min · recorded"); err != nil {
		t.Fatal(err)
	}
	if len(espia.avisos) != antes {
		t.Errorf("reescribir avisó %d veces más", len(espia.avisos)-antes)
	}
	again, _ := repository.NewChatRepository(db).Find(m.ID)
	if again.Body != "Call ended · 3 min · recorded" {
		t.Errorf("la línea no cambió: %q", again.Body)
	}
	suya, _ := chat.Post("esp-1", "org-1", bea, "lo mío")
	if err := chat.UpdateSystem(suya.ID, "otra cosa"); err != ErrNotAUserMessage {
		t.Errorf("el mensaje de una persona no se reescribe por aquí: %v", err)
	}
}

// Entrar a una reunión abre su llamada, colgada del canal de la invitación.
// Sin esto la reunión no dejaría resumen. Mutante: no abrir en MemberToken.
func TestJoiningAMeetingOpensItsCall(t *testing.T) {
	svc, _, repo := callsUnderTest(t, &fakeSFU{})
	db := repo.DB()
	if err := db.AutoMigrate(&domain.CallSession{}, &domain.CallSessionParticipant{}); err != nil {
		t.Fatal(err)
	}
	calls := NewCallSessionService(repository.NewCallSessionRepository(db), nil, &fakeSFU{})
	svc.voice.WithSessions(calls)
	inv := newInvite(t, svc, strp("esp-1"), 0)
	if _, err := svc.MemberToken(inv, "u-host", "host"); err != nil {
		t.Fatal(err)
	}
	open := openSessions(t, db, inv.Room())
	if len(open) != 1 || open[0].SpaceID == nil || *open[0].SpaceID != "esp-1" || open[0].InviteID == nil {
		t.Fatalf("entrar a la reunión abre su llamada, en el canal de la invitación: %+v", open)
	}
}
