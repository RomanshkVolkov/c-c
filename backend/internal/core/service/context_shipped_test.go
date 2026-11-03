package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Una tarea en curso cuyos commits ya salieron todos en una release lo dice
// en el mapa: es la que la sesión cierra al poner el tablero al día
// (command-and-control-295). cac no la mueve.
//
// Roturas que atrapa: no decorar las tareas en curso, marcar una con algún
// commit fuera («alguno» en vez de «todos»), o marcar una sin commits.
func TestATaskWhoseCommitsAllShippedSaysSoInTheMap(t *testing.T) {
	db := contextFixture(t)
	if err := db.AutoMigrate(&domain.TaskGitLink{}, &domain.Release{}, &domain.ReleaseCommit{}); err != nil {
		t.Fatal(err)
	}
	otra := &domain.Item{OrgID: "org-1", SpaceID: "sp-1", ListID: "l-app", Seq: 11, Title: "A medias", Status: domain.ReportInProgress}
	otra.ID = "it-medias"
	mustCreate(t, db, otra)
	sin := &domain.Item{OrgID: "org-1", SpaceID: "sp-1", ListID: "l-app", Seq: 12, Title: "Sin commits", Status: domain.ReportInProgress}
	sin.ID = "it-sin"
	mustCreate(t, db, sin)

	const a, b, c = "aaaaaaa000000000000000000000000000000000", "bbbbbbb000000000000000000000000000000000", "ccccccc000000000000000000000000000000000"
	now := time.Now()
	for _, l := range []struct{ item, sha string }{{"it-curso", a}, {"it-curso", b}, {"it-medias", a}, {"it-medias", c}} {
		mustCreate(t, db, &domain.TaskGitLink{OrgID: "org-1", ItemID: l.item, RepoID: 1, RepoFullName: "guz-studio/cac",
			Kind: domain.GitLinkCommit, Key: l.sha, OccurredAt: now})
	}
	day := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	rel := &domain.Release{OrgID: "org-1", RepoID: 1, RepoFullName: "guz-studio/cac", Tag: "v1.9.1", PublishedAt: day}
	if _, err := repository.NewGitHubRepository(db).SaveRelease(rel, []domain.ReleaseCommit{{SHA: a}, {SHA: b}}); err != nil {
		t.Fatal(err)
	}

	m, err := NewContextService(db).Map("org-1", "sp-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, t := range m.InProgress {
		if t.Shipped != nil {
			got[t.ID] = t.Shipped.Tag
		}
	}
	if len(got) != 1 || got["it-curso"] != "v1.9.1" {
		t.Errorf("salidas %v, sólo se esperaba it-curso en v1.9.1", got)
	}
}
