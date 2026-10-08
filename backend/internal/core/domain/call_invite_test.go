package domain

import (
	"testing"
	"time"
)

// Una invitación no abre nunca la sala de un canal.
//
// Es la decisión entera de W3: el enlace que se reenvía abre una reunión, no la
// voz permanente de un equipo. Si los prefijos coincidieran, una invitación
// cuyo id fuera el de un espacio abriría ese canal.
func TestAMeetRoomNeverCollidesWithAChannelRoom(t *testing.T) {
	id := "6f1c2c1e-0000-4000-8000-000000000001"
	if MeetRoomFor(id) == "voice:"+id {
		t.Fatal("una invitación con el id de un espacio abre la sala de ese canal")
	}
	if MeetRoomFor(id) != "meet:"+id {
		t.Fatalf("sala de reunión inesperada: %q", MeetRoomFor(id))
	}
}

// Ser invitado se decide por el prefijo, desde el principio.
//
// El mutante que mata: `HasPrefix` → `Contains`. Con eso, un miembro cuyo
// nombre de LiveKit —o cualquier identidad— llevara «guest:» por dentro se
// trataría como alguien a quien se puede echar.
func TestGuestIdentityIsDecidedByPrefix(t *testing.T) {
	if !IsGuestIdentity(GuestIdentity("abc")) {
		t.Fatal("la identidad que acuña el servidor no se reconoce como invitado")
	}
	for _, notGuest := range []string{
		"6f1c2c1e-0000-4000-8000-000000000001",
		"x-guest:abc",
		"",
	} {
		if IsGuestIdentity(notGuest) {
			t.Fatalf("%q se trata como invitado", notGuest)
		}
	}
	if id, ok := GuestIDOf("guest:abc"); !ok || id != "abc" {
		t.Fatalf("GuestIDOf = %q, %v", id, ok)
	}
	if _, ok := GuestIDOf("abc"); ok {
		t.Fatal("un id de usuario se lee como id de invitado")
	}
}

// Una invitación revocada o caducada no abre nada.
func TestAnInviteIsLiveOnlyBeforeExpiryAndUnrevoked(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	inv := CallInvite{ExpiresAt: now.Add(time.Hour)}
	if !inv.Live(now) {
		t.Fatal("una invitación vigente no abre")
	}
	if inv.Live(now.Add(time.Hour)) {
		t.Fatal("una invitación abre en el instante en que caduca")
	}
	revoked := now
	inv.RevokedAt = &revoked
	if inv.Live(now) {
		t.Fatal("una invitación revocada sigue abriendo")
	}
}
