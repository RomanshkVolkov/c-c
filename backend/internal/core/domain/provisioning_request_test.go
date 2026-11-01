package domain

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

/*
La política del protocolo (31-oct-2026, decisión 4d28f4ab), sin base: qué
pre-autoriza, qué banderas levanta un ensayo y qué se le exige a una petición.
*/

func cleanCheck() ProvisioningCheck {
	return ProvisioningCheck{Hosts: []string{"gstd"}, Ok: 12}
}

func hasFlag(flags []RiskFlag, code string) bool {
	for _, f := range flags {
		if f.Code == code {
			return true
		}
	}
	return false
}

// Sólo una lectura limpia se pre-autoriza. Un `change` con un ensayo
// impecable espera a una persona igual, y uno `destructive` también: no hay
// ensayo lo bastante limpio para saltarse la aprobación.
func TestOnlyACleanReadIsPreAuthorized(t *testing.T) {
	if _, auto := EvaluateCheck(RiskRead, "test", cleanCheck()); !auto {
		t.Fatal("una lectura limpia tiene que ir pre-autorizada")
	}
	for _, risk := range []string{RiskChange, RiskDestructive} {
		if _, auto := EvaluateCheck(risk, "swarm", cleanCheck()); auto {
			t.Errorf("%s se pre-autorizó con un ensayo limpio", risk)
		}
	}
	// Sin nada que pre-autorice, tampoco un riesgo que no es ninguno de los tres.
	if _, auto := EvaluateCheck("", "test", cleanCheck()); auto {
		t.Error("un riesgo vacío se pre-autorizó")
	}
}

// Cada bandera, con su ensayo. Cualquiera de ellas quita la pre-autorización
// a una lectura.
func TestACheckRaisesItsFlags(t *testing.T) {
	cases := []struct {
		name, risk, playbook, flag, level string
		mut                               func(*ProvisioningCheck)
	}{
		{"el ensayo falla", RiskRead, "test", FlagCheckFailed, FlagRed, func(c *ProvisioningCheck) { c.Failed = 1 }},
		{"sale con error", RiskRead, "test", FlagCheckFailed, FlagRed, func(c *ProvisioningCheck) { c.ExitCode = 2 }},
		{"no llega", RiskRead, "test", FlagUnreachable, FlagRed, func(c *ProvisioningCheck) { c.Unreachable = 1 }},
		{"dos hosts", RiskRead, "test", FlagHostCount, FlagRed, func(c *ProvisioningCheck) { c.Hosts = []string{"a", "b"} }},
		{"ningún host", RiskRead, "test", FlagHostCount, FlagRed, func(c *ProvisioningCheck) { c.Hosts = nil }},
		{"una lectura que cambiaría", RiskRead, "test", FlagReadWouldChange, FlagRed, func(c *ProvisioningCheck) { c.Changed = 1 }},
		{"toca sshd fuera de baseline", RiskRead, "swarm-verify", FlagTouchesAccess, FlagRed,
			func(c *ProvisioningCheck) { c.Paths = []string{"/etc/ssh/sshd_config"} }},
		{"una tarea del cortafuegos", RiskRead, "test", FlagTouchesAccess, FlagRed,
			func(c *ProvisioningCheck) { c.ChangedTasks = []string{"Abrir el puerto en UFW"} }},
	}
	for _, c := range cases {
		check := cleanCheck()
		c.mut(&check)
		flags, auto := EvaluateCheck(c.risk, c.playbook, check)
		if !hasFlag(flags, c.flag) {
			t.Errorf("%s: falta la bandera %s (%v)", c.name, c.flag, flags)
		}
		for _, f := range flags {
			if f.Code == c.flag && f.Level != c.level {
				t.Errorf("%s: %s es %s, no %s", c.name, f.Code, f.Level, c.level)
			}
		}
		if auto {
			t.Errorf("%s: se pre-autorizó con una bandera", c.name)
		}
	}
}

// El acceso a la máquina (sshd, llaves, cortafuegos) es cosa de `baseline`:
// allí no es bandera, en cualquier otro sí. Y un `destructive` lo dice
// siempre, aunque sea en ámbar.
func TestOnlyBaselineTouchesAccessWithoutAFlag(t *testing.T) {
	check := cleanCheck()
	check.Changed = 3
	check.Paths = []string{"/etc/ssh/sshd_config"}
	check.ChangedTasks = []string{"authorized_keys de infra_devops"}
	flags, _ := EvaluateCheck(RiskChange, "baseline", check)
	if hasFlag(flags, FlagTouchesAccess) {
		t.Errorf("baseline levantó touches-access: %v", flags)
	}
	if !hasFlag(flags, FlagChanges) {
		t.Errorf("un change que cambia algo no lo dice: %v", flags)
	}
	flags, _ = EvaluateCheck(RiskChange, "swarm", check)
	if !hasFlag(flags, FlagTouchesAccess) {
		t.Errorf("swarm tocando sshd no levantó bandera: %v", flags)
	}
	flags, _ = EvaluateCheck(RiskDestructive, "swarm-teardown", cleanCheck())
	if !hasFlag(flags, FlagDestructive) || HasRedFlag(flags) {
		t.Errorf("un destructive limpio: %v", flags)
	}
}

// Lo que cambia o destruye trae con qué se comprueba y con qué se deshace; una
// lectura no lo necesita. Y siempre una versión de la config.
func TestARequestNamesItsVerifyAndRollback(t *testing.T) {
	ok := CreateProvisioningRequest{Playbook: "swarm", Risk: RiskChange, Verify: "swarm-verify", Rollback: "swarm-teardown", ConfigSeq: 1}
	if err := ValidateProvisioningRequest(ok); err != nil {
		t.Fatalf("una petición bien hecha: %v", err)
	}
	if err := ValidateProvisioningRequest(CreateProvisioningRequest{Playbook: "test", Risk: RiskRead, ConfigSeq: 1}); err != nil {
		t.Fatalf("una lectura sin verify: %v", err)
	}
	cases := []struct {
		want error
		mut  func(*CreateProvisioningRequest)
	}{
		{ErrBadRisk, func(r *CreateProvisioningRequest) { r.Risk = "low" }},
		{ErrBadRisk, func(r *CreateProvisioningRequest) { r.Risk = "" }},
		{ErrVerifyRequired, func(r *CreateProvisioningRequest) { r.Verify = "" }},
		{ErrRollbackRequired, func(r *CreateProvisioningRequest) { r.Rollback = "" }},
		{ErrVerifyRequired, func(r *CreateProvisioningRequest) { r.Risk, r.Verify = RiskDestructive, "" }},
		{ErrBadPlaybookID, func(r *CreateProvisioningRequest) { r.Playbook = "../swarm" }},
		{ErrBadPlaybookID, func(r *CreateProvisioningRequest) { r.Verify = "-x" }},
		{ErrConfigSeqRequired, func(r *CreateProvisioningRequest) { r.ConfigSeq = 0 }},
	}
	for _, c := range cases {
		r := ok
		c.mut(&r)
		if err := ValidateProvisioningRequest(r); err != c.want {
			t.Errorf("%+v → %v, quería %v", r, err, c.want)
		}
	}
}

// Una autorización caduca a su hora; una petición sin decidir, al día. Lo que
// ya corrió no caduca.
func TestARequestExpires(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	grant := now.Add(time.Minute)
	p := ProvisioningRequest{Status: ProvisioningRequestApproved, GrantExpiresAt: &grant}
	if p.Expired(now) {
		t.Error("una autorización vigente caducó")
	}
	if !p.Expired(grant) {
		t.Error("una autorización a su hora justa no caducó")
	}
	p.GrantExpiresAt = nil
	if !p.Expired(now) {
		t.Error("una aprobada sin hora de caducidad vale para siempre")
	}
	p = ProvisioningRequest{Status: ProvisioningRequestAwaiting}
	p.CreatedAt = now.Add(-ProvisioningDecisionTTL + time.Minute)
	if p.Expired(now) {
		t.Error("una petición de hace menos de un día caducó")
	}
	p.CreatedAt = now.Add(-ProvisioningDecisionTTL)
	if !p.Expired(now) {
		t.Error("una petición de hace un día no caducó")
	}
	p.Status = ProvisioningRequestSucceeded
	if p.Expired(now) {
		t.Error("una que ya corrió caducó")
	}
}

// El recap se suma por hosts; sin recap, -1 (no «cero»: no se sabe).
func TestTheRecapSaysWhatChanged(t *testing.T) {
	recap := "PLAY RECAP *****\ngstd : ok=12 changed=0 unreachable=0 failed=0\nb : ok=3 changed=2 unreachable=0"
	if got := RecapChanged(recap); got != 2 {
		t.Errorf("RecapChanged = %d", got)
	}
	if got := RecapChanged("gstd : ok=12 changed=0 unreachable=0"); got != 0 {
		t.Errorf("sin cambios = %d", got)
	}
	if got := RecapChanged("la salida se cortó"); got != -1 {
		t.Errorf("sin recap = %d", got)
	}
}

// El diff se acota sin partir un carácter: texto inválido haría que Postgres
// rechazara la fila entera.
func TestABigDiffIsCutCleanly(t *testing.T) {
	c := BoundCheck(ProvisioningCheck{Diff: strings.Repeat("ñ", provisioningDiffBytes)})
	if len(c.Diff) > provisioningDiffBytes+8 || !utf8.ValidString(c.Diff) {
		t.Errorf("diff de %d bytes, válido=%v", len(c.Diff), utf8.ValidString(c.Diff))
	}
	if c.Hosts == nil {
		t.Error("hosts nil viaja como null")
	}
}
