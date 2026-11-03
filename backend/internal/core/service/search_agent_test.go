package service

import (
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Lo que buscó un agente y no encontró (`search_misses`, 2-nov-2026), con la
// base de verdad: la raíz la calcula Postgres, y la segunda vuelta y el id
// pegado pasan por todas las fuentes (command-and-control-294).

func agentSearchDB(t *testing.T) (*gorm.DB, *SearchService) {
	t.Helper()
	db := incidentDB(t)
	// Lo que el resto de la búsqueda pisa: personas, mensajes, directos,
	// notas y comentarios.
	if err := db.AutoMigrate(&domain.OrgMembership{}, &domain.ItemComment{}, &domain.Note{},
		&domain.ChatMessage{}, &domain.DMConversation{}, &domain.DMMessage{}); err != nil {
		t.Fatal(err)
	}
	if err := repository.EnsureSearchIndexes(db); err != nil {
		t.Fatal(err)
	}
	return db, NewSearchService(repository.NewSearchRepository(db))
}

func task(t *testing.T, db *gorm.DB, org, list, title string) string {
	t.Helper()
	it := &domain.Item{OrgID: org, ListID: list, Title: title, Status: domain.ReportPending}
	it.ID = uuid.NewString()
	mustCreate(t, db, it)
	return it.ID
}

func has(hits []domain.SearchHit, id string) bool {
	for _, h := range hits {
		if h.ID == id {
			return true
		}
	}
	return false
}

// Roturas que atrapa: no pedir las raíces, sacarlas sin acento (Postgres no
// reconoce el sufijo y «publicación» se queda igual), o marcar como parcial
// lo que casó con todas las palabras.
func TestAnotherFormOfTheSameSpanishWordIsFound(t *testing.T) {
	db, s := agentSearchDB(t)
	id := task(t, db, "org-1", "l-back", "Los riesgos de publicar sin ensayo")
	res, err := s.Search("riesgos publicación", "org-1", "u-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !has(res.Tasks, id) || res.Partial {
		t.Errorf("«publicación» no encuentra «publicar» (partial=%v): %+v", res.Partial, res.Tasks)
	}
}

// Roturas que atrapa: no dar la segunda vuelta, darla sin decir que es
// parcial, o darla también cuando la primera encontró algo (mezclaría lo
// parcial de otra org con lo que sí casa).
func TestWhenNotEveryWordMatchesWhatMatchesSomeComesBackMarkedPartial(t *testing.T) {
	db, s := agentSearchDB(t)
	kyle := task(t, db, "org-1", "l-back", "El correo de Kyle")
	res, err := s.Search("allowlist aprobar briefing kyle", "org-1", "u-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !has(res.Tasks, kyle) || !res.Partial {
		t.Errorf("sin todas las palabras no trae lo que casa con alguna (partial=%v): %+v", res.Partial, res.Tasks)
	}

	whole := task(t, db, "org-1", "l-back", "Aprobar el briefing de Kyle")
	elsewhere := task(t, db, "org-2", "l-otro", "Otro briefing")
	res, err = s.SearchOrgs("aprobar briefing kyle", []string{"org-1", "org-2"}, "u-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !has(res.Tasks, whole) || res.Partial || has(res.Tasks, elsewhere) || has(res.Tasks, kyle) {
		t.Errorf("con un acierto entero se mezcló lo parcial (partial=%v): %+v", res.Partial, res.Tasks)
	}
	if res, _ := s.Search("kyleinexistente", "org-1", "u-1", 8); res.Partial || !res.NothingForAnAgent() {
		t.Errorf("con una sola palabra no hay segunda vuelta: %+v", res)
	}
}

// Roturas que atrapa: buscar el id como texto (no encuentra nada), no mirar
// alguna de las fuentes, o saltarse la valla de la organización.
func TestAPastedIDFindsWhatItNames(t *testing.T) {
	db, s := agentSearchDB(t)
	tid := task(t, db, "org-1", "l-back", "Una tarea")
	l := &domain.TaskList{SpaceID: "sp-1", Name: "Infra", Rank: "0.5"}
	l.ID = uuid.NewString()
	mustCreate(t, db, l)
	in := record(t, incidentSvc(db), "l-back", domain.IncidentRequest{Title: "Algo mordió"})
	ajena := task(t, db, "org-2", "l-otro", "De otra org")

	for _, c := range []struct {
		id   string
		kind domain.SearchKind
	}{{tid, domain.SearchTask}, {l.ID, domain.SearchDoc}, {in.ID, domain.SearchIncident}} {
		res, err := s.Search(c.id, "org-1", "u-1", 8)
		if err != nil {
			t.Fatal(err)
		}
		all := append(append([]domain.SearchHit{}, res.Tasks...), res.Docs...)
		if len(all) != 1 || all[0].ID != c.id || all[0].Kind != c.kind || all[0].OrgID != "org-1" {
			t.Errorf("el id %s (%s) no encuentra lo que nombra: %+v", c.id, c.kind, all)
		}
	}
	if res, _ := s.Search(ajena, "org-1", "u-1", 8); !res.NothingForAnAgent() {
		t.Errorf("el id de otra org se encuentra: %+v", res)
	}
}
