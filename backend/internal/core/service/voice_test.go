package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

/*
La consulta de ocupación pregunta sólo por lo que se le pasa.

La puerta de esta función no es un `if`: es que la sala se construye desde los
ids que le dan y **nunca** desde nada que venga del cliente. El handler le pasa
los espacios del árbol que ese caller puede ver, así que un espacio ajeno no
llega a nombrarse. Si algún día alguien le pasara ids sin filtrar, esto lo
convertiría en un mirador de las salas de todos los clientes.
*/
func TestLaOcupacionSoloPreguntaPorLosEspaciosQueSeLePasan(t *testing.T) {
	var pedido []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cuerpo struct {
			Names []string `json:"names"`
		}
		_ = json.NewDecoder(r.Body).Decode(&cuerpo)
		pedido = cuerpo.Names
		_, _ = w.Write([]byte(`{"rooms":[]}`))
	}))
	defer srv.Close()

	svc := NewVoiceService(srv.URL, llave, secreto)
	if _, err := svc.Ocupacion(context.Background(), []string{"esp-1", "esp-2"}); err != nil {
		t.Fatal(err)
	}
	if len(pedido) != 2 || pedido[0] != "voice:esp-1" || pedido[1] != "voice:esp-2" {
		t.Errorf("pregunta por las salas de esos espacios y por ninguna más; pidió %v", pedido)
	}
}

// Sin voz configurada no hay a quién preguntar, y eso no es un error: una
// instalación sin SFU sencillamente no tiene a nadie dentro de nada.
func TestSinVozLaOcupacionEsVaciaYNoFalla(t *testing.T) {
	oc, err := NewVoiceService("", "", "").Ocupacion(context.Background(), []string{"esp-1"})
	if err != nil {
		t.Fatalf("no puede fallar: %v", err)
	}
	if len(oc) != 0 {
		t.Errorf("y está vacía; salió %v", oc)
	}
}

// Una sala que no se deja leer no puede tumbar a las demás: media lista es más
// útil que un error, y la que falte vuelve en la siguiente consulta.
func TestUnaSalaIlegibleNoTumbaLasDemas(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "ListRooms") {
			_, _ = w.Write([]byte(`{"rooms":[
				{"name":"voice:esp-rota","numParticipants":1},
				{"name":"voice:esp-buena","numParticipants":1}]}`))
			return
		}
		var cuerpo struct {
			Room string `json:"room"`
		}
		_ = json.NewDecoder(r.Body).Decode(&cuerpo)
		if cuerpo.Room == "voice:esp-rota" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"participants":[{"identity":"u-ana","name":"ana"}]}`))
	}))
	defer srv.Close()

	oc, err := NewVoiceService(srv.URL, llave, secreto).
		Ocupacion(context.Background(), []string{"esp-rota", "esp-buena"})
	if err != nil {
		t.Fatal(err)
	}
	if len(oc["esp-buena"]) != 1 || oc["esp-buena"][0].Identity != "u-ana" {
		t.Errorf("la sala legible tiene que salir; salió %v", oc)
	}
	if _, hay := oc["esp-rota"]; hay {
		t.Error("y la ilegible no se inventa")
	}
}

// Una sala vacía no se consulta dos veces: si el SFU ya dijo que no hay nadie,
// preguntar por sus participantes es una llamada para saber lo que ya sabemos.
func TestUnaSalaVaciaNoSeVuelveAConsultar(t *testing.T) {
	llamadas := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llamadas++
		if strings.HasSuffix(r.URL.Path, "ListRooms") {
			_, _ = w.Write([]byte(`{"rooms":[{"name":"voice:esp-1","numParticipants":0}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"participants":[]}`))
	}))
	defer srv.Close()

	oc, _ := NewVoiceService(srv.URL, llave, secreto).Ocupacion(context.Background(), []string{"esp-1"})
	if llamadas != 1 {
		t.Errorf("una sala vacía se resuelve con la primera llamada; hubo %d", llamadas)
	}
	if len(oc) != 0 {
		t.Errorf("y no aparece en el resultado; salió %v", oc)
	}
}
