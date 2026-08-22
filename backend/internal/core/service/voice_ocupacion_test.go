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
