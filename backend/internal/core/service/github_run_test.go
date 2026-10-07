package service

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// La fila de un run es lo que GitHub manda, y lo que no manda se rellena con
// lo que sí: sin `triggering_actor` vale el `actor`, sin `run_attempt` es el
// primero, sin `created_at` el reloj de aquí, y un enlace fuera de GitHub se
// cambia por la portada. Cada rama tiene su mutante: quitar un fallback deja un
// run sin actor, con intento 0 (que ya no casa con el de GitHub), con fecha
// cero (que el feed ordena al final de todo) o con un enlace que no se pinta.
func TestRunFromPayloadReadsWhatTheFeedShows(t *testing.T) {
	repo := &domain.GitHubRepo{RepoID: 100, FullName: "dwit/api", OrgID: "org-1"}
	fixed := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	now := func() time.Time { return fixed }

	full := `{"action":"in_progress","repository":{"id":100},"workflow_run":{
		"id":9,"run_number":41,"run_attempt":2,"name":"Deploy","status":"in_progress","event":"push",
		"path":".github/workflows/prod.yml","head_sha":"abc1234def","head_branch":"main",
		"html_url":"https://github.com/dwit/api/actions/runs/9/attempts/2",
		"created_at":"2026-10-04T10:00:00Z","updated_at":"2026-10-04T10:01:00Z","run_started_at":"2026-10-04T10:00:30Z",
		"actor":{"login":"ana"},"triggering_actor":{"login":"bea"},
		"head_commit":{"message":"fix: el login\n\ncuerpo largo"}}}`
	var p ghPayload
	if err := json.Unmarshal([]byte(full), &p); err != nil {
		t.Fatal(err)
	}
	run := runFromPayload(repo, &p, now)
	if run.OrgID != "org-1" || run.RepoID != 100 || run.RepoFullName != "dwit/api" {
		t.Errorf("el run no es del repo: %+v", run)
	}
	if run.RunID != 9 || run.RunAttempt != 2 || run.RunNumber != 41 {
		t.Errorf("id/intento/número: %d/%d/%d", run.RunID, run.RunAttempt, run.RunNumber)
	}
	if run.WorkflowName != "Deploy" || run.Path != ".github/workflows/prod.yml" || run.Event != "push" {
		t.Errorf("workflow: %q %q %q", run.WorkflowName, run.Path, run.Event)
	}
	if run.Status != "in_progress" || run.Conclusion != "" {
		t.Errorf("estado: %q/%q", run.Status, run.Conclusion)
	}
	if run.Actor != "bea" {
		t.Errorf("en un re-run el actor es quien lo relanzó, no %q", run.Actor)
	}
	if run.CommitTitle != "fix: el login" {
		t.Errorf("el título del commit es la primera línea, no %q", run.CommitTitle)
	}
	// La hora de **este intento** (run_started_at), no la de la ejecución
	// (created_at, la misma en todos sus intentos): con ella, los intentos de
	// un run salían empatados y arriba podía quedar un fallo ya superado
	// (7-oct-2026). Mutante: volver al created_at.
	if !run.OccurredAt.Equal(time.Date(2026, 10, 4, 10, 0, 30, 0, time.UTC)) {
		t.Errorf("OccurredAt es el run_started_at del intento, no %v", run.OccurredAt)
	}
	if run.RunStartedAt == nil || run.EventUpdatedAt == nil || !run.EventUpdatedAt.Equal(time.Date(2026, 10, 4, 10, 1, 0, 0, time.UTC)) {
		t.Errorf("los tiempos del payload no llegaron: %v %v", run.RunStartedAt, run.EventUpdatedAt)
	}
	if run.HTMLURL != "https://github.com/dwit/api/actions/runs/9/attempts/2" {
		t.Errorf("enlace: %q", run.HTMLURL)
	}
	if run.ID == "" {
		t.Error("la fila nace con id: es lo que el deploy guarda para colgarse de ella")
	}

	bare := `{"action":"requested","repository":{"id":100},"workflow_run":{
		"id":10,"status":"queued","path":".github/workflows/tests.yml","actor":{"login":"ana"},
		"html_url":"javascript:alert(1)"}}`
	p = ghPayload{}
	if err := json.Unmarshal([]byte(bare), &p); err != nil {
		t.Fatal(err)
	}
	run = runFromPayload(repo, &p, now)
	if run.Actor != "ana" {
		t.Errorf("sin triggering_actor vale el actor, no %q", run.Actor)
	}
	if run.RunAttempt != 1 {
		t.Errorf("sin run_attempt es el primero, no %d", run.RunAttempt)
	}
	if !run.OccurredAt.Equal(fixed) {
		t.Errorf("sin created_at vale el reloj de aquí, no %v", run.OccurredAt)
	}
	if run.HTMLURL != "https://github.com/" {
		t.Errorf("un enlace que no es de GitHub no se guarda: %q", run.HTMLURL)
	}
	if run.EventUpdatedAt != nil || run.RunStartedAt != nil {
		t.Error("sin tiempos en el payload, no se inventan")
	}

	// Un aviso «requested» del intento, que aún no empezó: vale el created_at.
	// Mutante: dejar la hora en cero sin run_started_at.
	queued := `{"action":"requested","repository":{"id":100},"workflow_run":{
		"id":11,"run_attempt":2,"status":"queued","created_at":"2026-10-04T09:00:00Z"}}`
	p = ghPayload{}
	if err := json.Unmarshal([]byte(queued), &p); err != nil {
		t.Fatal(err)
	}
	run = runFromPayload(repo, &p, now)
	if !run.OccurredAt.Equal(time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("sin run_started_at vale el created_at, no %v", run.OccurredAt)
	}
}
