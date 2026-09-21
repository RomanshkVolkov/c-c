package service

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Las pestañas del canal: multimedia y enlaces.
//
// Las dos se leen de los propios cuerpos, sin tabla que las guarde. Lo que
// estas pruebas defienden es lo que esa decisión regala —y que una columna
// `message_id` no daría—: un borrador abandonado no existe, y retirar un
// mensaje se lleva sus imágenes.

// Multimedia sólo enseña lo que se envió.
//
// Los mutantes que matan:
//
//   - Listar `chat_attachments WHERE space_id` a secas. Entonces la imagen que
//     alguien subió y no llegó a mandar sale igual, y eso es un adjunto privado
//     publicado por haber cambiado de idea.
//   - Quitar el `deleted_at IS NULL`. Retirar el mensaje deja de llevarse la
//     imagen, y lo retirado sigue enseñándose en otra pestaña.
func TestMediaOnlyShowsWhatWasSent(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	sent := uploadAttachment(t, repo, "esp-1", "sent.png")
	abandoned := uploadAttachment(t, repo, "esp-1", "abandoned.png")

	// La subida sola no enseña nada: hasta aquí, las dos están igual de subidas.
	page, err := repo.MediaOf("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("un adjunto que nadie mandó no está en el canal: %+v", page.Items)
	}

	m, err := svc.Post("esp-1", "org-1", ana, "aquí va ![la captura]("+sent.URL+")")
	if err != nil {
		t.Fatal(err)
	}
	page, err = repo.MediaOf("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != sent.ID {
		t.Fatalf("sale la que se mandó y sólo ésa: %+v", page.Items)
	}
	if page.Items[0].MessageID != m.ID {
		t.Errorf("y dice de qué línea salió, que es por donde se vuelve: %+v", page.Items[0])
	}
	_ = abandoned

	// Y retirar el mensaje se lleva su imagen, sin tocar nada más.
	if err := svc.Withdraw(m.ID, ana, false); err != nil {
		t.Fatal(err)
	}
	page, err = repo.MediaOf("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Errorf("retirar el mensaje retira lo que enseñaba: %+v", page.Items)
	}
}

// Un cuerpo no alcanza el adjunto de otro canal.
//
// El mutante que mata: quitar el `a.space_id = ?` de la consulta que carga los
// ficheros. Los ids salen de texto que alguien escribió, así que pegar una URL
// pasaría a ser una manera de listar el adjunto de otra organización.
func TestABodyCannotReachAnotherChannelsAttachment(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	fromElsewhere := uploadAttachment(t, repo, "esp-ajeno", "secreta.png")
	// El cuerpo la cita con su URL entera, tal como se pegaría.
	if _, err := svc.Post("esp-1", "org-1", ana, "mira ![esto]("+fromElsewhere.URL+")"); err != nil {
		t.Fatal(err)
	}

	page, err := repo.MediaOf("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Errorf("citar no es tener derecho: %+v", page.Items)
	}
}

// Los enlaces no dependen de cuántos mensajes volvieron.
//
// Ésta es la prueba que un diseño de cliente no pasa. Extraer los enlaces en la
// app sólo puede mirar la página que vino: con el canal paginado de cincuenta
// en cincuenta, un enlace de hace tres pantallas simplemente no existe hasta
// que alguien desliza hasta él — y nadie lo hace, porque para eso está la
// pestaña.
//
// El mutante que mata: quitar el `m.created_at < ?` de la consulta. Entonces la
// segunda página vuelve a traer la primera, para siempre.
func TestLinksDoNotDependOnHowManyMessagesCameBack(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	if _, err := svc.Post("esp-1", "org-1", ana, "el [runbook](https://x.dev/runbook) de esto"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	// Ruido por encima: sin cursor de servidor, esto es lo que tapa al de arriba.
	for i := 0; i < 5; i++ {
		if _, err := svc.Post("esp-1", "org-1", ana, "y hablamos de otra cosa"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}
	if _, err := svc.Post("esp-1", "org-1", ana, "y el https://x.dev/tablero"); err != nil {
		t.Fatal(err)
	}

	// La primera página del **hilo** sólo alcanza a ver el último mensaje…
	hilo, err := repo.List("esp-1", "", time.Time{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(hilo) != 1 {
		t.Fatalf("una línea: %+v", bodies(hilo))
	}

	// …y la pestaña, con el mismo tamaño de página, encuentra los dos enlaces
	// porque busca en el canal y no en lo que el hilo traía.
	page, err := repo.LinksOf("esp-1", "", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("los dos enlaces del canal: %+v", page.Items)
	}
	if page.Items[0].URL != "https://x.dev/tablero" || page.Items[1].URL != "https://x.dev/runbook" {
		t.Errorf("el más reciente primero: %+v", page.Items)
	}
	if page.Items[1].Label != "runbook" {
		t.Errorf("con las palabras que le pusieron, que es lo que lo hace legible: %+v", page.Items[1])
	}

	// Y el cursor avanza: la página siguiente empieza por detrás de la anterior.
	if page.Before == nil {
		t.Fatal("una página trae el sitio por donde seguir")
	}
	segunda, err := repo.LinksOf("esp-1", "", *page.Before, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(segunda.Items) != 0 {
		t.Errorf("no queda nada por detrás, y volvió %+v", segunda.Items)
	}
}

func uploadAttachment(t *testing.T, repo *repository.ChatRepository, spaceID, nombre string) *domain.ChatAttachment {
	t.Helper()
	a := &domain.ChatAttachment{SpaceID: spaceID, FileName: nombre, ContentType: "image/png", Bytes: 10}
	a.ID = uuid.NewString()
	a.URL = domain.ChatAttachmentRef(spaceID, a.ID)
	if err := repo.CreateAttachment(a); err != nil {
		t.Fatal(err)
	}
	return a
}

// Buscar dentro del canal encuentra lo que no cabe en una página.
//
// Es la razón de que el filtro esté en el servidor y no en la app. El hilo va
// paginado de cincuenta en cincuenta, así que un filtro de cliente sólo puede
// mirar lo que ya se trajo: lo dicho hace tres pantallas no aparece, y una
// búsqueda que no encuentra no dice «no está cargado», dice «no está».
//
// Los mutantes que matan: quitar el `LIKE` del cuerpo —devuelve el canal
// entero—, o dejar de pasar la consulta desde el servicio.
func TestSearchingAChannelFindsWhatAPageCannotHold(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	if _, err := svc.Post("esp-1", "org-1", ana, "el despliegue de portento se cortó"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	for i := 0; i < 5; i++ {
		if _, err := svc.Post("esp-1", "org-1", ana, "y hablamos de otra cosa"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	// La última página del hilo no alcanza a verlo…
	tail, err := svc.List("esp-1", "", time.Time{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range tail {
		if strings.Contains(m.Body, "despliegue") {
			t.Fatal("la fixture no vale: la línea buscada tiene que quedar fuera de la página")
		}
	}

	// …y buscándolo sale, con el mismo tamaño de página.
	hits, err := svc.List("esp-1", "despliegue", time.Time{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || !strings.Contains(hits[0].Body, "portento") {
		t.Fatalf("una línea y la que es: %+v", bodies(hits))
	}

	// Sin distinguir mayúsculas, que es lo que espera quien escribe deprisa.
	if hits, _ := svc.List("esp-1", "DESPLIEGUE", time.Time{}, 50); len(hits) != 1 {
		t.Errorf("buscar no distingue mayúsculas: %+v", bodies(hits))
	}
	// Y una consulta vacía sigue siendo el canal entero.
	if todo, _ := svc.List("esp-1", "   ", time.Time{}, 50); len(todo) != 6 {
		t.Errorf("sin consulta, el canal entero: %d", len(todo))
	}
}

// Buscar no se salta el canal.
//
// El mutante que mata: buscar sin el `space_id`. Con eso, escribir una palabra
// en la caja de un canal enseñaría lo que se dijo en el de otro cliente — que
// es el fallo con radio de explosión de toda esta pestaña.
func TestSearchingNeverLeavesTheChannel(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	svc := NewChatService(repository.NewChatRepository(db), nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	if _, err := svc.Post("esp-ajeno", "org-2", ana, "la clave del despliegue es secreta"); err != nil {
		t.Fatal(err)
	}
	hits, err := svc.List("esp-1", "despliegue", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Errorf("lo de otro canal no sale aquí: %+v", bodies(hits))
	}
}

// Lo que define un enlace encontrado es el enlace, no el mensaje.
//
// El `LIKE` del cuerpo es el descarte barato —la URL y su rótulo son trozos del
// cuerpo, así que nunca pierde un acierto— pero casa de más: un mensaje que
// *habla* del runbook y enlaza otra cosa entra en SQL y no es lo que se buscaba.
//
// El mutante que mata: quedarse con el acierto de SQL y no filtrar en Go.
func TestALinkHitIsTheLinkAndNotTheMessage(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	// El cuerpo dice «runbook»; el enlace no lo dice por ninguna parte.
	if _, err := svc.Post("esp-1", "org-1", ana, "el runbook está en https://x.dev/otra-cosa"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := svc.Post("esp-1", "org-1", ana, "y esto: [léelo](https://x.dev/runbook)"); err != nil {
		t.Fatal(err)
	}

	page, err := repo.LinksOf("esp-1", "runbook", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].URL != "https://x.dev/runbook" {
		t.Fatalf("sólo el enlace que casa: %+v", page.Items)
	}
	// Y el rótulo también cuenta como acierto: es lo que la persona lee.
	if p, _ := repo.LinksOf("esp-1", "léelo", time.Time{}, 50); len(p.Items) != 1 {
		t.Errorf("buscar por el rótulo encuentra su enlace: %+v", p.Items)
	}
}

// Multimedia se busca por el nombre del fichero, y ése no está en el texto.
//
// El mutante que mata: estrechar también la ventana de mensajes por el cuerpo.
// Parece inofensivo —y para enlaces lo es— pero aquí pierde aciertos en
// silencio en cuanto alguien cambia el texto alternativo de la imagen.
func TestMediaIsSearchedByFileNameNotByTheBody(t *testing.T) {
	db, cleanup := chatSystemDB(t)
	defer cleanup()
	repo := repository.NewChatRepository(db)
	svc := NewChatService(repo, nil)
	const ana = "11111111-1111-4111-8111-111111111111"

	factura := uploadAttachment(t, repo, "esp-1", "factura-septiembre.png")
	otra := uploadAttachment(t, repo, "esp-1", "pizarra.png")
	// El texto alternativo **no** dice «factura»: es lo que alguien escribió.
	if _, err := svc.Post("esp-1", "org-1", ana, "mira ![esto de aquí]("+factura.URL+")"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Post("esp-1", "org-1", ana, "y ![la factura de verdad]("+otra.URL+")"); err != nil {
		t.Fatal(err)
	}

	page, err := repo.MediaOf("esp-1", "factura", time.Time{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != factura.ID {
		t.Fatalf("manda el nombre del fichero, no lo que diga el mensaje: %+v", page.Items)
	}
}
