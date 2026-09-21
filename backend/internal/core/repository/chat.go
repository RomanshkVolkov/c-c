package repository

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var (
	ErrMessageNotFound = errors.New("message not found")
	// ErrChatAttachmentNotFound: asked for a file that is not in this channel.
	ErrChatAttachmentNotFound = errors.New("attachment not found")
)

type ChatRepository struct {
	db *gorm.DB
}

func NewChatRepository(db *gorm.DB) *ChatRepository { return &ChatRepository{db: db} }

// List returns the newest messages of a channel, oldest-first for rendering.
//
// Paged backwards from `before` because a channel is read from the bottom: the
// first screen is the last N lines, and scrolling up asks for what came before
// that. An offset would renumber everything each time somebody posts.
//
// `deleted_at IS NULL` is written out rather than left to GORM's scope, because
// this query names its table as a string to join the author — and Table() opts
// out of that scope silently. That exact omission shipped this week on the item
// threads: withdrawing a comment appeared to fail, the line stayed on screen,
// and trying again answered "not found" about something plainly visible.
//
// **The Select is a literal, so a new column does not appear on its own.** It
// is the standing trap of this style: the row the service just wrote comes back
// right because the service built it, and the same row reloaded comes back with
// the column at its zero value. A `kind` missing here means every system line
// re-reads as an ordinary message from the person who happened to be its actor.
// Guardian: TestTheHistoryCarriesTheKind.
//
// `query` narrows the channel to the lines that contain it — the same read,
// looked at through a slit. **Scoped to this space and resolved here**, not in
// the app: the thread is paged, so a client-side filter would only ever find
// what the last page happened to hold, which for a search is the same as
// lying. `LIKE` and not full text, per the decision already written down in
// `domain/note.go` — nothing here revisits it.
func (r *ChatRepository) List(spaceID, query string, before time.Time, limit int) ([]domain.ChatMessageResponse, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := r.db.Table("chat_messages m").
		Select(`m.id, m.space_id, m.author_user_id,
			COALESCE(u.username,'') AS author_name,
			m.kind, m.body, m.created_at, m.updated_at`).
		Joins("LEFT JOIN users u ON u.id = m.author_user_id").
		Where("m.space_id = ? AND m.deleted_at IS NULL", spaceID)
	if !before.IsZero() {
		q = q.Where("m.created_at < ?", before)
	}
	if strings.TrimSpace(query) != "" {
		q = q.Where("LOWER(m.body) LIKE ?", like(query))
	}

	out := []domain.ChatMessageResponse{}
	// Newest first for the limit, then flipped: the page we want is the tail,
	// but a channel reads top-down.
	if err := q.Order("m.created_at DESC").Limit(limit).Scan(&out).Error; err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (r *ChatRepository) Create(m *domain.ChatMessage) error { return r.db.Create(m).Error }

func (r *ChatRepository) Find(id string) (*domain.ChatMessage, error) {
	var m domain.ChatMessage
	if err := r.db.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrMessageNotFound
		}
		return nil, err
	}
	return &m, nil
}

func (r *ChatRepository) UpdateBody(id, body string) error {
	return r.db.Model(&domain.ChatMessage{}).Where("id = ?", id).Update("body", body).Error
}

// Withdraw hides a message. The row stays: what somebody wrote is not ours to
// destroy, and the read above already refuses to show it.
func (r *ChatRepository) Withdraw(id string) error {
	return r.db.Delete(&domain.ChatMessage{}, "id = ?", id).Error
}

// WithdrawSystemRef retira los avisos del sistema que apuntan a algo concreto.
//
// Borrado lógico, como el de una persona: el mensaje deja el canal y no deja el
// registro. Es lo que hace que borrar una grabación no deje en el hilo un aviso
// con el nombre de quien la hizo, apuntando a un fichero que ya no existe.
//
// Tres condiciones, y ninguna sobra:
//
//   - `kind = 'system'` — el aviso automático se retira; **un mensaje de una
//     persona que pegó el mismo enlace, no**. Sus palabras no son nuestras.
//   - `space_id = ?` — una referencia podría aparecer en otro canal.
//   - `LIKE` sobre el cuerpo: la referencia es un `cac:recording/<uuid>`, así
//     que el patrón es una constante nuestra y no un término que teclee nadie.
//
// Devuelve cuántos retiró: cero es normal —una grabación que nunca llegó a
// anunciarse— y no es un error.
func (r *ChatRepository) WithdrawSystemRef(spaceID, ref string) (int64, error) {
	res := r.db.Where("space_id = ? AND kind = ? AND body LIKE ?",
		spaceID, domain.ChatKindSystem, "%"+ref+"%").
		Delete(&domain.ChatMessage{})
	return res.RowsAffected, res.Error
}

// MarkRead moves someone's watermark in a channel to now.
func (r *ChatRepository) MarkRead(spaceID, userID string) error {
	return r.db.Exec(`
		INSERT INTO chat_reads (space_id, user_id, last_read_at)
		VALUES (?, ?, now())
		ON CONFLICT (space_id, user_id) DO UPDATE SET last_read_at = now()`,
		spaceID, userID).Error
}

// UnreadBySpace counts what each of the caller's spaces holds that they haven't
// read, in one query rather than one per space — the navigator asks for all of
// them on every load.
//
// Your own messages never count. Being told you have one unread because you just
// typed it is the same failure as being notified about your own comment, which
// this codebase spent an evening removing.
func (r *ChatRepository) UnreadBySpace(userID string, orgIDs []string, superadmin bool) ([]domain.ChatUnread, error) {
	out := []domain.ChatUnread{}
	q := r.db.Table("chat_messages m").
		Select("m.space_id, COUNT(*) AS count").
		Joins("LEFT JOIN chat_reads r ON r.space_id = m.space_id AND r.user_id = ?", userID).
		Where("m.deleted_at IS NULL").
		Where("m.author_user_id <> ?", userID).
		Where("r.last_read_at IS NULL OR m.created_at > r.last_read_at")
	if !superadmin {
		if len(orgIDs) == 0 {
			return out, nil
		}
		q = q.Where("m.org_id IN ?", orgIDs)
	}
	return out, q.Group("m.space_id").Scan(&out).Error
}

// MembersOf narrows a list of asserted user ids to the ones that actually
// belong to an organization.
//
// The ids arrive inside a message body, which is text somebody typed: nothing
// stops a caller from naming every uuid they can think of. Without this, a
// mention would be a way to ping anybody on the platform — including people at
// another client — about work they have nothing to do with.
//
// Returns them in the order asked, so the caller's list stays stable.
// Follow y Unfollow: seguir es lo que pasa por defecto, así que lo que se
// guarda es lo contrario — salirse. Idempotente en las dos direcciones: pulsar
// dos veces no es un error que merezca una pantalla roja.
//
// Los endpoints conservan su nombre y su verbo a propósito. La app es un
// binario que se actualiza a mano, y una build vieja sigue pulsando
// `POST …/follow`; lo único que cambió es qué significa la tabla por dentro.
func (r *ChatRepository) Follow(spaceID, userID string) error {
	return r.db.Where("space_id = ? AND user_id = ?", spaceID, userID).
		Delete(&domain.SpaceMute{}).Error
}

func (r *ChatRepository) Unfollow(spaceID, userID string) error {
	return r.db.Where("space_id = ? AND user_id = ?", spaceID, userID).
		FirstOrCreate(&domain.SpaceMute{SpaceID: spaceID, UserID: userID}).Error
}

// Followers son los ids a los que avisar de un mensaje corriente: todo el que
// pertenece a la organización del espacio y no se ha salido de él.
//
// La pertenencia decide, y no una lista propia, porque un espacio no tiene
// miembros suyos — cualquier miembro de la organización lo alcanza. Inventarle
// una lista sería una segunda verdad sobre quién está dentro.
// Rotulos: cómo se llama el canal y quién ha escrito.
//
// Para que un aviso diga algo. La fila de la bandeja se guardaba con el título
// «New message in a channel you follow» y el cuerpo **vacío**, así que siete
// avisos seguidos eran siete líneas idénticas: ni canal, ni autor, ni texto.
// Sin saber de dónde venían, la única forma de enterarse era abrir los canales
// uno a uno.
//
// Una sola consulta con dos subconsultas en vez de dos viajes: esto corre en el
// camino de publicar un mensaje, que es de los pocos sitios de este servicio
// donde alguien está esperando.
//
// Devuelve cadenas vacías si algo no está —un espacio borrado, un usuario que
// ya no existe— y quien llama decide el texto de reserva. Un aviso pobre es
// mejor que ninguno.
func (r *ChatRepository) Rotulos(spaceID, autorID string) (canal, autor string) {
	var fila struct {
		Canal string
		Autor string
	}
	r.db.Raw(`SELECT
			(SELECT COALESCE(name, '') FROM task_spaces WHERE id = ?) AS canal,
			(SELECT `+nombreVisible+` FROM users WHERE id = ?) AS autor`,
		spaceID, autorID).Scan(&fila)
	return fila.Canal, fila.Autor
}

func (r *ChatRepository) Followers(spaceID string) ([]string, error) {
	var ids []string
	err := r.db.Raw(`
		SELECT m.user_id
		FROM task_spaces s
		JOIN org_memberships m ON m.org_id = s.org_id
		WHERE s.id = ?
		  AND NOT EXISTS (
		        SELECT 1 FROM space_mutes x
		        WHERE x.space_id = s.id AND x.user_id = m.user_id)
	`, spaceID).Scan(&ids).Error
	return ids, err
}

// FollowedSpaces son los espacios que este usuario sigue, para que la pantalla
// pueda pintar el estado del botón sin una consulta por canal. Con la regla
// nueva: todos los de sus organizaciones menos los que silenció.
func (r *ChatRepository) FollowedSpaces(userID string) ([]string, error) {
	var ids []string
	err := r.db.Raw(`
		SELECT s.id
		FROM task_spaces s
		JOIN org_memberships m ON m.org_id = s.org_id AND m.user_id = ?
		WHERE NOT EXISTS (
		        SELECT 1 FROM space_mutes x
		        WHERE x.space_id = s.id AND x.user_id = ?)
	`, userID, userID).Scan(&ids).Error
	return ids, err
}

func (r *ChatRepository) MembersOf(orgID string, userIDs []string) ([]string, error) {
	if orgID == "" || len(userIDs) == 0 {
		return nil, nil
	}
	var found []string
	if err := r.db.Raw(`
		SELECT user_id FROM org_memberships
		WHERE org_id = ? AND user_id IN ?
	`, orgID, userIDs).Scan(&found).Error; err != nil {
		return nil, err
	}
	ok := make(map[string]bool, len(found))
	for _, id := range found {
		ok[id] = true
	}
	out := make([]string, 0, len(found))
	for _, id := range userIDs {
		if ok[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

// ─── Attachments ──────────────────────────────────────────────────────────────

func (r *ChatRepository) CreateAttachment(a *domain.ChatAttachment) error {
	return r.db.Create(a).Error
}

func (r *ChatRepository) FindAttachment(id string) (*domain.ChatAttachment, error) {
	var a domain.ChatAttachment
	if err := r.db.First(&a, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrChatAttachmentNotFound
		}
		return nil, err
	}
	return &a, nil
}

// ─── What the channel cites ───────────────────────────────────────────────────
//
// Media and links are read back out of the message bodies, and that is the
// design rather than a shortcut around a missing table. A `message_id` column on
// chat_attachments would need the composer to tell us which attachments it kept
// — it cannot, because the upload happens while the message is still being
// typed — and would leave abandoned drafts listed forever. Reading the bodies
// gives two things for free: a file that was uploaded but never sent is
// invisible by construction, and withdrawing a message takes its images with it,
// because the scan below already refuses to look at withdrawn lines.
//
// Both walk **messages**, not items, with the same `created_at <` cursor as
// List, and the SQL `LIKE` is only a cheap prefilter — what a link or an
// attachment actually is, is decided by domain/refs.go, on this side of the
// wire. Doing that extraction in the app instead would break paging (you would
// only ever see what the loaded page happened to contain), break deduplication
// across pages, lose the `[label](url)` wording, and send every body over the
// network to find a handful of URLs.

// citation es una línea viva que cita algo, con lo justo para atribuirla.
type citation struct {
	ID         string
	Body       string
	CreatedAt  time.Time
	AuthorName string
}

// citing reads a page of live messages of this channel whose body contains
// `needle`, newest first.
//
// `needle` is the prefilter and nothing more: `%http%` matches `![img](https://…)`
// and the `http` inside a word, and `%/chat/attachments/%` matches a URL somebody
// typed by hand. Both get handed to the extractor, which decides.
func (r *ChatRepository) citing(spaceID, needle, query string, before time.Time, limit int) ([]citation, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := r.db.Table("chat_messages m").
		Select(`m.id, m.body, m.created_at, COALESCE(u.username,'') AS author_name`).
		Joins("LEFT JOIN users u ON u.id = m.author_user_id").
		// deleted_at written out for the same reason as in List: Table() names
		// the table as a string and opts out of the soft-delete scope silently.
		// Without it, withdrawing a message would leave its images in the tab.
		Where("m.space_id = ? AND m.deleted_at IS NULL", spaceID).
		Where("m.body LIKE ?", "%"+needle+"%")
	if !before.IsZero() {
		q = q.Where("m.created_at < ?", before)
	}
	// Con búsqueda, la ventana se estrecha a las líneas que la contienen. Para
	// los enlaces eso es **exacto y no pierde nada**: tanto la URL como su
	// rótulo son trozos del propio cuerpo, así que un enlace que casa vive en
	// un cuerpo que casa. Para multimedia no vale —el nombre del fichero está
	// en la tabla, no en el texto— y por eso ahí se filtra en la otra consulta.
	if strings.TrimSpace(query) != "" {
		q = q.Where("LOWER(m.body) LIKE ?", like(query))
	}
	out := []citation{}
	return out, q.Order("m.created_at DESC").Limit(limit).Scan(&out).Error
}

// MediaOf lists the files the live messages of this channel show, newest first.
func (r *ChatRepository) MediaOf(spaceID, query string, before time.Time, limit int) (*domain.ChatMediaPage, error) {
	// Sin estrechar la ventana por el cuerpo: lo que se busca es el nombre del
	// fichero, y ése no tiene por qué aparecer en el texto — el editor lo pone
	// de texto alternativo, pero eso se edita. Filtrar por cuerpo perdería
	// aciertos en silencio, que es el peor fallo que puede tener una búsqueda.
	rows, err := r.citing(spaceID, "/chat/attachments/", "", before, limit)
	if err != nil {
		return nil, err
	}
	page := &domain.ChatMediaPage{Items: []domain.ChatMediaItem{}}
	if len(rows) == 0 {
		return page, nil
	}
	// Where the next page starts: the oldest line this one looked at, whether or
	// not it contributed anything.
	page.Before = &rows[len(rows)-1].CreatedAt

	// Which message first showed each file. A file shown twice is one file, and
	// it belongs to the line that introduced it.
	firstShown := map[string]citation{}
	ids := []string{}
	for _, m := range rows {
		for _, id := range domain.ExtractAttachmentIDs(m.Body) {
			if _, already := firstShown[id]; already {
				continue
			}
			firstShown[id] = m
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return page, nil
	}

	var files []domain.ChatAttachment
	// `space_id` is not decorative: the ids come out of text somebody typed, so
	// a body can name an attachment of another organization's channel. Without
	// this clause, pasting a URL would be a way to read it.
	fq := r.db.Where("id IN ? AND space_id = ?", ids, spaceID)
	if strings.TrimSpace(query) != "" {
		fq = fq.Where("LOWER(file_name) LIKE ?", like(query))
	}
	if err := fq.Find(&files).Error; err != nil {
		return nil, err
	}
	byID := make(map[string]domain.ChatAttachment, len(files))
	for _, f := range files {
		byID[f.ID] = f
	}
	// Walked over `ids` rather than over `files`, so the order stays the one the
	// channel had — IN gives no order at all.
	for _, id := range ids {
		f, ok := byID[id]
		if !ok {
			continue
		}
		m := firstShown[id]
		page.Items = append(page.Items, domain.ChatMediaItem{
			ID: f.ID, URL: f.URL, FileName: f.FileName,
			ContentType: f.ContentType, Bytes: f.Bytes,
			MessageID: m.ID, PostedAt: m.CreatedAt, AuthorName: m.AuthorName,
		})
	}
	return page, nil
}

// LinksOf lists the URLs the live messages of this channel point at, newest
// first and each one once.
func (r *ChatRepository) LinksOf(spaceID, query string, before time.Time, limit int) (*domain.ChatLinkPage, error) {
	rows, err := r.citing(spaceID, "http", query, before, limit)
	if err != nil {
		return nil, err
	}
	page := &domain.ChatLinkPage{Items: []domain.ChatLinkItem{}}
	if len(rows) == 0 {
		return page, nil
	}
	page.Before = &rows[len(rows)-1].CreatedAt

	// La consulta del cuerpo era el descarte barato; el acierto lo decide esto,
	// sobre la URL y su rótulo. Un mensaje que dice «mira el runbook» y enlaza
	// otra cosa casa en SQL y no es un enlace que buscaras.
	needle := strings.ToLower(strings.TrimSpace(query))
	matches := func(l domain.Link) bool {
		return needle == "" ||
			strings.Contains(strings.ToLower(l.URL), needle) ||
			strings.Contains(strings.ToLower(l.Label), needle)
	}
	seen := map[string]bool{}
	for _, m := range rows {
		for _, l := range domain.ExtractLinks(m.Body) {
			if seen[l.URL] || !matches(l) {
				continue
			}
			seen[l.URL] = true
			page.Items = append(page.Items, domain.ChatLinkItem{
				URL: l.URL, Label: l.Label,
				MessageID: m.ID, PostedAt: m.CreatedAt, AuthorName: m.AuthorName,
			})
		}
	}
	return page, nil
}
