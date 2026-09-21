package domain

import (
	"strings"
	"testing"
)

// Lo que un cuerpo cita, leído del cuerpo.
//
// Las dos funciones son puras, así que aquí no hay base de datos ni servicio:
// entra un texto, sale lo que el texto dice. Son la definición de qué es un
// enlace y qué es un adjunto para todo lo demás — el `LIKE` de la consulta sólo
// descarta barato, no decide.

// El paréntesis de cierre de un enlace markdown no es parte de la URL.
//
// El mutante que mata: quitar `)` de la clase negada de `linkPattern`. La
// pestaña sigue saliendo, con todas las URLs enlazadas bien terminadas en un
// corchete de más, y el fallo sólo se ve cuando alguien pulsa una.
func TestALinkDoesNotSwallowTheClosingParen(t *testing.T) {
	got := ExtractLinks("mira [el runbook](https://ejemplo.dev/a/b) y dime")
	if len(got) != 1 {
		t.Fatalf("un enlace, salieron %d: %+v", len(got), got)
	}
	if got[0].URL != "https://ejemplo.dev/a/b" {
		t.Errorf("la URL se corta en el paréntesis: %q", got[0].URL)
	}
	if got[0].Label != "el runbook" {
		t.Errorf("y se queda con las palabras que le pusieron: %q", got[0].Label)
	}
}

// Una URL repetida es una URL.
//
// El mutante que mata: quitar la deduplicación. Un canal donde se pega tres
// veces el mismo enlace del despliegue da una pestaña con tres filas idénticas.
func TestARepeatedLinkAppearsOnce(t *testing.T) {
	got := ExtractLinks("https://x.dev/a y otra vez https://x.dev/a y [lo mismo](https://x.dev/a)")
	if len(got) != 1 {
		t.Fatalf("una sola vez, salieron %d: %+v", len(got), got)
	}
	// Y la etiqueta la rescata la aparición que la trae, aunque llegue después:
	// «pego la URL y luego la explico» es como se escribe de verdad.
	if got[0].Label != "lo mismo" {
		t.Errorf("la etiqueta que exista gana a no tener ninguna: %q", got[0].Label)
	}
}

// El orden es el del canal, y la etiqueta la de quien lo presentó primero.
func TestLinksComeOutInTheOrderTheyAppear(t *testing.T) {
	got := ExtractLinks("[uno](https://a.dev) luego https://b.dev y [uno otra vez](https://a.dev)")
	if len(got) != 2 || got[0].URL != "https://a.dev" || got[1].URL != "https://b.dev" {
		t.Fatalf("en el orden en que aparecen: %+v", got)
	}
	if got[0].Label != "uno" {
		t.Errorf("manda la primera aparición, no la última: %q", got[0].Label)
	}
}

// `http` dentro de una palabra no es un enlace, y por eso el `LIKE '%http%'` de
// la consulta no puede ser la definición de nada.
func TestTheLikeIsNotTheDefinitionOfALink(t *testing.T) {
	if got := ExtractLinks("hablamos de httpsomething y de shttp://x"); len(got) != 0 {
		t.Errorf("ni una cosa ni la otra son un enlace: %+v", got)
	}
}

// Una imagen externa **sí** es un enlace: no está en `chat_attachments`, así que
// si no cayera aquí no estaría en ninguna pestaña.
func TestAnImageFromOutsideLandsInLinks(t *testing.T) {
	got := ExtractLinks("![el gráfico](https://fuera.dev/g.png)")
	if len(got) != 1 || got[0].URL != "https://fuera.dev/g.png" {
		t.Fatalf("una imagen de fuera es lo único que la deja alcanzable: %+v", got)
	}
}

// El id de un adjunto es un uuid, como el de una mención.
//
// El mutante que mata: abrir el patrón a `.+`. Con eso, `/chat/attachments/../raw`
// —o cualquier cosa que alguien escriba entre las barras— entra en la consulta
// como si fuera un id.
func TestAnAttachmentIsMatchedByItsExactShape(t *testing.T) {
	const id = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8"
	cuerpo := "![captura](/api/v1/task-spaces/esp-1/chat/attachments/" + id + "/raw)"
	got := ExtractAttachmentIDs(cuerpo)
	if len(got) != 1 || got[0] != id {
		t.Fatalf("el uuid y nada más: %+v", got)
	}
	for _, bad := range []string{
		"/api/v1/task-spaces/esp-1/chat/attachments/../raw",
		"/api/v1/task-spaces/esp-1/chat/attachments/no-es-un-uuid/raw",
		"/api/v1/task-spaces/esp-1/chat/attachments/" + id,
	} {
		if got := ExtractAttachmentIDs(bad); len(got) != 0 {
			t.Errorf("%q no nombra ningún adjunto, salió %+v", bad, got)
		}
	}
}

// Una imagen puesta dos veces en el mismo mensaje es una imagen.
func TestAnAttachmentCitedTwiceIsOne(t *testing.T) {
	const id = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8"
	ref := "/api/v1/task-spaces/esp-1/chat/attachments/" + id + "/raw"
	if got := ExtractAttachmentIDs("![a](" + ref + ") y otra vez ![a](" + ref + ")"); len(got) != 1 {
		t.Errorf("una sola vez: %+v", got)
	}
}

// La línea que se pone en el canal se tiene que leer bien **firmada y sin
// firmar**, porque una app que no conoce `kind` la pinta firmada por quien
// grabó.
//
// El mutante que mata: escribirla en primera persona («I stopped the
// recording») o nombrando al autor dentro. Lo primero es mentira en la app
// nueva; lo segundo dice el nombre dos veces en la vieja.
func TestTheAnnouncementReadsRightSignedAndUnsigned(t *testing.T) {
	const id = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8"
	body, notice := RecordingAnnouncement(id, RecordingReady, 754_000)

	if want := "cac:recording/" + id; !strings.Contains(body, want) {
		t.Errorf("el cuerpo apunta a la grabación con el esquema de dentro: %q", body)
	}
	if !strings.Contains(body, "12:34") || !strings.Contains(notice, "12:34") {
		t.Errorf("y dice cuánto dura: %q / %q", body, notice)
	}
	// Ni «yo», ni un hueco para un nombre: la firma la pone quien la pinte.
	for _, forbidden := range []string{"I ", "my ", "{{"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("la línea no habla en nombre de nadie, y trae %q: %q", forbidden, body)
		}
	}
	// El aviso de la bandeja no lleva markdown: ahí no hay nada que lo pinte.
	if strings.Contains(notice, "](") {
		t.Errorf("el aviso es una frase plana, no markdown: %q", notice)
	}
	// Una grabación fallida no interrumpe a nadie: ya tiene su sitio en el panel.
	if b, n := RecordingAnnouncement(id, RecordingFailed, 0); b != "" || n != "" {
		t.Errorf("de un fallo no se avisa al canal: %q / %q", b, n)
	}
}
