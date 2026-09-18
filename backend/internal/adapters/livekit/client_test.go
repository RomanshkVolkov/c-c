package livekit

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// claims saca el cuerpo del JWT sin verificar la firma: lo que se comprueba
// aquí es **qué concesiones lleva**, no si está bien firmado.
func claims(t *testing.T, jwt string) map[string]any {
	t.Helper()
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("esto no es un JWT: %q", jwt)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func grant(t *testing.T, jwt string) map[string]any {
	t.Helper()
	v, ok := claims(t, jwt)["video"].(map[string]any)
	if !ok {
		t.Fatalf("el token no lleva concesión de vídeo: %v", claims(t, jwt))
	}
	return v
}

// `RoomRecord` es obligatorio para cualquier `Egress.*`.
//
// Sin él LiveKit contesta **401**, y el 401 no dice qué concesión falta — así
// que quitarlo se vería como «el SFU rechaza al backend» y mandaría a buscar el
// fallo a las llaves, al reloj o a la red. Ya pasó una vez.
func TestTheEgressTokenCarriesRoomRecord(t *testing.T) {
	c := New("wss://sfu.example", "llave", "secreto-suficientemente-largo-para-hmac").(*client)

	jwt, err := c.bearer("voice:esp-1", true)
	if err != nil {
		t.Fatal(err)
	}
	g := grant(t, jwt)
	if g["roomRecord"] != true {
		t.Fatalf("sin roomRecord, Egress.* contesta 401: %v", g)
	}
	// Y nombrando la sala: `RoomAdmin` sin sala vale para listar salas y **no**
	// para operar sobre una. Es el mismo detalle que ya costó un 401 en
	// `voice.go`.
	if g["room"] != "voice:esp-1" {
		t.Fatalf("la sala tiene que ir en la concesión: %v", g)
	}
}

// Y no se concede cuando no hace falta.
//
// Administrar una sala y grabarla son permisos distintos. Llevar `roomRecord`
// en todas las llamadas «por si acaso» es conceder permisos que nadie pidió, y
// es lo que hace que un token filtrado sirva para más de lo que iba a servir.
func TestTheAdminTokenDoesNotCarryRoomRecord(t *testing.T) {
	c := New("wss://sfu.example", "llave", "secreto-suficientemente-largo-para-hmac").(*client)

	jwt, err := c.bearer("voice:esp-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if g := grant(t, jwt); g["roomRecord"] == true {
		t.Fatalf("listar participantes no necesita permiso de grabar: %v", g)
	}
}

// Sin llaves no hay cliente, y eso es lo que apaga la grabación entera.
//
// Devolver un cliente que falla en cada llamada dejaría el botón encendido en
// una instalación sin SFU, y cada pulsación sería un 502.
func TestNoKeysMeansNoClient(t *testing.T) {
	for _, c := range []Client{
		New("", "k", "s"), New("wss://x", "", "s"), New("wss://x", "k", ""),
	} {
		if c != nil {
			t.Fatal("sin configurar, no hay cliente")
		}
	}
}

// La URL de señalización es `wss://`; la API de administración es el mismo host
// por https. Mandar `wss://` a un cliente HTTP no da un error claro: da un
// esquema no soportado en la primera llamada, a runtime.
func TestTheSignallingURLBecomesAnHTTPBase(t *testing.T) {
	for in, want := range map[string]string{
		"wss://sfu.example":      "https://sfu.example",
		"ws://127.0.0.1:7880":    "http://127.0.0.1:7880",
		"https://sfu.example":    "https://sfu.example",
		"http://localhost:7880/": "http://localhost:7880/",
	} {
		if got := New(in, "k", "s").(*client).base; got != want {
			t.Fatalf("%s → %s (debería %s)", in, got, want)
		}
	}
}
