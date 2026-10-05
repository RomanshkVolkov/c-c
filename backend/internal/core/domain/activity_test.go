package domain

import "testing"

// El rango de un estado es lo que impide que un webhook tardío deshaga uno
// posterior: `completed` tiene que ir por encima de `in_progress`, y éste por
// encima de lo demás. Los que empatan (requested, queued, waiting, pending)
// no tienen orden entre sí a propósito. El mutante que mata: intercambiar dos
// constantes, o darle a `queued` un rango propio.
func TestRunRankNeverGoesBackwards(t *testing.T) {
	if WorkflowRunRank(RunStatusCompleted) <= WorkflowRunRank(RunStatusInProgress) {
		t.Error("completed tiene que ir por encima de in_progress")
	}
	if WorkflowRunRank(RunStatusInProgress) <= WorkflowRunRank("requested") {
		t.Error("in_progress tiene que ir por encima de requested")
	}
	for _, s := range []string{"requested", "queued", "waiting", "pending", ""} {
		if WorkflowRunRank(s) != WorkflowRunRank("requested") {
			t.Errorf("%q tiene rango propio; los de antes de empezar empatan", s)
		}
	}
	if !IsRunTerminal(RunStatusCompleted) || IsRunTerminal(RunStatusInProgress) {
		t.Error("sólo completed es terminal")
	}
}
