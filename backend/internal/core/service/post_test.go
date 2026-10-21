package service

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
El muro de feedback y comunicados (19-oct-2026, #189).

Lo que no se negocia es quién ve qué: un feedback «sólo para cac» de una
organización no lo puede leer otra, ni en el muro, ni abriéndolo, ni
comentando, ni reaccionando, ni pidiendo sus imágenes. Una sola regla
(`canSee`) y el listado la repite en SQL; esta matriz mira las dos.

La gente: ana (admin de org-1), bea (miembro de org-1), vic (viewer de org-1),
dani (miembro de org-2), root (superadmin, sin org) y solo (sin org).
*/

type wallPerson struct {
	id     string
	claims *domain.ClaimsJWT
}

type wallFixture struct {
	db     *gorm.DB
	svc    *PostService
	bell   *avisosEspia
	now    time.Time
	people map[string]wallPerson
}

type avisosEspia struct{ got []domain.Aviso }

func (a *avisosEspia) Notify(n domain.Aviso) { a.got = append(a.got, n) }

func (a *avisosEspia) to(kind string) []string {
	var out []string
	for _, n := range a.got {
		if n.Kind == kind {
			out = append(out, n.UserID)
		}
	}
	sort.Strings(out)
	return out
}

func wallSetup(t *testing.T) *wallFixture {
	t.Helper()
	if repository.GetEnv("DB_HOST", "") == "" {
		t.Skip("no database configured")
	}
	dsn := func(name string) string {
		return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
			repository.GetEnv("DB_HOST", "localhost"), repository.GetEnv("DB_PORT", "5432"),
			repository.GetEnv("DB_USER", "postgres"), repository.GetEnv("DB_PASSWORD", ""),
			name, repository.GetEnv("DB_SSLMODE", "disable"))
	}
	admin, err := gorm.Open(postgres.Open(dsn(repository.GetEnv("DB_NAME", "cac"))), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("DB_HOST is set but the database does not answer (a skipped test is not a green one): %v", err)
	}
	name := fmt.Sprintf("cac_test_wall_%d", time.Now().UnixNano())
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		t.Fatalf("DB_HOST is set but a throwaway database cannot be created: %v", err)
	}
	db, err := gorm.Open(postgres.Open(dsn(name)), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if inner, _ := db.DB(); inner != nil {
			inner.Close()
		}
		admin.Exec("DROP DATABASE IF EXISTS " + name)
		if inner, _ := admin.DB(); inner != nil {
			inner.Close()
		}
	})
	if err := db.AutoMigrate(&domain.User{}, &domain.Organization{}, &domain.OrgMembership{}, &domain.Post{},
		&domain.PostComment{}, &domain.PostAttachment{}, &domain.PostRead{}, &domain.ChatReaction{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	type persona struct {
		id, username, name string
		super              bool
		orgs               []domain.OrgMembershipClaim
	}
	gente := []persona{
		{"u-ana", "ana", "Ana", false, []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleAdmin}}},
		{"u-bea", "bea", "Bea", false, []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleMember}}},
		{"u-vic", "vic", "Vic", false, []domain.OrgMembershipClaim{{OrgID: "org-1", Role: domain.OrgRoleViewer}}},
		{"u-dani", "dani", "Dani", false, []domain.OrgMembershipClaim{{OrgID: "org-2", Role: domain.OrgRoleMember}}},
		{"u-root", "root", "Root", true, nil},
		{"u-solo", "solo", "Solo", false, nil},
	}
	f := &wallFixture{db: db, bell: &avisosEspia{}, now: now, people: map[string]wallPerson{}}
	must := func(q *gorm.DB) {
		t.Helper()
		if q.Error != nil {
			t.Fatal(q.Error)
		}
	}
	must(db.Exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org-1','Uno','uno',?,?), ('org-2','Dos','dos',?,?)`, now, now, now, now))
	for _, p := range gente {
		must(db.Exec(`INSERT INTO users (id, username, name, password, is_superadmin, created_at, updated_at) VALUES (?,?,?,'x',?,?,?)`,
			p.id, p.username, p.name, p.super, now, now))
		for _, o := range p.orgs {
			must(db.Exec(`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)`, o.OrgID, p.id, o.Role, now))
		}
		f.people[p.username] = wallPerson{id: p.id, claims: &domain.ClaimsJWT{UserID: p.id, Username: p.username, Superadmin: p.super, Orgs: p.orgs}}
	}
	f.svc = NewPostService(repository.NewPostRepository(db), repository.NewReactionRepository(db), nil).WithNotifier(f.bell)
	f.svc.now = func() time.Time { return f.now }
	return f
}

func (f *wallFixture) as(name string) *domain.ClaimsJWT { return f.people[name].claims }

func (f *wallFixture) post(t *testing.T, who string, req domain.CreatePostRequest) string {
	t.Helper()
	out, err := f.svc.Create(f.as(who), "", req)
	if err != nil {
		t.Fatalf("%s no pudo publicar: %v", who, err)
	}
	return out.ID
}

func titles(page *domain.PostPage) []string {
	var out []string
	for _, p := range page.Posts {
		out = append(out, p.Title)
	}
	return out
}

// La matriz: cada persona ve exactamente lo suyo en el muro, y lo que no ve
// tampoco lo abre, comenta, reacciona ni le sirve una imagen. Mutantes: que
// «para todos» lo vea también quien no es de ninguna org; que «sólo para cac»
// lo vea otra org (en canSee y, aparte, en el SQL del listado); que el
// superadmin no vea lo «sólo para cac».
func TestWhoSeesWhatOnTheWall(t *testing.T) {
	f := wallSetup(t)
	img := &domain.PostAttachment{UploadedBy: "u-bea", Path: "posts/x", FileName: "x.png"}
	if err := f.svc.SaveAttachment(img); err != nil {
		t.Fatal(err)
	}
	f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Title: "comunicado", Body: "hola a todos"})
	plat := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Audience: domain.AudiencePlatform,
		Title: "solo cac", Body: "![x](" + img.URL + ")"})
	everyone := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Audience: domain.AudienceEveryone, Title: "para todos", Body: "b"})

	want := map[string][]string{
		"ana":  {"comunicado", "para todos", "solo cac"},
		"vic":  {"comunicado", "para todos", "solo cac"},
		"dani": {"comunicado", "para todos"},
		"root": {"comunicado", "para todos", "solo cac"},
		"solo": {"comunicado"},
	}
	for who, titulos := range want {
		page, err := f.svc.List(f.as(who), "")
		if err != nil {
			t.Fatal(err)
		}
		got := titles(page)
		if got[0] != "comunicado" {
			t.Errorf("%s: el comunicado no va primero: %v", who, got)
		}
		sort.Strings(got)
		if strings.Join(got, ",") != strings.Join(titulos, ",") {
			t.Errorf("%s ve %v, debería ver %v", who, got, titulos)
		}
		sees, seesAll := false, false
		for _, x := range titulos {
			sees = sees || x == "solo cac"
			seesAll = seesAll || x == "para todos"
		}
		if _, err := f.svc.Get(f.as(who), everyone); seesAll != (err == nil) {
			t.Errorf("%s: abrir «para todos» → %v (debería verla: %v)", who, err, seesAll)
		}
		_, errGet := f.svc.Get(f.as(who), plat)
		_, errComment := f.svc.Comment(f.as(who), "", plat, domain.CreatePostCommentRequest{Body: "hola"})
		errReact := f.svc.React(f.as(who), plat, domain.ReactionRequest{Emoji: "👍", On: true})
		_, errImg := f.svc.Attachment(f.as(who), img.ID)
		for what, err := range map[string]error{"abrirlo": errGet, "comentarlo": errComment, "reaccionar": errReact, "su imagen": errImg} {
			if sees && err != nil {
				t.Errorf("%s ve «solo cac» en el muro pero no puede %s: %v", who, what, err)
			}
			if !sees && !errors.Is(err, repository.ErrPostNotFound) {
				t.Errorf("%s no debería poder %s de «solo cac» → %v", who, what, err)
			}
		}
	}
}

// Publicar: feedback, un admin o un miembro de la org en cuyo nombre se
// publica; un comunicado, sólo un superadmin. Mutantes: dejar publicar a un
// viewer; no mirar que sea de esa org; dejar publicar comunicados a cualquiera.
func TestWhoCanPublish(t *testing.T) {
	f := wallSetup(t)
	fb := func(org string) domain.CreatePostRequest {
		return domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: org, Body: "x"}
	}
	cases := []struct {
		who string
		req domain.CreatePostRequest
		ok  bool
	}{
		{"ana", fb("org-1"), true},
		{"bea", fb("org-1"), true},
		{"vic", fb("org-1"), false},
		{"dani", fb("org-1"), false},
		{"bea", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"}, false},
		{"root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"}, true},
	}
	for _, c := range cases {
		out, err := f.svc.Create(f.as(c.who), "", c.req)
		if c.ok && err != nil {
			t.Errorf("%s (%s) no pudo publicar: %v", c.who, c.req.Kind, err)
		}
		if !c.ok && !errors.Is(err, ErrPostForbidden) {
			t.Errorf("%s (%s) publicó y no debía → %v", c.who, c.req.Kind, err)
		}
		if c.ok && c.req.Kind == domain.PostFeedback && out.Audience != domain.AudiencePlatform {
			t.Errorf("sin elegir, la audiencia es «sólo para cac»; salió %q", out.Audience)
		}
		if c.ok && c.req.Kind == domain.PostAnnouncement && (out.Audience != domain.AudienceEveryone || out.OrgID != "") {
			t.Errorf("un comunicado es de todos y de ninguna org: %+v", out.PostResponse)
		}
	}
}

// Borrar: el autor, el admin de la org y el superadmin; un viewer de la misma
// org no. Y se lleva comentarios, reacciones e imágenes. Mutantes: dejar borrar
// a cualquier miembro; no borrar las reacciones.
func TestWhoCanDeleteAndWhatGoesWithIt(t *testing.T) {
	f := wallSetup(t)
	mk := func() string {
		return f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Body: "x"})
	}
	id := mk()
	if err := f.svc.Delete(f.as("vic"), id); !errors.Is(err, ErrPostForbidden) {
		t.Fatalf("un viewer borró → %v", err)
	}
	for _, who := range []string{"bea", "ana", "root"} {
		id := mk()
		if _, err := f.svc.Comment(f.as("vic"), "", id, domain.CreatePostCommentRequest{Body: "c"}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.React(f.as("vic"), id, domain.ReactionRequest{Emoji: "🎉", On: true}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.Delete(f.as(who), id); err != nil {
			t.Fatalf("%s no pudo borrar: %v", who, err)
		}
		var comments, reactions int64
		f.db.Model(&domain.PostComment{}).Where("post_id = ?", id).Count(&comments)
		f.db.Model(&domain.ChatReaction{}).Where("message_id = ?", id).Count(&reactions)
		if comments != 0 || reactions != 0 {
			t.Fatalf("al borrar quedaron %d comentarios y %d reacciones", comments, reactions)
		}
	}
	// Un comentario lo borra su autor; el de otro, sólo quien modera.
	id = mk()
	out, _ := f.svc.Comment(f.as("vic"), "", id, domain.CreatePostCommentRequest{Body: "de vic"})
	cid := out.CommentList[0].ID
	if err := f.svc.DeleteComment(f.as("bea"), id, cid); err != nil {
		t.Fatalf("la autora de la publicación no pudo borrar un comentario: %v", err)
	}
	out, _ = f.svc.Comment(f.as("ana"), "", id, domain.CreatePostCommentRequest{Body: "de ana"})
	if err := f.svc.DeleteComment(f.as("vic"), id, out.CommentList[0].ID); !errors.Is(err, ErrPostForbidden) {
		t.Fatalf("un viewer borró el comentario de otra → %v", err)
	}
}

// Los avisos: el feedback nuevo, a los superadmins (y no a la org); un
// comentario, al autor y a quienes ya comentaron, nunca a quien comenta ni a
// quien ya no la puede ver. Mutantes: avisar a la org del feedback; avisar a
// quien comenta; no mirar si aún la ve.
func TestWhoHearsAboutWhat(t *testing.T) {
	f := wallSetup(t)
	id := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Title: "idea", Body: "x"})
	if got := f.bell.to("post:feedback"); strings.Join(got, ",") != "u-root" {
		t.Fatalf("el feedback nuevo avisó a %v", got)
	}
	if _, err := f.svc.Comment(f.as("ana"), "", id, domain.CreatePostCommentRequest{Body: "primero"}); err != nil {
		t.Fatal(err)
	}
	if got := f.bell.to("post:comment"); strings.Join(got, ",") != "u-bea" {
		t.Fatalf("el primer comentario avisó a %v", got)
	}
	// La autora contesta: le llega a ana (que comentó), no a ella misma.
	f.bell.got = nil
	if _, err := f.svc.Comment(f.as("bea"), "", id, domain.CreatePostCommentRequest{Body: "gracias"}); err != nil {
		t.Fatal(err)
	}
	if got := f.bell.to("post:comment"); strings.Join(got, ",") != "u-ana" {
		t.Fatalf("la respuesta de la autora avisó a %v", got)
	}
	f.bell.got = nil
	// Ana se va de la org: ya no ve la publicación, y no se le avisa.
	f.db.Exec(`DELETE FROM org_memberships WHERE user_id = 'u-ana'`)
	if _, err := f.svc.Comment(f.as("vic"), "", id, domain.CreatePostCommentRequest{Body: "segundo"}); err != nil {
		t.Fatal(err)
	}
	if got := f.bell.to("post:comment"); strings.Join(got, ",") != "u-bea" {
		t.Fatalf("el segundo comentario avisó a %v (ana ya no está)", got)
	}
	// Un comunicado no va a la campana de nadie.
	f.bell.got = nil
	f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"})
	if len(f.bell.got) != 0 {
		t.Fatalf("un comunicado llenó la campana: %v", f.bell.got)
	}
}

// «Nuevo»: lo publicado después de la última vez que abriste el muro, menos
// lo tuyo. Mutantes: no guardar la fecha; marcar nuevo lo propio.
func TestWhatIsNewOnTheWall(t *testing.T) {
	f := wallSetup(t)
	// Con el reloj de verdad: la fecha de una publicación la pone la base.
	f.svc.now = time.Now
	f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Title: "viejo", Body: "x"})
	time.Sleep(10 * time.Millisecond)
	if err := f.svc.MarkSeen(f.as("bea")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Title: "nuevo", Body: "x"})
	f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Title: "mío", Body: "x"})
	page, _ := f.svc.List(f.as("bea"), "")
	for _, p := range page.Posts {
		if want := p.Title == "nuevo"; p.Unseen != want {
			t.Errorf("«%s»: unseen=%v", p.Title, p.Unseen)
		}
	}
}

// Las imágenes: antes de publicar sólo las ve quien las subió, y citar la de
// otra persona no te la da. Mutante: enganchar cualquier imagen citada.
func TestAnImageIsOnlyClaimedByItsUploader(t *testing.T) {
	f := wallSetup(t)
	img := &domain.PostAttachment{UploadedBy: "u-bea", Path: "posts/x", FileName: "x.png"}
	if err := f.svc.SaveAttachment(img); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Attachment(f.as("ana"), img.ID); !errors.Is(err, repository.ErrPostNotFound) {
		t.Fatalf("una imagen sin publicar la ve otra persona → %v", err)
	}
	f.post(t, "dani", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-2", Audience: domain.AudienceEveryone,
		Body: "robada ![x](" + img.URL + ")"})
	if _, err := f.svc.Attachment(f.as("dani"), img.ID); !errors.Is(err, repository.ErrPostNotFound) {
		t.Fatalf("citar la imagen de otra persona te la da → %v", err)
	}
	if _, err := f.svc.Attachment(f.as("bea"), img.ID); err != nil {
		t.Fatalf("quien la subió ya no la ve: %v", err)
	}
}

// De 20 en 20, con los comunicados primero, sin saltarse ni repetir nada al
// pasar de página. Mutante: paginar sólo por fecha (la segunda página repite o
// se salta lo que el orden por comunicado movió).
func TestTheWallPagesWithoutGapsOrRepeats(t *testing.T) {
	f := wallSetup(t)
	// El comunicado, el más viejo: va primero igual, y es justo el caso en que
	// paginar sólo por fecha lo vuelve a traer en la segunda página.
	f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Title: "anuncio", Body: "x"})
	var oldest string
	for i := 0; i < 22; i++ {
		id := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Title: fmt.Sprint("fb", i), Body: "x"})
		if i == 0 {
			oldest = id
		}
	}
	// Y el feedback más viejo, fijado: va delante incluso del comunicado.
	if _, err := f.svc.Pin(f.as("root"), oldest, true); err != nil {
		t.Fatal(err)
	}
	first, err := f.svc.List(f.as("bea"), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Posts) != 20 || first.Posts[0].Title != "fb0" || !first.Posts[0].Pinned || first.Posts[1].Title != "anuncio" || first.NextCursor == "" {
		t.Fatalf("primera página: %d, primeros %q y %q, cursor %q", len(first.Posts), first.Posts[0].Title, first.Posts[1].Title, first.NextCursor)
	}
	second, err := f.svc.List(f.as("bea"), first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range append(first.Posts, second.Posts...) {
		if seen[p.ID] {
			t.Fatalf("«%s» salió dos veces", p.Title)
		}
		seen[p.ID] = true
	}
	if len(seen) != 23 || second.NextCursor != "" {
		t.Fatalf("entre las dos páginas salieron %d de 23 (cursor final %q)", len(seen), second.NextCursor)
	}
}

// Editar es de quien la escribió: ni el admin de su org ni un superadmin
// reescriben lo que dijo otra persona (moderar es borrar). Cambiar la
// audiencia cambia quién la ve, y un comunicado sigue siendo de todos.
// Mutantes: dejar editar al admin; no marcarla como editada; dejar que un
// comunicado deje de ser de todos.
func TestOnlyTheAuthorEditsAPost(t *testing.T) {
	f := wallSetup(t)
	id := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Title: "antes", Body: "x"})
	title, everyone := "después", domain.AudienceEveryone
	for _, who := range []string{"ana", "root"} {
		if _, err := f.svc.Update(f.as(who), id, domain.UpdatePostRequest{Title: &title}); !errors.Is(err, ErrPostForbidden) {
			t.Fatalf("%s editó la publicación de otra → %v", who, err)
		}
	}
	if _, err := f.svc.Get(f.as("dani"), id); !errors.Is(err, repository.ErrPostNotFound) {
		t.Fatalf("antes de cambiarla, otra org la ve → %v", err)
	}
	out, err := f.svc.Update(f.as("bea"), id, domain.UpdatePostRequest{Title: &title, Audience: &everyone})
	if err != nil {
		t.Fatal(err)
	}
	if out.Title != "después" || out.EditedAt == nil || out.Audience != everyone || !out.CanEdit {
		t.Fatalf("después de editar: %+v", out.PostResponse)
	}
	if _, err := f.svc.Get(f.as("dani"), id); err != nil {
		t.Fatalf("pasada a «para todos», otra org no la ve: %v", err)
	}
	if got, _ := f.svc.Get(f.as("ana"), id); got.CanEdit {
		t.Fatal("al admin se le ofrece editar lo de otra persona")
	}

	ann := f.post(t, "root", domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"})
	platform := domain.AudiencePlatform
	out, err = f.svc.Update(f.as("root"), ann, domain.UpdatePostRequest{Audience: &platform})
	if err != nil || out.Audience != domain.AudienceEveryone {
		t.Fatalf("un comunicado dejó de ser de todos: %v %+v", err, out)
	}
}

// Fijar es sólo de un superadmin, y se puede soltar. Mutante: dejar fijar a
// cualquiera.
func TestOnlyASuperadminPins(t *testing.T) {
	f := wallSetup(t)
	id := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Audience: domain.AudienceEveryone, Body: "x"})
	for _, who := range []string{"bea", "ana"} {
		if _, err := f.svc.Pin(f.as(who), id, true); !errors.Is(err, ErrPostForbidden) {
			t.Fatalf("%s fijó → %v", who, err)
		}
	}
	out, err := f.svc.Pin(f.as("root"), id, true)
	if err != nil || !out.Pinned {
		t.Fatalf("el superadmin no pudo fijar: %v", err)
	}
	if out, _ := f.svc.Pin(f.as("root"), id, false); out.Pinned {
		t.Fatal("no se soltó")
	}
}

// Las reacciones de un comentario siguen a la publicación: quien no la ve no
// reacciona, un comentario de otra publicación no vale, y borrar el
// comentario o la publicación se las lleva. Mutantes: no mirar la
// publicación; no mirar que el comentario sea de ella; dejarlas al borrar.
func TestCommentReactionsFollowThePost(t *testing.T) {
	f := wallSetup(t)
	id := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Body: "x"})
	other := f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Body: "y"})
	out, _ := f.svc.Comment(f.as("ana"), "", id, domain.CreatePostCommentRequest{Body: "c"})
	cid := out.CommentList[0].ID
	thumbs := domain.ReactionRequest{Emoji: "👍", On: true}
	if err := f.svc.ReactComment(f.as("vic"), id, cid, thumbs); err != nil {
		t.Fatal(err)
	}
	got, _ := f.svc.Get(f.as("vic"), id)
	if r := got.CommentList[0].Reactions; len(r) != 1 || r[0].Count != 1 || !r[0].Mine {
		t.Fatalf("las reacciones del comentario: %+v", r)
	}
	if err := f.svc.ReactComment(f.as("dani"), id, cid, thumbs); !errors.Is(err, repository.ErrPostNotFound) {
		t.Fatalf("otra org reaccionó a un comentario de «solo cac» → %v", err)
	}
	if err := f.svc.ReactComment(f.as("vic"), other, cid, thumbs); !errors.Is(err, repository.ErrPostNotFound) {
		t.Fatalf("un comentario de otra publicación valió → %v", err)
	}
	count := func() int64 {
		var n int64
		f.db.Model(&domain.ChatReaction{}).Where("target = ? AND message_id = ?", domain.ReactionPostComment, cid).Count(&n)
		return n
	}
	if err := f.svc.DeleteComment(f.as("ana"), id, cid); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("al borrar el comentario quedaron sus reacciones")
	}
	out, _ = f.svc.Comment(f.as("ana"), "", id, domain.CreatePostCommentRequest{Body: "otra"})
	cid = out.CommentList[0].ID
	_ = f.svc.ReactComment(f.as("vic"), id, cid, thumbs)
	if err := f.svc.Delete(f.as("bea"), id); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("al borrar la publicación quedaron las reacciones de sus comentarios")
	}
}

// La clave del cursor (Go) tiene que ser la misma que ordena el muro (SQL):
// si no, la segunda página empieza en otro sitio en cuanto lo fijado llega al
// borde de una página. Se compara contra lo que devuelve la base para cada
// combinación. Mutante: que el cursor olvide lo fijado.
func TestTheCursorKeyIsTheWallOrder(t *testing.T) {
	f := wallSetup(t)
	now := time.Now()
	for _, kind := range []string{domain.PostFeedback, domain.PostAnnouncement} {
		for _, pinned := range []bool{false, true} {
			for _, draft := range []bool{false, true} {
				p := domain.Post{Kind: kind, Draft: draft}
				if pinned {
					p.PinnedAt = &now
				}
				var sqlLead int
				f.db.Raw(`SELECT `+repository.WallLeadSQL+` FROM (SELECT ?::text AS kind, ?::timestamptz AS pinned_at, ?::boolean AS draft) p`,
					kind, p.PinnedAt, draft).Scan(&sqlLead)
				if got := repository.WallLead(&p); got != sqlLead {
					t.Errorf("%s fijado=%v borrador=%v: el cursor dice %d y el orden %d", kind, pinned, draft, got, sqlLead)
				}
			}
		}
	}
}

// Con un token (el MCP): el feedback se publica y queda marcado como de un
// agente. Un comunicado no se publica: queda como **borrador** que sólo ve su
// dueño, se le avisa, y lo publica él en persona — con el token no se puede.
// Un token que no es de superadmin, ni eso. Mutantes: publicar el comunicado
// del token; dejar ver el borrador a otros (en canSee y en el SQL del muro);
// dejar publicarlo con el token; no guardar la marca.
func TestAnAgentDraftsAnnouncementsAndAPersonPublishesThem(t *testing.T) {
	f := wallSetup(t)
	agent := *f.as("bea")
	agent.ViaToken = true
	out, err := f.svc.Create(&agent, domain.ViaMCP, domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Body: "x"})
	if err != nil || out.Via != domain.ViaMCP || out.Draft {
		t.Fatalf("el feedback del agente: %v %+v", err, out)
	}
	c, err := f.svc.Comment(&agent, domain.ViaMCP, out.ID, domain.CreatePostCommentRequest{Body: "y"})
	if err != nil || c.CommentList[0].Via != domain.ViaMCP {
		t.Fatalf("el comentario del agente: %v %+v", err, c)
	}
	if _, err := f.svc.Create(&agent, domain.ViaMCP, domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"}); !errors.Is(err, ErrPostForbidden) {
		t.Fatalf("un comunicado con el token de quien no es superadmin → %v", err)
	}

	root := *f.as("root")
	root.ViaToken = true
	draft, err := f.svc.Create(&root, domain.ViaMCP, domain.CreatePostRequest{Kind: domain.PostAnnouncement, Title: "borrador", Body: "x"})
	if err != nil || !draft.Draft || draft.CanPublish {
		t.Fatalf("el comunicado del agente: %v %+v", err, draft)
	}
	if got := f.bell.to("post:draft"); strings.Join(got, ",") != "u-root" {
		t.Fatalf("el aviso del borrador fue a %v", got)
	}
	for _, who := range []string{"ana", "dani", "solo"} {
		page, _ := f.svc.List(f.as(who), "")
		for _, p := range page.Posts {
			if p.ID == draft.ID {
				t.Fatalf("%s ve el borrador en el muro", who)
			}
		}
		if _, err := f.svc.Get(f.as(who), draft.ID); !errors.Is(err, repository.ErrPostNotFound) {
			t.Fatalf("%s abre el borrador → %v", who, err)
		}
	}
	if _, err := f.svc.Publish(&root, draft.ID); !errors.Is(err, ErrPostForbidden) {
		t.Fatalf("publicarlo con el token → %v", err)
	}
	person := f.as("root")
	if got, _ := f.svc.Get(person, draft.ID); !got.CanPublish {
		t.Fatal("en persona no se ofrece publicarlo")
	}
	published, err := f.svc.Publish(person, draft.ID)
	if err != nil || published.Draft {
		t.Fatalf("publicarlo en persona: %v %+v", err, published)
	}
	if _, err := f.svc.Get(f.as("dani"), draft.ID); err != nil {
		t.Fatalf("publicado, otra org no lo ve: %v", err)
	}
}

// avisosConHub: la campana que mira, al escribir cada fila, si el evento ya
// salió. Así se ve el orden: la fila tiene que estar antes que el evento,
// porque el evento es lo que hace releer la campana.
type avisosConHub struct {
	avisosEspia
	ch    <-chan events.Event
	tarde bool
}

func (a *avisosConHub) Notify(n domain.Aviso) {
	if len(a.ch) > 0 {
		a.tarde = true
	}
	a.avisosEspia.Notify(n)
}

// El evento de lo nuevo sale después de escribir la campana, y lo de un
// borrador no se anuncia más que a su autor. Roturas que detecta: anunciar
// antes de escribir la fila; anunciar el borrador a todos.
func TestTheBellIsWrittenBeforeTheEventAndDraftsStayPrivate(t *testing.T) {
	f := wallSetup(t)
	hub := events.NewHub()
	rootCh, offRoot := hub.SubscribeAll("u-root")
	defer offRoot()
	anaCh, offAna := hub.SubscribeAll("u-ana")
	defer offAna()
	bell := &avisosConHub{ch: rootCh}
	f.svc.hub = hub
	f.svc.inbox = bell

	f.post(t, "bea", domain.CreatePostRequest{Kind: domain.PostFeedback, OrgID: "org-1", Body: "x"})
	if len(bell.to("post:feedback")) == 0 || bell.tarde {
		t.Fatalf("la campana se escribió después del evento (o no se escribió): %+v", bell.got)
	}
	for len(anaCh) > 0 {
		<-anaCh
	}
	for len(rootCh) > 0 {
		<-rootCh
	}

	token := *f.as("root")
	token.ViaToken = true
	draft, err := f.svc.Create(&token, domain.ViaMCP, domain.CreatePostRequest{Kind: domain.PostAnnouncement, Body: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Comment(f.as("root"), "", draft.ID, domain.CreatePostCommentRequest{Body: "nota"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if len(anaCh) != 0 {
		t.Fatalf("otra persona recibió %d eventos de un borrador", len(anaCh))
	}
	if len(rootCh) == 0 {
		t.Fatal("el autor no recibió los eventos de su borrador")
	}
}
