package service

import (
	"strings"
	"testing"

	"github.com/livekit/protocol/auth"
)

/*
La entrada a una sala de voz.

El token es la puerta: quien lo tiene entra, y quien no, no. Por eso se firma en
el servidor y por eso la sala se **deriva** del espacio en vez de aceptarse del
cliente — si viajara en la petición, el guard estaría comprobando la pertenencia
a un espacio mientras el token concede la entrada a otro.
*/

const (
	llave   = "APIabc"
	secreto = "un-secreto-de-prueba-suficientemente-largo"
)

func TestLaSalaSaleDelEspacioYNoDelCliente(t *testing.T) {
	svc := NewVoiceService("wss://rtc.example", llave, secreto)
	jwt, err := svc.Token("esp-1", "u-ana", "ana")
	if err != nil {
		t.Fatal(err)
	}

	concesion := verificar(t, jwt)
	if concesion.Video.Room != "voice:esp-1" {
		t.Errorf("la sala tiene que derivarse del espacio; salió %q", concesion.Video.Room)
	}
	if concesion.Identity != "u-ana" {
		t.Errorf("la identidad es el id de cac; salió %q", concesion.Identity)
	}
	if !concesion.Video.RoomJoin {
		t.Error("sin roomJoin el token no sirve para entrar")
	}
}

// Dos espacios, dos salas. Si el prefijo o el id se perdieran, todo el mundo
// acabaría en la misma conversación sin que nada fallara visiblemente.
func TestCadaEspacioTieneSuSala(t *testing.T) {
	svc := NewVoiceService("wss://rtc.example", llave, secreto)
	a, _ := svc.Token("esp-1", "u-ana", "ana")
	b, _ := svc.Token("esp-2", "u-ana", "ana")
	if verificar(t, a).Video.Room == verificar(t, b).Video.Room {
		t.Error("dos espacios distintos no pueden compartir sala")
	}
}

// Un token de entrada no administra la sala: echar gente o cambiar metadatos no
// es algo que un cliente tenga que poder hacer, y concederlo «por si acaso»
// sería repartir permisos que nadie pidió.
func TestElTokenNoConcedeAdministrarLaSala(t *testing.T) {
	svc := NewVoiceService("wss://rtc.example", llave, secreto)
	jwt, _ := svc.Token("esp-1", "u-ana", "ana")
	v := verificar(t, jwt).Video
	if v.RoomAdmin || v.RoomCreate || v.RoomList {
		t.Errorf("permisos de más: admin=%v create=%v list=%v", v.RoomAdmin, v.RoomCreate, v.RoomList)
	}
	if v.CanPublish == nil || !*v.CanPublish || v.CanSubscribe == nil || !*v.CanSubscribe {
		t.Error("pero sí los de hablar y escuchar, que es a lo que se viene")
	}
}

// Sin llaves no se acuña nada: una instalación sin voz es legítima, y fabricar
// un token que ningún SFU va a aceptar sería peor que decirlo.
func TestSinConfigurarNoSeAcunaNada(t *testing.T) {
	for _, svc := range []*VoiceService{
		NewVoiceService("", llave, secreto),
		NewVoiceService("wss://rtc.example", "", secreto),
		NewVoiceService("wss://rtc.example", llave, ""),
	} {
		if svc.Configured() {
			t.Error("le falta una pieza y se declara configurado")
		}
		if _, err := svc.Token("esp-1", "u-ana", "ana"); err != ErrVoiceUnconfigured {
			t.Errorf("tenía que negarse con ErrVoiceUnconfigured, dio %v", err)
		}
	}
}

// El token está firmado de verdad: con otro secreto no vale. Es lo que impide
// que un cliente se fabrique la entrada a una sala que no le toca.
func TestOtroSecretoNoValida(t *testing.T) {
	jwt, _ := NewVoiceService("wss://rtc.example", llave, secreto).Token("esp-1", "u-ana", "ana")
	if _, err := auth.ParseAPIToken(jwt); err != nil {
		t.Fatalf("el token tiene que parsearse: %v", err)
	}
	tok, _ := auth.ParseAPIToken(jwt)
	if _, _, err := tok.Verify("otro-secreto-distinto-igual-de-largo"); err == nil {
		t.Error("un secreto ajeno no puede validar el token")
	}
}

func verificar(t *testing.T, jwt string) *auth.ClaimGrants {
	t.Helper()
	if strings.Count(jwt, ".") != 2 {
		t.Fatalf("no parece un JWT: %q", jwt)
	}
	tok, err := auth.ParseAPIToken(jwt)
	if err != nil {
		t.Fatal(err)
	}
	_, concesion, err := tok.Verify(secreto)
	if err != nil {
		t.Fatalf("el token no valida con su propio secreto: %v", err)
	}
	return concesion
}
