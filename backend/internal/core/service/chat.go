package service

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ErrNotTheAuthor: editing or withdrawing somebody else's words.
//
// The same rule the item threads apply, and for the same reason: rewriting what
// another person said is not a permission an org role should grant. A superadmin
// is the one exception, as elsewhere.
var ErrNotTheAuthor = errors.New("only the author can change this message")

// ErrNotAUserMessage: rewriting a line nobody wrote.
//
// Its own error, and checked **before** authorship, because the two refusals
// are different answers and the app renders them differently: "you are not the
// author" hides the menu on somebody else's message, this one hides it on
// everybody's. A system line that looks unforgeable and whose text anyone can
// edit is worse than not having one.
//
// A superadmin is not the exception here, unlike everywhere else: this is a
// record of something that happened, and the cleanup a superadmin does to a
// person's words has no meaning applied to it.
var ErrNotAUserMessage = errors.New("a system message is nobody's to rewrite")

// broadcast is a message about to be announced — to the bus, and to the inbox.
//
// A struct rather than eight positional arguments because the last two arrived
// together and are easy to confuse: `body` is the markdown that goes in the
// channel, `notice` the flat line that goes in the inbox. Side by side in a
// call, swapping them compiles.
type broadcast struct {
	orgID, spaceID, messageID, actorID string
	kind                               domain.ChatKind
	body                               string
	// notice is the inbox line for a message whose body can't make one.
	//
	// Empty for a person's message, where Adelanto() takes it from the body.
	// There is no markdown parser on this server and this is the honest answer
	// to that: whoever writes a system line writes both versions of it, rather
	// than the inbox showing somebody a raw `[watch it](cac:recording/…)`.
	notice   string
	mentions []string
}

type ChatService struct {
	repo     *repository.ChatRepository
	hub      *events.Hub
	notifier Notifier
}

func NewChatService(repo *repository.ChatRepository, hub *events.Hub) *ChatService {
	return &ChatService{repo: repo, hub: hub}
}

// WithNotifier records mentions, so being named survives closing the app.
// Only mentions: a channel message is for everyone in it, and an inbox row per
// person per message would turn the inbox into the channel.
func (s *ChatService) WithNotifier(n Notifier) *ChatService {
	s.notifier = n
	return s
}

// publish tells the consoles of one organization that a channel moved.
//
// Deliberately the hub and nothing else. The other publisher in this codebase,
// emitItemEvent, also dispatches the tenant's webhook — reaching for it here
// would put a private team conversation on a client's doorstep. Chat has no
// audience outside cac, so it uses the narrow path on purpose, and this comment
// is here so nobody "unifies" the two later.
//
// actorId rides along from day one. Every console in the organization hears this
// stream, including the one that just typed the message, and without a name on
// the event the app announces it back at its author — a bug this codebase found
// the hard way the day before this feature was written.
func (s *ChatService) publish(b broadcast) {
	if b.orgID == "" {
		return
	}
	// El bus y la bandeja son dos trabajos distintos, y por eso se guardan por
	// separado. Estaban bajo la misma condición: sin bus no se anotaba **ni
	// una** notificación, así que una configuración sin Valkey dejaba de avisar
	// a todo el mundo sin dar ningún error. Nadie lo habría visto hasta que
	// alguien se quejara de no enterarse de nada.
	if s.hub != nil {
		s.publicarAlStream(b)
	}
	s.anotarAvisos(b)
}

// quienHabla: el rótulo del canal y el nombre con el que firmar, **si hay
// alguien firmando**.
//
// Un mensaje del sistema no tiene autor que enseñar aunque tenga actor: la
// columna guarda a quien grabó, y anteponer ese nombre convertiría «Grabación
// lista» en «Jose: Grabación lista», que dice exactamente lo contrario de lo
// que la línea es. Se resuelve una vez y lo usan los dos caminos —el bus y la
// bandeja— para que no puedan discrepar.
func (s *ChatService) speaker(b broadcast) (channel, author string) {
	channel, author = s.repo.Rotulos(b.spaceID, b.actorID)
	if b.kind == domain.ChatKindSystem {
		return channel, ""
	}
	return channel, author
}

// laLinea: el texto de una línea de aviso, ya recortado.
//
// El del sistema llega escrito desde quien publica, porque su cuerpo es
// markdown con un enlace `cac:` dentro y ahí no hay nada que recortar que se
// lea bien.
func (b broadcast) noticeLine() string {
	if b.kind == domain.ChatKindSystem {
		return Adelanto(b.notice)
	}
	return Adelanto(b.body)
}

func (s *ChatService) publicarAlStream(b broadcast) {
	channel, author := s.speaker(b)
	s.hub.Publish(events.Event{
		Type:  "chat:message",
		OrgID: b.orgID,
		Data: map[string]any{
			"spaceId": b.spaceID, "messageId": b.messageID, "actorId": b.actorID,
			// El kind, para que el eco se filtre bien al otro lado. `actorId`
			// es quien provocó la línea, así que en una del sistema la consola
			// de esa persona la tomaría por suya y no la pintaría nunca — que
			// es justo a quien más le interesa ver que su grabación ya está.
			"kind": b.kind,
			// El canal, quién escribe y un adelanto del texto, para que el
			// aviso del sistema diga algo. Sin esto la consola sólo tenía un
			// id de espacio y anunciaba «New message in a channel».
			"spaceName": channel, "authorName": author, "preview": b.noticeLine(),
			// Who was named. Sent to the whole organization along with the rest
			// of the event — the channel is theirs to read anyway — and each
			// console decides whether it is being spoken to. Nothing private
			// travels here: these are ids of people who share this channel.
			"mentions": b.mentions,
		},
	})
}

func (s *ChatService) anotarAvisos(b broadcast) {
	if s.notifier == nil {
		return
	}
	// Con qué se rellenan los avisos. Si el canal no tiene nombre —borrado a
	// medio camino— se dice «a channel» y el aviso sigue sirviendo para algo.
	channel, author := s.speaker(b)
	where := "a channel"
	if channel != "" {
		where = "#" + channel
	}
	// «Quién: qué», que es como se lee un chat. Sin autor conocido queda sólo
	// el texto, que sigue siendo lo más informativo de los dos — y el sistema
	// no tiene autor que anteponer, ver `quienHabla`.
	line := b.noticeLine()
	if author != "" && line != "" {
		line = author + ": " + line
	} else if author != "" {
		line = author
	}
	for _, uid := range b.mentions {
		// Not the author: being told you named somebody is the app talking to
		// itself, and this codebase has already shipped that bug once.
		if uid == b.actorID {
			continue
		}
		// ViaApp fijo: hoy ninguna herramienta del MCP escribe en un canal. El
		// día que exista una, este servicio tendrá que recibir el contexto de
		// la petición — si no, un mensaje del agente se pintará como tuyo.
		s.notifier.Notify(domain.Aviso{
			UserID: uid, OrgID: b.orgID, Kind: "chat:mention",
			TitleKey:  "notify.chat.mentioned",
			TitleArgs: map[string]string{"where": where},
			Body:      line,
			Link:      "/chat?space=" + b.spaceID, Via: domain.ViaApp,
			// Mismo grupo que un mensaje corriente: una mención pasa **en el
			// canal**, no en un sitio aparte. El rótulo va sin el envoltorio,
			// que es del título de la fila y no del nombre del canal.
			Group: domain.ChannelGroup(b.spaceID), Label: where,
		})
	}

	// Y a quien sigue el canal, por lo corriente. Sólo a quien lo sigue: avisar
	// a todo el espacio de cada línea convierte la bandeja en una copia del
	// chat, y cuarenta mensajes de un canal ajeno tapan la mención que sí te
	// buscaba. Sin repetir a los ya nombrados, que acaban de recibir el suyo.
	named := make(map[string]bool, len(b.mentions))
	for _, uid := range b.mentions {
		named[uid] = true
	}
	followers, err := s.repo.Followers(b.spaceID)
	if err != nil {
		return
	}
	for _, uid := range followers {
		if uid == b.actorID || named[uid] {
			continue
		}
		// La clase de siempre, **también para el sistema**. Una `chat:system`
		// nueva no está en `Allows()`, así que caería en la casilla DESCONOCIDA
		// de las preferencias y nadie podría apagarla; y salirse del canal —que
		// es lo que alguien hace cuando no quiere saber de esto— dejaría de
		// silenciarla. Lo que se anuncia es una línea del canal, se llame como
		// se llame.
		s.notifier.Notify(domain.Aviso{
			UserID: uid, OrgID: b.orgID, Kind: "chat:message",
			Title: where, Body: line,
			Link: "/chat?space=" + b.spaceID, Via: domain.ViaApp,
			Group: domain.ChannelGroup(b.spaceID), Label: where,
		})
	}
}

// Follow / Unfollow / Following: quién quiere enterarse de lo que se hable
// aquí. La autorización por pertenencia a la organización la aplica el handler,
// igual que en el resto del módulo.
func (s *ChatService) Follow(spaceID, userID string) error {
	return s.repo.Follow(spaceID, userID)
}

func (s *ChatService) Unfollow(spaceID, userID string) error {
	return s.repo.Unfollow(spaceID, userID)
}

func (s *ChatService) Following(userID string) ([]string, error) {
	return s.repo.FollowedSpaces(userID)
}

// mentioned answers who this body actually names.
//
// The ids come out of text the author typed, so they are asserted and nothing
// more. Anyone not in this organization is dropped rather than refused: naming
// a stranger is not an error worth failing a message over, it just doesn't ping
// anybody.
func (s *ChatService) mentioned(orgID, body string) []string {
	named := domain.ExtractMentions(body)
	if len(named) == 0 {
		return nil
	}
	ok, err := s.repo.MembersOf(orgID, named)
	if err != nil {
		// A message that sends is better than a message refused because the
		// membership lookup blinked; it simply pings nobody.
		return nil
	}
	return ok
}

// List: el canal, y con `query` sólo las líneas que la contienen.
//
// Buscar **dentro de un canal** y no en toda la organización: la búsqueda
// global ya existe en la paleta, sin ancla, y ésta contesta la otra pregunta —
// «¿dónde lo dijimos, aquí?». El filtro vive en el servidor porque el hilo va
// paginado; en el cliente sólo encontraría lo de la última página.
func (s *ChatService) List(spaceID, query string, before time.Time, limit int) ([]domain.ChatMessageResponse, error) {
	return s.repo.List(spaceID, query, before, limit)
}

// Post writes a person's line. The kind is fixed here and nowhere else.
func (s *ChatService) Post(spaceID, orgID, userID, body string) (*domain.ChatMessage, error) {
	return s.write(domain.ChatKindUser, spaceID, orgID, userID, body, "")
}

// PostSystem writes a line that nobody typed.
//
// **The only door to `system`, on purpose.** ChatMessageRequest gains no field
// and Post takes no kind parameter: if the kind could arrive from outside, a
// line that claims to be from cac would be a line anybody can write, and it
// would be worth exactly as much as one that says so in its own text.
//
// Two strings because a channel and an inbox read differently. `body` is
// markdown and may carry a `cac:` link; `notice` is the flat sentence that goes
// in the notification, written by the caller because this server has no
// markdown parser to make one from the other.
//
// `actorID` is a real person: whoever's action produced the line. It is what
// makes the row legal against `not null`, what an app that predates `kind`
// signs the line with, and — because they caused it — who is not notified
// about it.
func (s *ChatService) PostSystem(spaceID, orgID, actorID, body, notice string) (*domain.ChatMessage, error) {
	return s.write(domain.ChatKindSystem, spaceID, orgID, actorID, body, notice)
}

func (s *ChatService) write(
	kind domain.ChatKind, spaceID, orgID, actorID, body, notice string,
) (*domain.ChatMessage, error) {
	m := &domain.ChatMessage{
		SpaceID: spaceID, OrgID: orgID, AuthorUserID: actorID, Body: body, Kind: kind,
	}
	m.ID = uuid.NewString()
	if err := s.repo.Create(m); err != nil {
		return nil, err
	}
	s.publish(broadcast{
		orgID: orgID, spaceID: spaceID, messageID: m.ID, actorID: actorID,
		kind: kind, body: body, notice: notice,
		// Las menciones se leen del cuerpo también aquí: si algún día una línea
		// del sistema nombra a alguien, que le llegue. Hoy ninguna lo hace.
		mentions: s.mentioned(orgID, body),
	})
	return m, nil
}

// authoredBy answers whether this caller may change this message.
func authoredBy(m *domain.ChatMessage, userID string, superadmin bool) bool {
	return m.AuthorUserID == userID || superadmin
}

func (s *ChatService) Edit(messageID, userID string, superadmin bool, body string) error {
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	// Antes que el autor, y no después: la línea del sistema lleva el id de
	// quien grabó, así que la comprobación de autoría **le diría que sí**. Ese
	// es el orden entero del asunto.
	if m.Kind != domain.ChatKindUser {
		return ErrNotAUserMessage
	}
	if !authoredBy(m, userID, superadmin) {
		return ErrNotTheAuthor
	}
	if err := s.repo.UpdateBody(messageID, body); err != nil {
		return err
	}
	// Same event as a new message: the receiver reloads the channel either way,
	// and a second event type would be two things to handle for one outcome.
	s.publish(broadcast{
		orgID: m.OrgID, spaceID: m.SpaceID, messageID: m.ID, actorID: userID,
		kind: m.Kind, body: body, mentions: s.mentioned(m.OrgID, body),
	})
	return nil
}

// RetractSystem retira el aviso del sistema que apuntaba a algo que ya no está.
//
// **Sin la guarda de `Withdraw`**, y a propósito: aquella existe para que una
// *persona* no reescriba ni borre un mensaje del sistema. Ésta la llama el
// servicio que acaba de borrar aquello de lo que el aviso hablaba, así que el
// mensaje ya no describe nada.
//
// No lleva autor ni permisos porque no los necesita: quien puede borrar una
// grabación ya pasó por su propia comprobación.
func (s *ChatService) RetractSystem(spaceID, ref string) error {
	n, err := s.repo.WithdrawSystemRef(spaceID, ref)
	if err != nil {
		return err
	}
	if n > 0 {
		lg.Info("chat: retracted " + strconv.FormatInt(n, 10) + " system notice(s) for " + ref)
	}
	return nil
}

func (s *ChatService) Withdraw(messageID, userID string, superadmin bool) error {
	m, err := s.repo.Find(messageID)
	if err != nil {
		return err
	}
	if m.Kind != domain.ChatKindUser {
		return ErrNotAUserMessage
	}
	if !authoredBy(m, userID, superadmin) {
		return ErrNotTheAuthor
	}
	if err := s.repo.Withdraw(messageID); err != nil {
		return err
	}
	// A withdrawn message names nobody: pinging over something just retracted
	// would be the opposite of retracting it.
	s.publish(broadcast{
		orgID: m.OrgID, spaceID: m.SpaceID, messageID: m.ID, actorID: userID,
		kind: m.Kind,
	})
	return nil
}

func (s *ChatService) MarkRead(spaceID, userID string) error {
	return s.repo.MarkRead(spaceID, userID)
}

func (s *ChatService) Unread(userID string, orgIDs []string, superadmin bool) ([]domain.ChatUnread, error) {
	return s.repo.UnreadBySpace(userID, orgIDs, superadmin)
}

func (s *ChatService) AddAttachment(a *domain.ChatAttachment) error {
	return s.repo.CreateAttachment(a)
}

func (s *ChatService) FindAttachment(id string) (*domain.ChatAttachment, error) {
	return s.repo.FindAttachment(id)
}

// Media y Links: las pestañas del canal, leídas de los propios cuerpos. Por qué
// no hay tabla que las guarde está en `repository/chat.go`.
func (s *ChatService) Media(spaceID, query string, before time.Time, limit int) (*domain.ChatMediaPage, error) {
	return s.repo.MediaOf(spaceID, query, before, limit)
}

func (s *ChatService) Links(spaceID, query string, before time.Time, limit int) (*domain.ChatLinkPage, error) {
	return s.repo.LinksOf(spaceID, query, before, limit)
}

// Adelanto recorta un mensaje a lo que cabe en un aviso.
//
// Tres cosas, y las tres tienen su motivo:
//
//   - **Los saltos de línea se vuelven espacios.** Un aviso es una línea; con
//     un mensaje de varios párrafos, el sistema operativo recorta por el primer
//     salto y enseña una palabra suelta.
//   - **Se cuenta en runas, no en bytes.** Cortar por bytes parte una «ñ» o una
//     tilde por la mitad y deja un carácter roto al final de cada aviso en
//     castellano. Es el clásico que sólo se ve cuando el texto no es inglés.
//   - **Se avisa del recorte con «…»**, para que nadie lea media frase creyendo
//     que es entera.
func Adelanto(cuerpo string) string {
	const tope = 140

	limpio := strings.Join(strings.Fields(cuerpo), " ")
	runas := []rune(limpio)
	if len(runas) <= tope {
		return limpio
	}
	return strings.TrimRight(string(runas[:tope]), " ") + "…"
}
