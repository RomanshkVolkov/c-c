package service

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// El muro de feedback y comunicados (ver domain/post.go).

var (
	// ErrPostForbidden: no puedes publicar eso, o borrarlo. Lo que no puedes
	// **ver** contesta ErrPostNotFound, como si no existiera: un 403 diría que
	// está ahí.
	ErrPostForbidden = errors.New("post-forbidden")
	ErrPostBadCursor = errors.New("post-bad-cursor")
)

const postPageSize = 20

// postAttachmentRef: las imágenes que cita un cuerpo, por su ruta.
var postAttachmentRef = regexp.MustCompile(`/api/v1/posts/attachments/([0-9a-fA-F-]{36})/raw`)

type PostService struct {
	repo      *repository.PostRepository
	reactions *repository.ReactionRepository
	hub       *events.Hub
	inbox     Notifier
	now       func() time.Time
}

func NewPostService(repo *repository.PostRepository, reactions *repository.ReactionRepository, hub *events.Hub) *PostService {
	return &PostService{repo: repo, reactions: reactions, hub: hub, now: time.Now}
}

// WithNotifier: la campana. Sin ella (pruebas) no se avisa a nadie.
func (s *PostService) WithNotifier(n Notifier) *PostService {
	s.inbox = n
	return s
}

// canSee: quién ve una publicación. La única regla, y la usan todas las rutas;
// el listado la repite en SQL (repository/post.go) y una prueba compara las dos.
//
//   - un comunicado, cualquiera con sesión;
//   - «para todos», cualquiera que sea de alguna organización;
//   - «sólo para cac», los de su organización y los superadmins.
func canSee(p *domain.Post, c *domain.ClaimsJWT) bool {
	if c.Superadmin || p.Kind == domain.PostAnnouncement {
		return true
	}
	if p.Audience == domain.AudienceEveryone {
		return len(c.Orgs) > 0
	}
	_, member := c.RoleInOrg(p.OrgID)
	return member
}

// canDelete: quien la escribió, el admin de su organización o un superadmin.
func canDelete(p *domain.Post, c *domain.ClaimsJWT) bool {
	if c.Superadmin || p.AuthorID == c.UserID {
		return true
	}
	role, member := c.RoleInOrg(p.OrgID)
	return member && p.OrgID != "" && role == domain.OrgRoleAdmin
}

// canEdit: sólo quien la escribió. Moderar es borrar, no reescribir lo que
// dijo otra persona.
func canEdit(p *domain.Post, c *domain.ClaimsJWT) bool {
	return p.AuthorID == c.UserID
}

func (s *PostService) visible(id string, c *domain.ClaimsJWT) (*repository.PostRow, error) {
	row, err := s.repo.Find(id)
	if err != nil {
		return nil, err
	}
	if !canSee(&row.Post, c) {
		return nil, repository.ErrPostNotFound
	}
	return row, nil
}

// List: el muro de quien mira, de 20 en 20.
func (s *PostService) List(c *domain.ClaimsJWT, cursor string) (*domain.PostPage, error) {
	after, err := parsePostCursor(cursor)
	if err != nil {
		return nil, err
	}
	orgs := make([]string, 0, len(c.Orgs))
	for _, o := range c.Orgs {
		orgs = append(orgs, o.OrgID)
	}
	rows, err := s.repo.List(orgs, c.Superadmin, after, postPageSize)
	if err != nil {
		return nil, err
	}
	out, err := s.responses(rows, c)
	if err != nil {
		return nil, err
	}
	page := &domain.PostPage{Posts: out}
	if len(rows) == postPageSize {
		last := rows[len(rows)-1]
		page.NextCursor = fmt.Sprintf("%d|%d|%s", repository.WallLead(&last.Post), last.CreatedAt.UnixNano(), last.ID)
	}
	return page, nil
}

func parsePostCursor(raw string) (*repository.PostCursor, error) {
	if raw == "" {
		return nil, nil
	}
	parts := strings.SplitN(raw, "|", 3)
	if len(parts) != 3 {
		return nil, ErrPostBadCursor
	}
	lead, err1 := strconv.Atoi(parts[0])
	ns, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || lead < 0 || lead > 3 {
		return nil, ErrPostBadCursor
	}
	return &repository.PostCursor{Lead: lead, At: time.Unix(0, ns), ID: parts[2]}, nil
}

func (s *PostService) responses(rows []repository.PostRow, c *domain.ClaimsJWT) ([]domain.PostResponse, error) {
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	reactions, err := s.reactions.Summaries(domain.ReactionPost, ids, c.UserID)
	if err != nil {
		return nil, err
	}
	seen := s.repo.SeenAt(c.UserID)
	out := make([]domain.PostResponse, len(rows))
	for i, r := range rows {
		out[i] = domain.PostResponse{
			ID: r.ID, Kind: r.Kind, Audience: r.Audience, OrgID: r.OrgID, OrgName: r.OrgName,
			AuthorID: r.AuthorID, AuthorName: r.AuthorName, Title: r.Title, Body: r.Body,
			CreatedAt: r.CreatedAt, Comments: r.Comments, Reactions: reactions[r.ID],
			// Lo tuyo nunca es nuevo para ti.
			Unseen:    r.AuthorID != c.UserID && r.CreatedAt.After(seen),
			CanDelete: canDelete(&r.Post, c),
			CanEdit:   canEdit(&r.Post, c),
			CanPin:    c.Superadmin,
			Pinned:    r.PinnedAt != nil,
			EditedAt:  r.EditedAt,
		}
		if out[i].Reactions == nil {
			out[i].Reactions = []domain.ReactionSummary{}
		}
	}
	return out, nil
}

// Get: una publicación con sus comentarios.
func (s *PostService) Get(c *domain.ClaimsJWT, id string) (*domain.PostDetailResponse, error) {
	row, err := s.visible(id, c)
	if err != nil {
		return nil, err
	}
	resp, err := s.responses([]repository.PostRow{*row}, c)
	if err != nil {
		return nil, err
	}
	comments, err := s.repo.Comments(id)
	if err != nil {
		return nil, err
	}
	commentIDs := make([]string, len(comments))
	for i := range comments {
		commentIDs[i] = comments[i].ID
	}
	commentReactions, err := s.reactions.Summaries(domain.ReactionPostComment, commentIDs, c.UserID)
	if err != nil {
		return nil, err
	}
	for i := range comments {
		comments[i].CanDelete = comments[i].AuthorID == c.UserID || canDelete(&row.Post, c)
		comments[i].Reactions = commentReactions[comments[i].ID]
		if comments[i].Reactions == nil {
			comments[i].Reactions = []domain.ReactionSummary{}
		}
	}
	if comments == nil {
		comments = []domain.PostCommentResponse{}
	}
	return &domain.PostDetailResponse{PostResponse: resp[0], CommentList: comments}, nil
}

// Create publica. Un comunicado, sólo un superadmin, y es de todos; un
// feedback, un admin o un miembro de la organización en cuyo nombre se publica.
func (s *PostService) Create(c *domain.ClaimsJWT, req domain.CreatePostRequest) (*domain.PostDetailResponse, error) {
	p := &domain.Post{AuthorID: c.UserID, Kind: req.Kind, Title: strings.TrimSpace(req.Title), Body: req.Body}
	p.ID = uuid.NewString()
	switch req.Kind {
	case domain.PostAnnouncement:
		if !c.Superadmin {
			return nil, ErrPostForbidden
		}
		p.Audience = domain.AudienceEveryone
	default:
		role, member := c.RoleInOrg(req.OrgID)
		if !member || (role != domain.OrgRoleAdmin && role != domain.OrgRoleMember) {
			return nil, ErrPostForbidden
		}
		p.OrgID = req.OrgID
		p.Audience = req.Audience
		if p.Audience == "" {
			p.Audience = domain.AudiencePlatform
		}
	}
	if err := s.repo.Create(p, citedAttachments(p.Body)); err != nil {
		return nil, err
	}
	s.publish(p, "post:new", map[string]string{"postId": p.ID, "actorId": c.UserID})
	if p.Kind == domain.PostFeedback {
		s.notifyFeedback(p)
	}
	return s.Get(c, p.ID)
}

// notifyFeedback: el feedback nuevo es para el equipo de cac.
func (s *PostService) notifyFeedback(p *domain.Post) {
	if s.inbox == nil {
		return
	}
	row, err := s.repo.Find(p.ID)
	if err != nil {
		return
	}
	admins, _ := s.repo.SuperadminIDs()
	for _, uid := range admins {
		if uid == p.AuthorID {
			continue
		}
		s.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: p.OrgID, Kind: "post:feedback",
			TitleKey: "notify.post.feedback", TitleArgs: map[string]string{"org": row.OrgName},
			Body: postExcerpt(p), Link: "/feedback?post=" + p.ID, Via: domain.ViaApp,
			Group: domain.PostGroup(p.ID), Label: row.OrgName,
		})
	}
}

// Update: su autor cambia el título, el texto o, en un feedback, la audiencia.
// Queda marcada como editada.
func (s *PostService) Update(c *domain.ClaimsJWT, id string, req domain.UpdatePostRequest) (*domain.PostDetailResponse, error) {
	row, err := s.visible(id, c)
	if err != nil {
		return nil, err
	}
	if !canEdit(&row.Post, c) {
		return nil, ErrPostForbidden
	}
	now := s.now()
	fields := map[string]any{"edited_at": now}
	body := row.Body
	if req.Title != nil {
		fields["title"] = strings.TrimSpace(*req.Title)
	}
	if req.Body != nil {
		fields["body"] = *req.Body
		body = *req.Body
	}
	if req.Audience != nil && row.Kind == domain.PostFeedback {
		fields["audience"] = *req.Audience
	}
	if err := s.repo.Update(id, c.UserID, fields, citedAttachments(body)); err != nil {
		return nil, err
	}
	// A quien la veía antes y a quien la ve ahora: cambiar la audiencia mueve
	// quién la tiene en pantalla.
	updated := row.Post
	if a, ok := fields["audience"].(string); ok {
		updated.Audience = a
	}
	s.publish(&row.Post, "post:updated", map[string]string{"postId": id, "actorId": c.UserID})
	if updated.Audience != row.Audience {
		s.publish(&updated, "post:updated", map[string]string{"postId": id, "actorId": c.UserID})
	}
	return s.Get(c, id)
}

// Pin: sólo un superadmin fija, porque lo fijado va arriba del muro de todos
// los que lo ven.
func (s *PostService) Pin(c *domain.ClaimsJWT, id string, pinned bool) (*domain.PostDetailResponse, error) {
	if !c.Superadmin {
		return nil, ErrPostForbidden
	}
	row, err := s.visible(id, c)
	if err != nil {
		return nil, err
	}
	var at *time.Time
	if pinned {
		now := s.now()
		at = &now
	}
	if err := s.repo.SetPinned(id, at); err != nil {
		return nil, err
	}
	s.publish(&row.Post, "post:updated", map[string]string{"postId": id, "actorId": c.UserID})
	return s.Get(c, id)
}

func (s *PostService) Delete(c *domain.ClaimsJWT, id string) error {
	row, err := s.visible(id, c)
	if err != nil {
		return err
	}
	if !canDelete(&row.Post, c) {
		return ErrPostForbidden
	}
	if err := s.repo.Delete(id); err != nil {
		return err
	}
	s.publish(&row.Post, "post:deleted", map[string]string{"postId": id, "actorId": c.UserID})
	return nil
}

// Comment: comentar es para quien ve la publicación, también un viewer.
func (s *PostService) Comment(c *domain.ClaimsJWT, id string, req domain.CreatePostCommentRequest) (*domain.PostDetailResponse, error) {
	row, err := s.visible(id, c)
	if err != nil {
		return nil, err
	}
	before, _ := s.repo.CommenterIDs(id)
	cm := &domain.PostComment{PostID: id, AuthorID: c.UserID, Body: req.Body}
	cm.ID = uuid.NewString()
	if err := s.repo.AddComment(cm, citedAttachments(req.Body)); err != nil {
		return nil, err
	}
	s.publish(&row.Post, "post:comment", map[string]string{"postId": id, "actorId": c.UserID})
	s.notifyComment(row, cm, before)
	return s.Get(c, id)
}

// notifyComment: al autor de la publicación y a quienes ya comentaron, menos a
// quien comenta. Sólo a quien todavía la puede ver: alguien que comentó y se
// fue de la organización no recibe lo que ya no puede abrir.
func (s *PostService) notifyComment(row *repository.PostRow, cm *domain.PostComment, before []string) {
	if s.inbox == nil {
		return
	}
	actor := s.repo.DisplayName(cm.AuthorID)
	targets := append([]string{row.AuthorID}, before...)
	seen := map[string]bool{cm.AuthorID: true}
	for _, uid := range targets {
		if seen[uid] {
			continue
		}
		seen[uid] = true
		if !s.repo.StillSees(uid, &row.Post) {
			continue
		}
		s.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: row.OrgID, Kind: "post:comment",
			TitleKey: "notify.post.comment", TitleArgs: map[string]string{"who": actor},
			Body: postExcerpt(&row.Post), Link: "/feedback?post=" + row.ID, Via: domain.ViaApp,
			Group: domain.PostGroup(row.ID), Label: row.OrgName,
		})
	}
}

func (s *PostService) DeleteComment(c *domain.ClaimsJWT, postID, commentID string) error {
	row, err := s.visible(postID, c)
	if err != nil {
		return err
	}
	cm, err := s.repo.FindComment(postID, commentID)
	if err != nil {
		return err
	}
	if cm.AuthorID != c.UserID && !canDelete(&row.Post, c) {
		return ErrPostForbidden
	}
	if err := s.repo.DeleteComment(commentID); err != nil {
		return err
	}
	s.publish(&row.Post, "post:comment", map[string]string{"postId": postID, "actorId": c.UserID})
	return nil
}

// React: como en el chat. Quién puede se mira contra la publicación.
func (s *PostService) React(c *domain.ClaimsJWT, id string, req domain.ReactionRequest) error {
	if !domain.ValidReaction(req.Emoji) {
		return ErrBadReaction
	}
	row, err := s.visible(id, c)
	if err != nil {
		return err
	}
	if err := s.reactions.Set(domain.ReactionPost, id, c.UserID, req.Emoji, req.On); err != nil {
		return err
	}
	s.publish(&row.Post, "post:reaction", map[string]string{"postId": id, "actorId": c.UserID})
	return nil
}

// ReactComment: reaccionar a un comentario es para quien ve la publicación,
// y el comentario tiene que ser de ella.
func (s *PostService) ReactComment(c *domain.ClaimsJWT, postID, commentID string, req domain.ReactionRequest) error {
	if !domain.ValidReaction(req.Emoji) {
		return ErrBadReaction
	}
	row, err := s.visible(postID, c)
	if err != nil {
		return err
	}
	if _, err := s.repo.FindComment(postID, commentID); err != nil {
		return err
	}
	if err := s.reactions.Set(domain.ReactionPostComment, commentID, c.UserID, req.Emoji, req.On); err != nil {
		return err
	}
	s.publish(&row.Post, "post:reaction", map[string]string{"postId": postID, "commentId": commentID, "actorId": c.UserID})
	return nil
}

func (s *PostService) MarkSeen(c *domain.ClaimsJWT) error {
	return s.repo.MarkSeen(c.UserID, s.now())
}

// SaveAttachment guarda una imagen recién subida. Todavía sin publicación: la
// engancha publicar o comentar, si su cuerpo la cita.
func (s *PostService) SaveAttachment(a *domain.PostAttachment) error {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	a.URL = domain.PostAttachmentRef(a.ID)
	return s.repo.CreateAttachment(a)
}

// Attachment: la imagen, si quien la pide puede verla. Sin publicación, sólo
// quien la subió; con ella, quien vea la publicación.
func (s *PostService) Attachment(c *domain.ClaimsJWT, id string) (*domain.PostAttachment, error) {
	a, err := s.repo.FindAttachment(id)
	if err != nil {
		return nil, err
	}
	if a.PostID == "" {
		if a.UploadedBy != c.UserID {
			return nil, repository.ErrPostNotFound
		}
		return a, nil
	}
	if _, err := s.visible(a.PostID, c); err != nil {
		return nil, err
	}
	return a, nil
}

// publish: lo de todos, a todos; lo de «sólo para cac», a su organización (los
// superadmins lo reciben igual). Sólo ids: quien lo recibe pide lo que vea, así
// el stream nunca trae algo que no pueda ver.
func (s *PostService) publish(p *domain.Post, kind string, data map[string]string) {
	if s.hub == nil {
		return
	}
	if p.Kind == domain.PostAnnouncement || p.Audience == domain.AudienceEveryone {
		s.hub.Publish(events.Event{Type: kind, Broadcast: true, Data: data})
		return
	}
	s.hub.Publish(events.Event{Type: kind, OrgID: p.OrgID, Data: data})
}

func citedAttachments(body string) []string {
	var ids []string
	for _, m := range postAttachmentRef.FindAllStringSubmatch(body, -1) {
		ids = append(ids, strings.ToLower(m[1]))
	}
	return ids
}

// postExcerpt: el título, o la primera línea del cuerpo.
func postExcerpt(p *domain.Post) string {
	if p.Title != "" {
		return p.Title
	}
	return firstLine(p.Body)
}
