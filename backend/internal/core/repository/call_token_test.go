package repository

import (
	"strings"
	"testing"
	"time"
)

// Un enlace abre su invitación y ninguna otra.
//
// El mutante que mata: sacar el id del HMAC. Entonces todas las firmas serían
// la misma y bastaría un enlace cualquiera para fabricar el de otra reunión
// cambiándole el id.
func TestAnInviteLinkOpensOnlyItsInvite(t *testing.T) {
	link := SignCallInviteLink("inv-a")
	if id, ok := VerifyCallInviteLink(link); !ok || id != "inv-a" {
		t.Fatalf("el enlace propio no abre: %q %v", id, ok)
	}
	_, sig, _ := strings.Cut(link, ".")
	if _, ok := VerifyCallInviteLink("inv-b." + sig); ok {
		t.Fatal("la firma de una invitación abre otra")
	}
	for _, bad := range []string{"", "inv-a", "inv-a.", ".abc", "inv-a.00"} {
		if _, ok := VerifyCallInviteLink(bad); ok {
			t.Fatalf("%q abre una invitación", bad)
		}
	}
}

// La llave del enlace no es la del reportero ni la del pase.
//
// El mutante que mata: firmar con `reportTokenSecret()` o con la misma llave
// para todo. Un token de reportero —que un widget guarda en el dispositivo de
// cualquiera— no puede convertirse en la entrada a una reunión.
func TestTheInviteKeyIsNotTheReportKey(t *testing.T) {
	if string(callInviteKey()) == string(reportTokenSecret()) {
		t.Fatal("el enlace se firma con la llave del reportero")
	}
	if string(callInviteKey()) == string(callGuestKey()) {
		t.Fatal("el enlace y el pase comparten llave")
	}
	if string(callInviteKey()) == string(urlTicketKey()) {
		t.Fatal("el enlace se firma con la llave del pase de URL")
	}
}

// Un pase vale para su invitación, su invitado y su tiempo.
//
// Los mutantes que mata: saltarse la comprobación de la caducidad, o sacar la
// invitación de la firma (un pase de una reunión abriría otra).
func TestAGuestPassIsBoundToInviteGuestAndTime(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	pass := MintGuestPass("inv-a", "g1", now.Add(72*time.Hour), now)

	if id, ok := VerifyGuestPass("inv-a", pass, now); !ok || id != "g1" {
		t.Fatalf("el pase propio no vale: %q %v", id, ok)
	}
	if _, ok := VerifyGuestPass("inv-b", pass, now); ok {
		t.Fatal("un pase de una invitación abre otra")
	}
	// Doce horas como mucho, aunque la invitación dure tres días.
	if _, ok := VerifyGuestPass("inv-a", pass, now.Add(GuestPassMaxTTL+time.Second)); ok {
		t.Fatal("el pase sigue valiendo después de su tope")
	}
	// Y nunca más que la invitación.
	short := MintGuestPass("inv-a", "g1", now.Add(time.Hour), now)
	if _, ok := VerifyGuestPass("inv-a", short, now.Add(2*time.Hour)); ok {
		t.Fatal("el pase sobrevive a la invitación")
	}
	// Cambiar el invitado dentro del pase lo invalida.
	parts := strings.Split(pass, ".")
	if _, ok := VerifyGuestPass("inv-a", "g2."+parts[1]+"."+parts[2], now); ok {
		t.Fatal("un pase se puede reescribir para otro invitado")
	}
}
