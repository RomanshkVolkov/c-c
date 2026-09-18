package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
«Quién está en el canal» no enseñaba a nadie, nunca.

Dos fallos encadenados, y los dos invisibles: la lista salía vacía, que es
exactamente lo que se ve cuando de verdad no hay nadie. Se descubrieron
levantando un LiveKit y mirando lo que contesta, no leyendo el código.

Los dos tests de aquí usan **respuestas reales capturadas de ese servidor**. Es
la única forma de fijar un contrato que no controlamos.
*/

// Recortado de lo que devolvió un LiveKit 1.x de verdad. Lo importante es la
// forma de las claves, no los valores.
const listRoomsReal = `{"rooms":[{"sid":"RM_wPEBuWVhqYR2","name":"voice:esp-1",
  "empty_timeout":300,"max_participants":0,"num_participants":2,"num_publishers":1,
  "active_recording":false}]}`

const listParticipantsReal = `{"participants":[
  {"sid":"PA_dGPhiVVJy8ev","identity":"u-ana","state":"ACTIVE","name":"Ana",
   "joined_at":"1787383794","is_publisher":true,"kind":"STANDARD"}]}`

/*
Este único test caza los dos fallos, y por eso está solo.

Hubo un segundo que desempaquetaba `listRoomsReal` en una copia local de la
struct y comprobaba el recuento. Pasaba siempre —comprobaba su propia copia
contra sí misma, no el código— así que no protegía de nada y se quitó. Un test
que no puede fallar cuando el código está mal es decoración.

Aquí, en cambio, si el recuento se lee mal la sala se salta, nunca se llama a
`ListParticipants`, y la aserción del token falla. Comprobado mutando.
*/
func TestLaOcupacionEnseniaAQuienEstaDentro(t *testing.T) {
	var salaEnElToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "ListRooms") {
			_, _ = w.Write([]byte(listRoomsReal))
			return
		}
		salaEnElToken = salaDelJWT(t, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(listParticipantsReal))
	}))
	defer srv.Close()

	v := NewVoiceService(srv.URL, "APIabc", "un-secreto-largo-de-prueba")
	out, err := v.Ocupacion(context.Background(), []string{"esp-1"})
	if err != nil {
		t.Fatal(err)
	}

	if salaEnElToken != "voice:esp-1" {
		t.Errorf("el token para mirar dentro llevaba la sala %q, y tiene que llevar «voice:esp-1»", salaEnElToken)
	}
	// Y el resultado llega hasta arriba: el espacio sin el prefijo, con su gente.
	gente, ok := out["esp-1"]
	if !ok || len(gente) != 1 {
		t.Fatalf("se esperaba una persona en esp-1 y salió %+v", out)
	}
	if gente[0].Identity != "u-ana" || gente[0].Name != "Ana" {
		t.Errorf("la pantalla necesita id y nombre, y llegó %+v", gente[0])
	}
}

// salaDelJWT saca `video.room` del token sin verificarlo: aquí lo que se
// comprueba es qué pedimos, no que el servidor lo acepte.
func salaDelJWT(t *testing.T, cabecera string) string {
	t.Helper()
	partes := strings.Split(strings.TrimPrefix(cabecera, "Bearer "), ".")
	if len(partes) != 3 {
		t.Fatalf("eso no es un JWT: %d partes", len(partes))
	}
	cuerpo, err := base64.RawURLEncoding.DecodeString(partes[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Video struct {
			Room string `json:"room"`
		} `json:"video"`
	}
	if err := json.Unmarshal(cuerpo, &claims); err != nil {
		t.Fatal(err)
	}
	return claims.Video.Room
}

// La misma sala, con el grabador dentro. Capturado de un LiveKit con un Track
// Egress en marcha: entra como un participante más, con `kind: "EGRESS"`.
const listParticipantsConGrabador = `{"participants":[
  {"sid":"PA_dGPhiVVJy8ev","identity":"u-ana","state":"ACTIVE","name":"Ana",
   "joined_at":"1787383794","is_publisher":true,"kind":"STANDARD"},
  {"sid":"PA_EGxK2mQ1","identity":"EG_jDSnrV5jWPXu","state":"ACTIVE","name":"",
   "joined_at":"1787383801","is_publisher":false,"kind":"EGRESS"}]}`

// El grabador no es alguien con quien hablar.
//
// LiveKit lo mete en la sala como un participante más. Sin filtrarlo, la lista
// de canales enseñaría un «EG_jDSnrV5jWPXu» sentado en la llamada — y peor: un
// canal donde sólo queda el grabador parecería ocupado, que es exactamente la
// señal que hace que alguien entre a ver quién hay.
func TestLaOcupacionNoEnseniaAlGrabador(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "ListRooms") {
			_, _ = w.Write([]byte(listRoomsReal))
			return
		}
		_, _ = w.Write([]byte(listParticipantsConGrabador))
	}))
	defer srv.Close()

	out, err := NewVoiceService(srv.URL, "APIabc", "un-secreto-largo-de-prueba").
		Ocupacion(context.Background(), []string{"esp-1"})
	if err != nil {
		t.Fatal(err)
	}
	gente := out["esp-1"]
	if len(gente) != 1 {
		t.Fatalf("dentro hay una persona y un grabador, y salieron %d: %+v", len(gente), gente)
	}
	if gente[0].Identity != "u-ana" {
		t.Fatalf("el que sale tiene que ser la persona: %+v", gente[0])
	}
}

// Y una sala en la que **sólo** queda el grabador está vacía.
//
// Es el caso que engaña: `num_participants` dice 1, así que la sala se consulta
// y contesta con alguien dentro. Si ese alguien es el grabador, el canal no
// tiene a nadie — y enseñarlo como ocupado invita a entrar a una llamada que ya
// terminó.
func TestUnaSalaConSoloElGrabadorEstaVacia(t *testing.T) {
	const soloGrabador = `{"participants":[
	  {"sid":"PA_EGxK2mQ1","identity":"EG_jDSnrV5jWPXu","state":"ACTIVE","name":"",
	   "joined_at":"1787383801","is_publisher":false,"kind":"EGRESS"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "ListRooms") {
			_, _ = w.Write([]byte(listRoomsReal))
			return
		}
		_, _ = w.Write([]byte(soloGrabador))
	}))
	defer srv.Close()

	out, err := NewVoiceService(srv.URL, "APIabc", "un-secreto-largo-de-prueba").
		Ocupacion(context.Background(), []string{"esp-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, hay := out["esp-1"]; hay {
		t.Fatalf("la sala no tiene a nadie y salió en la lista: %+v", out)
	}
}

// Y el `json.Marshal` de lo que sale no lleva `kind`.
//
// El filtro necesita leerlo, pero es un detalle del SFU: si se cuela en la
// respuesta, la app empieza a poder depender de un campo que no es nuestro.
func TestLaOcupacionNoFiltraHaciaFueraElKind(t *testing.T) {
	b, err := json.Marshal(Ocupacion{"esp-1": {{Identity: "u-ana", Name: "Ana"}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "kind") {
		t.Fatalf("el kind del SFU no sale a la app: %s", b)
	}
}
