package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	lksdk "github.com/livekit/protocol/livekit"

	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// callsUnderTest: invitaciones y grabación sobre la misma base y el mismo SFU
// de mentira, que es como viven en producción.
func callsUnderTest(t *testing.T, sfu *fakeSFU) (*CallInviteService, *RecordingService, *repository.CallInviteRepository) {
	t.Helper()
	db := recordingDB(t)
	if err := db.AutoMigrate(&domain.CallInvite{}, &domain.CallGuest{},
		&domain.Organization{}, &domain.TaskSpace{}); err != nil {
		t.Fatal(err)
	}
	rec := NewRecordingService(repository.NewRecordingRepository(db), sfu, nil,
		mediastore.Fake(), "recordings", true, 240)
	repo := repository.NewCallInviteRepository(db)
	voice := NewVoiceService("wss://rtc.example", llave, secreto)
	return NewCallInviteService(repo, voice, sfu, rec), rec, repo
}

func newInvite(t *testing.T, svc *CallInviteService, spaceID *string, maxGuests int) *domain.CallInvite {
	t.Helper()
	inv, err := svc.Create("org-1", spaceID, "u-host", "Revisión con el cliente", 0, maxGuests)
	if err != nil {
		t.Fatal(err)
	}
	return inv
}

func strp(s string) *string { return &s }

// admitted: alguien pide entrar y un miembro le deja. Es el único camino por
// el que un invitado recibe la entrada a la sala.
func admitted(t *testing.T, svc *CallInviteService, inv *domain.CallInvite, name string) *domain.GuestJoinResponse {
	t.Helper()
	link := repository.SignCallInviteLink(inv.ID)
	asked, err := svc.JoinAsGuest(link, name, "")
	if err != nil {
		t.Fatal(err)
	}
	id, ok := repository.VerifyGuestPass(inv.ID, asked.Pass, svc.now())
	if !ok {
		t.Fatal("el pase de quien espera no vale")
	}
	if err := svc.Admit(inv, id, "u-host"); err != nil {
		t.Fatal(err)
	}
	res, err := svc.GuestStatus(link, asked.Pass)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// ─── El token del invitado ───────────────────────────────────────────────────

// El token de un invitado sólo nombra la sala de su reunión.
//
// El mutante que mata: acuñarlo con `RoomFor` (la sala del canal). Entonces el
// enlace que se reenvía abriría la voz permanente del equipo, que es lo único
// que W3 decidió que no podía pasar.
func TestTheGuestTokenNamesOnlyTheMeetRoom(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, strp("esp-1"), 0)

	res := admitted(t, svc, inv, "Ana")
	g := verificar(t, res.Token)
	if g.Video.Room != domain.MeetRoomFor(inv.ID) {
		t.Fatalf("el invitado entra a %q, no a su reunión", g.Video.Room)
	}
	if g.Video.Room == RoomFor("esp-1") {
		t.Fatal("el invitado entra a la sala del canal")
	}
}

// Un invitado no administra, no manda datos y no se renombra.
//
// Los mutantes que mata: `CanPublishData` o `CanUpdateOwnMetadata` a true, o
// darle `RoomAdmin`. Cada uno es una puerta: los datos llevan lo que la app de
// los miembros se cree, el nombre es cómo lo ven todos, y administrar es echar
// a los demás.
func TestTheGuestTokenCannotAdministerSendDataOrRenameItself(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)

	res := admitted(t, svc, inv, "Ana")
	v := verificar(t, res.Token).Video
	if v.RoomAdmin || v.RoomCreate || v.RoomList || v.RoomRecord {
		t.Fatalf("el invitado tiene permisos de administración: %+v", v)
	}
	if v.GetCanPublishData() {
		t.Fatal("el invitado puede mandar datos")
	}
	if v.GetCanUpdateOwnMetadata() {
		t.Fatal("el invitado se puede renombrar")
	}
	if !v.GetCanPublish() || !v.GetCanSubscribe() {
		t.Fatal("el invitado no puede hablar ni oír")
	}
	// Y sí puede lo que se decidió: micro, cámara y pantalla.
	sources := map[string]bool{}
	for _, s := range v.GetCanPublishSources() {
		sources[s.String()] = true
	}
	for _, want := range []string{"MICROPHONE", "CAMERA", "SCREEN_SHARE"} {
		if !sources[want] {
			t.Fatalf("el invitado no puede publicar %s: %v", want, sources)
		}
	}
}

// La identidad la acuña el servidor, nunca el nombre.
//
// El mutante que mata: tomar la identidad de lo que escribió el invitado. Con
// eso, quien escribiera el id de un miembro entraría **como** ese miembro —su
// cara en la pantalla de todos, y sin que nadie pudiera echarlo—.
func TestTheServerMintsTheGuestIdentity(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)

	member := "6f1c2c1e-0000-4000-8000-000000000001"
	res := admitted(t, svc, inv, member)
	g := verificar(t, res.Token)
	if !domain.IsGuestIdentity(g.Identity) || g.Identity != res.Identity {
		t.Fatalf("identidad %q: no es la de un invitado acuñada aquí", g.Identity)
	}
	if strings.Contains(g.Identity, member) {
		t.Fatal("la identidad sale del nombre que escribió el invitado")
	}
	if g.Name != member {
		t.Fatalf("el nombre que se enseña es %q", g.Name)
	}
}

// ─── Quién entra ─────────────────────────────────────────────────────────────

// Una invitación revocada o caducada no acuña nada.
//
// El mutante que mata: quitar la comprobación de `RevokedAt` (o de la fecha).
// Revocar se quedaría en una palabra en la pantalla.
func TestADeadInviteMintsNothing(t *testing.T) {
	svc, _, repo := callsUnderTest(t, &fakeSFU{})

	revoked := newInvite(t, svc, nil, 0)
	if err := svc.Revoke(context.Background(), revoked); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.JoinAsGuest(repository.SignCallInviteLink(revoked.ID), "Ana", ""); !errors.Is(err, ErrInviteRevoked) {
		t.Fatalf("una invitación revocada deja entrar: %v", err)
	}
	fresh, _ := repo.FindByID(revoked.ID)
	if _, err := svc.MemberToken(fresh, "u-1", "u1"); !errors.Is(err, ErrInviteRevoked) {
		t.Fatalf("un miembro entra a una reunión revocada: %v", err)
	}

	expired := newInvite(t, svc, nil, 0)
	svc.now = func() time.Time { return expired.ExpiresAt.Add(time.Second) }
	if _, err := svc.JoinAsGuest(repository.SignCallInviteLink(expired.ID), "Ana", ""); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("una invitación caducada deja entrar: %v", err)
	}
	if _, err := svc.Inspect(repository.SignCallInviteLink(expired.ID)); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("una invitación caducada se enseña: %v", err)
	}

	if _, err := svc.JoinAsGuest("inventado.abc", "Ana", ""); !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("un enlace inventado: %v", err)
	}
}

// A quien se echa no vuelve con su pase.
//
// El mutante que mata: no mirar `KickedAt` al volver. Echar sólo lo
// desconectaría, y su página volvería a pedir entrada al momento.
func TestAKickedGuestCannotComeBackWithTheirPass(t *testing.T) {
	sfu := &fakeSFU{}
	svc, _, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, nil, 0)
	link := repository.SignCallInviteLink(inv.ID)

	first := admitted(t, svc, inv, "Ana")
	// Con su pase vuelve la misma persona.
	again, err := svc.JoinAsGuest(link, "", first.Pass)
	if err != nil || again.Identity != first.Identity || again.Name != "Ana" {
		t.Fatalf("el pase no devuelve a la misma persona: %+v %v", again, err)
	}

	if err := svc.Kick(context.Background(), inv, "u-host", first.Identity); err != nil {
		t.Fatal(err)
	}
	if len(sfu.removed) != 1 || sfu.removed[0] != inv.Room()+"/"+first.Identity {
		t.Fatalf("no se sacó de la sala a quien se echó: %v", sfu.removed)
	}
	if _, err := svc.JoinAsGuest(link, "", first.Pass); !errors.Is(err, ErrGuestRemoved) {
		t.Fatalf("quien se echó vuelve con su pase: %v", err)
	}
}

// Desde una reunión sólo se echa a gente de fuera.
//
// El mutante que mata: quitar la guarda del prefijo. La identidad llega en la
// URL, así que cualquier miembro podría sacar a otro de la llamada.
func TestOnlyGuestsCanBeRemoved(t *testing.T) {
	sfu := &fakeSFU{}
	svc, _, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, nil, 0)

	err := svc.Kick(context.Background(), inv, "u-host", "6f1c2c1e-0000-4000-8000-000000000001")
	if !errors.Is(err, ErrOnlyGuests) {
		t.Fatalf("se puede echar a un miembro: %v", err)
	}
	if len(sfu.removed) != 0 {
		t.Fatalf("se sacó a alguien de la sala: %v", sfu.removed)
	}
}

// Revocar saca a los invitados que estén dentro, y deja a los miembros.
//
// El mutante que mata: quitar el bucle que los saca. Un enlace revocado con la
// persona dentro sólo le impediría volver si se le cae la red.
func TestRevokingRemovesTheGuestsInside(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-host"), person("guest:g1"), person("guest:g2"),
	}}
	svc, _, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, nil, 0)

	if err := svc.Revoke(context.Background(), inv); err != nil {
		t.Fatal(err)
	}
	if len(sfu.removed) != 2 {
		t.Fatalf("se sacó a %v, y tenían que ser los dos invitados", sfu.removed)
	}
	for _, r := range sfu.removed {
		if !strings.HasPrefix(r, inv.Room()+"/guest:") {
			t.Fatalf("revocar sacó a %q", r)
		}
	}
}

// Un enlace para dos deja entrar a dos.
//
// El cupo se cuenta **al dejar entrar**, sobre los admitidos, y no al pedir:
// si contara las peticiones, cualquiera con el enlace lo agotaría sin que
// nadie le dejara pasar. El mutante que mata: no contar (o contar con `>`).
func TestAFullInviteLetsNoMoreIn(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 2)
	admitted(t, svc, inv, "Ana")
	admitted(t, svc, inv, "Bea")

	link := repository.SignCallInviteLink(inv.ID)
	carla, err := svc.JoinAsGuest(link, "Carla", "")
	if err != nil {
		t.Fatalf("pedir entrar no gasta cupo: %v", err)
	}
	id, _ := repository.VerifyGuestPass(inv.ID, carla.Pass, svc.now())
	if err := svc.Admit(inv, id, "u-host"); !errors.Is(err, repository.ErrCallInviteFull) {
		t.Fatalf("entra una tercera persona en un enlace para dos: %v", err)
	}
}

// ─── La sala de espera ───────────────────────────────────────────────────────

// Pedir entrar no es entrar: hasta que un miembro decide, no hay token.
//
// Es la regla entera de la sala de espera («no queremos que alguien entre
// cuando no deba, sólo cuando nosotros queramos»). El mutante que mata:
// acuñar la entrada al pedir, o al preguntar mientras se espera.
func TestKnockingDoesNotLetYouIn(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	link := repository.SignCallInviteLink(inv.ID)

	asked, err := svc.JoinAsGuest(link, "Ana", "")
	if err != nil {
		t.Fatal(err)
	}
	if asked.Status != domain.GuestWaiting || asked.Token != "" || asked.URL != "" {
		t.Fatalf("pedir entrar dio entrada: %+v", asked)
	}
	again, err := svc.GuestStatus(link, asked.Pass)
	if err != nil || again.Token != "" || again.Status != domain.GuestWaiting {
		t.Fatalf("preguntar mientras se espera dio entrada: %+v %v", again, err)
	}
	// Y volver con el pase a la puerta tampoco cuela.
	back, err := svc.JoinAsGuest(link, "Ana", asked.Pass)
	if err != nil || back.Token != "" {
		t.Fatalf("volver con el pase dio entrada sin que nadie dejara: %+v %v", back, err)
	}
	waiting, _ := svc.Waiting(inv)
	if len(waiting) != 1 || waiting[0].Name != "Ana" {
		t.Fatalf("los de dentro no ven a quien espera: %+v", waiting)
	}
}

// A quien se rechaza no vuelve a pedir con su pase.
//
// El mutante que mata: no mirar `rejected`. Rechazar sería un «todavía no».
func TestARejectedGuestCannotKnockAgain(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	link := repository.SignCallInviteLink(inv.ID)
	asked, _ := svc.JoinAsGuest(link, "Ana", "")
	id, _ := repository.VerifyGuestPass(inv.ID, asked.Pass, svc.now())

	if err := svc.Reject(inv, id, "u-host"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GuestStatus(link, asked.Pass); !errors.Is(err, ErrGuestRejected) {
		t.Fatalf("quien fue rechazado sigue esperando: %v", err)
	}
	if _, err := svc.JoinAsGuest(link, "Ana", asked.Pass); !errors.Is(err, ErrGuestRejected) {
		t.Fatalf("quien fue rechazado vuelve a pedir con su pase: %v", err)
	}
}

// Dos miembros decidiendo a la vez: gana el primero.
//
// El mutante que mata: decidir sin mirar que siga esperando. Entonces un
// «rechazar» que llega tarde echaría a alguien a quien otro ya dejó pasar.
func TestTheFirstDecisionWins(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	asked, _ := svc.JoinAsGuest(repository.SignCallInviteLink(inv.ID), "Ana", "")
	id, _ := repository.VerifyGuestPass(inv.ID, asked.Pass, svc.now())

	if err := svc.Admit(inv, id, "u-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reject(inv, id, "u-2"); !errors.Is(err, repository.ErrGuestNotWaiting) {
		t.Fatalf("un rechazo tardío pisa la admisión: %v", err)
	}
	res, err := svc.GuestStatus(repository.SignCallInviteLink(inv.ID), asked.Pass)
	if err != nil || res.Token == "" {
		t.Fatalf("la admisión no se mantuvo: %+v %v", res, err)
	}
}

// La sala de espera tiene tope.
//
// El mutante que mata: no contar. Un enlace filtrado serviría para llenar la
// pantalla de los de dentro de gente pidiendo entrar.
func TestTheWaitingRoomHasACap(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	link := repository.SignCallInviteLink(inv.ID)
	for i := 0; i < domain.MaxWaitingGuests; i++ {
		if _, err := svc.JoinAsGuest(link, "Alguien", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.JoinAsGuest(link, "Uno más", ""); !errors.Is(err, repository.ErrCallInviteFull) {
		t.Fatalf("la sala de espera no tiene tope: %v", err)
	}
}

// En una reunión cerrada no se deja entrar a nadie, aunque estuviera esperando.
func TestNobodyIsAdmittedIntoAClosedCall(t *testing.T) {
	svc, _, repo := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	asked, _ := svc.JoinAsGuest(repository.SignCallInviteLink(inv.ID), "Ana", "")
	id, _ := repository.VerifyGuestPass(inv.ID, asked.Pass, svc.now())
	if err := svc.Revoke(context.Background(), inv); err != nil {
		t.Fatal(err)
	}
	closed, _ := repo.FindByID(inv.ID)
	if err := svc.Admit(closed, id, "u-host"); !errors.Is(err, ErrInviteRevoked) {
		t.Fatalf("se deja entrar a una reunión cerrada: %v", err)
	}
}

// ─── El timbre, a una reunión ────────────────────────────────────────────────

// Sólo se llama a gente de la organización, y a una reunión viva.
//
// El mutante que mata: quitar la guarda de pertenencia. El timbre sería un
// pulsador para hacer sonar el escritorio de cualquiera cuyo id se conozca.
func TestRingingIntoAMeetOnlyReachesMembers(t *testing.T) {
	svc, _, repo := callsUnderTest(t, &fakeSFU{})
	db := repo.DB()
	if err := db.AutoMigrate(&domain.OrgMembership{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&domain.OrgMembership{OrgID: "org-1", UserID: "u-bea", Role: domain.OrgRoleMember}).Error; err != nil {
		t.Fatal(err)
	}
	inv := newInvite(t, svc, strp("esp-1"), 0)
	de := domain.VoiceCaller{ID: "u-host", Name: "Ana"}

	ring, err := svc.Ring(inv, de, "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	if ring.InviteID == nil || *ring.InviteID != inv.ID || ring.Title != inv.Title {
		t.Fatalf("el timbre no dice a qué reunión: %+v", ring)
	}
	if _, err := svc.Ring(inv, de, "u-ajeno"); !errors.Is(err, ErrRingOutsider) {
		t.Fatalf("se llama a alguien de fuera de la organización: %v", err)
	}
	if _, err := svc.Ring(inv, de, "u-host"); !errors.Is(err, ErrRingOutsider) {
		t.Fatalf("uno se llama a sí mismo: %v", err)
	}
	if err := svc.Revoke(context.Background(), inv); err != nil {
		t.Fatal(err)
	}
	closed, _ := repo.FindByID(inv.ID)
	if _, err := svc.Ring(closed, de, "u-bea"); !errors.Is(err, ErrInviteRevoked) {
		t.Fatalf("se llama a una reunión cerrada: %v", err)
	}
}

// Lo que ve un invitado antes de entrar no lleva ni un id.
func TestThePublicInspectRevealsNoIDs(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, strp("esp-1"), 0)

	pub, err := svc.Inspect(repository.SignCallInviteLink(inv.ID))
	if err != nil {
		t.Fatal(err)
	}
	if pub.Title != inv.Title {
		t.Fatalf("título %q", pub.Title)
	}
	if !pub.RecordingPossible {
		t.Fatal("una reunión con canal en una instalación que graba no avisa de que se puede grabar")
	}
}

// ─── El nombre ───────────────────────────────────────────────────────────────

// El nombre que se enseña no lleva caracteres de control.
//
// Un salto de línea o un carácter de dirección (RLO, U+202E) basta para que el
// nombre se lea como otra cosa en la pantalla de todos.
func TestCleanGuestName(t *testing.T) {
	cases := map[string]string{
		"  Ana  López ":         "Ana López",
		"Ana\nLópez":            "Ana López",
		"Ana‮López":             "AnaLópez",
		"​":                     "",
		strings.Repeat("a", 80): strings.Repeat("a", domain.GuestNameMax),
	}
	for in, want := range cases {
		got, ok := CleanGuestName(in)
		if want == "" {
			if ok {
				t.Fatalf("%q se acepta como nombre: %q", in, got)
			}
			continue
		}
		if !ok || got != want {
			t.Fatalf("CleanGuestName(%q) = %q, %v; quería %q", in, got, ok, want)
		}
	}
}

// ─── La grabación de una reunión ─────────────────────────────────────────────

// Una reunión sin canal no se graba.
//
// El mutante que mata: quitar la guarda. La grabación necesita un espacio para
// listarse, anunciarse y autorizarse; sin él quedaría una fila que nadie puede
// ver ni borrar.
func TestASpacelessMeetCannotBeRecorded(t *testing.T) {
	svc, _, _ := callsUnderTest(t, &fakeSFU{})
	inv := newInvite(t, svc, nil, 0)
	if _, err := svc.RecordingTarget(inv); !errors.Is(err, ErrRecordingNeedsSpace) {
		t.Fatalf("una reunión sin canal se puede grabar: %v", err)
	}
	pub, err := svc.Inspect(repository.SignCallInviteLink(inv.ID))
	if err != nil {
		t.Fatal(err)
	}
	if pub.RecordingPossible {
		t.Fatal("se avisa de una grabación que no puede pasar")
	}
}

// El canal y una reunión que cuelga de él se graban a la vez.
//
// El mutante que mata: devolver el índice a `space_id`. Con él, grabar la
// reunión con el cliente impediría grabar el canal del equipo, y al revés.
// Y la política del canal no ve la grabación de la reunión.
func TestAChannelAndAMeetOfTheSameSpaceRecordAtOnce(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, rec, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, strp("esp-1"), 0)
	ctx := context.Background()

	if _, err := rec.Start(ctx, "org-1", "esp-1", "u-1"); err != nil {
		t.Fatal(err)
	}
	target, err := svc.RecordingTarget(inv)
	if err != nil {
		t.Fatal(err)
	}
	meet, err := rec.StartIn(ctx, target, "u-1")
	if err != nil {
		t.Fatalf("la reunión no se puede grabar mientras se graba el canal: %v", err)
	}
	if meet.InviteID == nil || *meet.InviteID != inv.ID || meet.SpaceID != "esp-1" {
		t.Fatalf("la grabación de la reunión no dice de dónde es: %+v", meet)
	}
	// Y la misma sala, dos veces, sigue sin poder.
	if _, err := rec.StartIn(ctx, target, "u-2"); !errors.Is(err, repository.ErrAlreadyRecording) {
		t.Fatalf("la misma reunión se graba dos veces: %v", err)
	}

	pol, err := rec.PolicyForRoom(inv.Room())
	if err != nil || pol.Active == nil || pol.Active.ID != meet.ID {
		t.Fatalf("la política de la reunión no ve su grabación: %+v %v", pol, err)
	}
	ch, err := rec.Policy("esp-1")
	if err != nil || ch.Active == nil || ch.Active.ID == meet.ID {
		t.Fatalf("la política del canal ve la grabación de la reunión: %+v %v", ch, err)
	}
}

// Una reunión en la que sólo quedan invitados deja de grabarse.
//
// El mutante que mata: contar `humans` en vez de `members`. Un invitado que se
// queda solo con la pestaña abierta mantendría la grabación de la organización
// encendida hasta el tope de cuatro horas.
func TestARecordingWithOnlyGuestsLeftStops(t *testing.T) {
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)),
		person("guest:g1", track("TR_gmic", lksdk.TrackSource_MICROPHONE, false)),
	}}
	svc, rec, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, strp("esp-1"), 0)
	target, _ := svc.RecordingTarget(inv)

	started, err := rec.StartIn(context.Background(), target, "u-1")
	if err != nil {
		t.Fatal(err)
	}
	// Se va el miembro; el invitado se queda.
	keep := sfu.people[:0]
	for _, p := range sfu.people {
		if p.Identity != "u-1" {
			keep = append(keep, p)
		}
	}
	sfu.people = keep

	now := time.Now().UTC()
	rec.Tick(context.Background(), now.Add(10*time.Second))
	rec.Tick(context.Background(), now.Add(20*time.Second))

	got, err := rec.FindByID(started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.RecordingFinalizing {
		t.Fatalf("con sólo un invitado dentro sigue grabando: %q", got.Status)
	}
}

// La pista de un invitado guarda cómo se llamaba.
//
// El mutante que mata: no llenar `ParticipantName`. Un invitado no está en
// ningún directorio; sin esto, su voz sería de «guest:…» para siempre.
func TestAGuestTrackKeepsTheGuestsName(t *testing.T) {
	g := person("guest:g1", track("TR_gmic", lksdk.TrackSource_MICROPHONE, false))
	g.Name = "Ana López"
	sfu := &fakeSFU{people: []*lksdk.ParticipantInfo{
		person("u-1", track("TR_mic", lksdk.TrackSource_MICROPHONE, false)), g,
	}}
	svc, rec, _ := callsUnderTest(t, sfu)
	inv := newInvite(t, svc, strp("esp-1"), 0)
	target, _ := svc.RecordingTarget(inv)

	started, err := rec.StartIn(context.Background(), target, "u-1")
	if err != nil {
		t.Fatal(err)
	}
	full, err := rec.Get(started.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range full.Tracks {
		if tr.ParticipantIdentity == "guest:g1" {
			if tr.ParticipantName != "Ana López" {
				t.Fatalf("la pista del invitado se llama %q", tr.ParticipantName)
			}
			return
		}
	}
	t.Fatalf("no se grabó la pista del invitado: %+v", full.Tracks)
}
