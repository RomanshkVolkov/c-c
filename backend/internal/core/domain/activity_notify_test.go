package domain

import (
	"encoding/json"
	"testing"
)

// La actividad de CI es la clase más habladora de la campana, y tiene un solo
// interruptor para runs y deploys. Sin su `case`, caería en el `return true`
// del final y nadie podría callarla. Mutantes: quitar el `case`, o invertir la
// preferencia.
func TestCIQuietSilencesRunsAndDeploys(t *testing.T) {
	quiet := NotificationPrefs{CIQuiet: true}
	for _, kind := range []string{"ci:run", "deploy:done"} {
		if quiet.Allows(kind) {
			t.Errorf("%s suena con el CI en silencio", kind)
		}
		if !(NotificationPrefs{}).Allows(kind) {
			t.Errorf("%s no suena sin haber pedido silencio", kind)
		}
		if !DefaultPrefs("u").Allows(kind) {
			t.Errorf("%s no suena para quien nunca tocó las preferencias", kind)
		}
	}
}

// Una app anterior a la R9 guarda sus preferencias sin `ciQuiet`, y el JSON
// que manda tiene que seguir dejando sonar el CI: por eso la columna es
// `CIQuiet` (cero = avísame) y no `CI` (cero = calla). El mutante que mata:
// darle la vuelta al bool.
func TestPrefsSavedByAnOldAppKeepCINotifying(t *testing.T) {
	var p NotificationPrefs
	if err := json.Unmarshal([]byte(`{"dms":true,"comments":true,"reports":true,"messages":true,"workQuiet":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.CIQuiet {
		t.Fatal("un JSON sin ciQuiet lo puso en silencio")
	}
	if !p.Allows("ci:run") || !p.Allows("deploy:done") {
		t.Error("las preferencias de una app vieja callaron el CI")
	}
}

// Los runs se pliegan por repo y los deploys por servicio, con claves que sólo
// salen de las constructoras. Y `DeriveGroup` **no** las deduce del enlace:
// el enlace lleva `owner/repo`, no el id del repo, y un repo renombrado dejaría
// de ser el mismo sitio. Mutantes: deducir `repo:`+param del enlace; que
// `RepoGroup(0)` dé una clave.
func TestRepoAndDeployableGroupsAreNotDerivedFromTheLink(t *testing.T) {
	if RepoGroup(100) != "repo:100" || RepoGroup(100) == RepoGroup(200) {
		t.Errorf("RepoGroup: %q / %q", RepoGroup(100), RepoGroup(200))
	}
	if RepoGroup(0) != "" {
		t.Error("sin repo no hay grupo: se pinta suelta")
	}
	if DeployableGroup("d-1") != "deployable:d-1" || DeployableGroup("") != "" {
		t.Errorf("DeployableGroup: %q / %q", DeployableGroup("d-1"), DeployableGroup(""))
	}
	if RepoGroup(1) == DeployableGroup("1") {
		t.Error("un repo y un servicio con el mismo número no son el mismo sitio")
	}
	for _, c := range []struct{ kind, link string }{
		{"ci:run", "/activity?repo=dwit%2Fapi&run=r-1"},
		{"deploy:done", "/activity?deployable=d-1&deployment=x"},
	} {
		if got := DeriveGroup(c.kind, c.link); got != "" {
			t.Errorf("DeriveGroup(%s) dedujo %q del enlace; la clave la escribe quien la causa", c.kind, got)
		}
	}
}

// Una clave entera por conclusión en las tres que se leen a diario, y la
// genérica con el nombre dentro para el resto. Un deploy caducado no es el
// mismo fallo que uno que falló. Mutantes: colapsar todo a la genérica;
// tratar el caducado como un fallo corriente.
func TestRunAndDeployPhrasesHaveOneKeyPerCase(t *testing.T) {
	for _, c := range []string{"success", "failure", "cancelled"} {
		f := RunPhrase(c, "Deploy", "main")
		if f.Clave != "notify.ci.run."+c || f.Args["workflow"] != "Deploy" || f.Args["branch"] != "main" {
			t.Errorf("%s: %+v", c, f)
		}
		if _, has := f.Args["conclusion"]; has {
			t.Errorf("%s tiene clave propia: la conclusión no va como argumento", c)
		}
	}
	f := RunPhrase("skipped", "Deploy", "main")
	if f.Clave != "notify.ci.run" || f.Args["conclusion"] != "skipped" {
		t.Errorf("una conclusión rara va por la genérica con su nombre: %+v", f)
	}

	ok := DeployPhrase(&Deployment{Status: DeploySucceeded}, "api", "abc1234")
	if ok.Clave != "notify.deploy.succeeded" || ok.Args["service"] != "api" || ok.Args["sha"] != "abc1234" {
		t.Errorf("bien: %+v", ok)
	}
	if f := DeployPhrase(&Deployment{Status: DeployFailed, Error: "exit 1"}, "api", "x"); f.Clave != "notify.deploy.failed" {
		t.Errorf("fallado: %+v", f)
	}
	if f := DeployPhrase(&Deployment{Status: DeployFailed, Error: DeployExpiredError}, "api", "x"); f.Clave != "notify.deploy.expired" {
		t.Errorf("caducado: %+v", f)
	}
}
