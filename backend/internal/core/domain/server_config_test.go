package domain

import (
	"errors"
	"strings"
	"testing"
)

// Un secreto no entra en una config como variable plana, ni por el nombre ni
// por la forma. El decodificador estricto no mira dentro de un mapa: esto es
// lo único que lo impide.
func TestASecretCannotHideInTheVars(t *testing.T) {
	requires := []string{"OPS_PASSWORD", "CLOUDFLARE_DNS_TOKEN", "GHCR_LOGIN"}
	casos := []struct {
		nombre string
		vars   map[string]any
		want   error
	}{
		{"lo normal pasa", map[string]any{"base_domain": "gstd.guz-studio.dev", "ssh_port": 7337, "ops_authorized_keys": []any{"ssh-ed25519 AAA jose"}}, nil},
		{"uno que la plantilla pide como secreto, en minúsculas", map[string]any{"cloudflare_dns_token": "abc"}, ErrSecretInVars},
		{"uno de requires con su mayúscula", map[string]any{"OPS_PASSWORD": "abc"}, ErrSecretInVars},
		// Sin sufijo que lo delate: sólo lo atrapa que la plantilla lo pide, y
		// en minúsculas, que es como lo escribe un playbook.
		{"uno de requires sin pinta de secreto", map[string]any{"ghcr_login": "abc"}, ErrSecretInVars},
		{"uno que se llama sólo password", map[string]any{"password": "abc"}, ErrSecretInVars},
		{"por el sufijo, aunque la plantilla no lo pida", map[string]any{"valkey_password": "abc"}, ErrSecretInVars},
		{"un token cualquiera", map[string]any{"github_token": "abc"}, ErrSecretInVars},
		{"la contraseña de sudo de Ansible", map[string]any{"ansible_become_password": "abc"}, ErrSecretInVars},
		{"una referencia como valor", map[string]any{"dns": "op://Employee/x/credential"}, ErrSecretInVars},
		{"una referencia escondida en una lista", map[string]any{"keys": []any{"ok", " op-env://Prod/TOKEN"}}, ErrSecretInVars},
		{"una referencia escondida en un mapa", map[string]any{"cfg": map[string]any{"a": map[string]any{"b": "op://v/i/f"}}}, ErrSecretInVars},
		{"un nombre que Ansible no acepta", map[string]any{"base-domain": "x"}, ErrBadVarName},
		{"demasiado grande", map[string]any{"blob": strings.Repeat("x", MaxConfigBytes)}, ErrConfigTooLarge},
	}
	for _, c := range casos {
		if got := ValidateConfigVars(c.vars, requires); !errors.Is(got, c.want) {
			t.Errorf("%s: %v, quería %v", c.nombre, got, c.want)
		}
	}
}

// Las referencias son nombre de secreto → `op://`. Un valor que no es una
// referencia es el secreto pegado.
func TestOpRefsAreReferencesNotValues(t *testing.T) {
	casos := []struct {
		nombre string
		refs   map[string]string
		want   error
	}{
		{"una referencia", map[string]string{"OPS_PASSWORD": "op://Employee/gstd infra_devops/password"}, nil},
		{"una variable de un Environment", map[string]string{"CLOUDFLARE_DNS_TOKEN": "op-env://Infra/CF_TOKEN"}, nil},
		{"el valor pegado", map[string]string{"OPS_PASSWORD": "hunter2-correct-horse"}, ErrBadConfigRef},
		{"una referencia a medias", map[string]string{"OPS_PASSWORD": "op://Employee"}, ErrBadConfigRef},
		{"un nombre que no es de secreto", map[string]string{"ops_password": "op://v/i/f"}, ErrBadConfigSecret},
	}
	for _, c := range casos {
		if got := ValidateOpRefs(c.refs); !errors.Is(got, c.want) {
			t.Errorf("%s: %v, quería %v", c.nombre, got, c.want)
		}
	}
}

func TestATemplateIsWellFormed(t *testing.T) {
	ok := PutServerTemplateRequest{
		Playbooks: []string{"baseline", "swarm", "valkey"},
		Vars:      map[string]any{"traefik_image": "traefik:v3.6"},
		Requires:  []string{"OPS_PASSWORD", "CLOUDFLARE_DNS_TOKEN"},
		PerServer: []string{"OPS_PASSWORD"},
	}
	if err := ValidateTemplate(ok); err != nil {
		t.Fatalf("una plantilla buena: %v", err)
	}
	casos := []struct {
		nombre string
		mut    func(*PutServerTemplateRequest)
		want   error
	}{
		{"sin playbooks", func(r *PutServerTemplateRequest) { r.Playbooks = nil }, ErrBadPlaybookID},
		{"un id que no es de playbook", func(r *PutServerTemplateRequest) { r.Playbooks = []string{"../swarm"} }, ErrBadPlaybookID},
		{"un secreto en minúsculas", func(r *PutServerTemplateRequest) { r.Requires = []string{"ops_password"} }, ErrBadConfigSecret},
		{"perServer que no se pide", func(r *PutServerTemplateRequest) { r.PerServer = []string{"OTRO"} }, ErrPerServerNotReq},
		{"un secreto en sus vars", func(r *PutServerTemplateRequest) { r.Vars = map[string]any{"cloudflare_dns_token": "x"} }, ErrSecretInVars},
	}
	for _, c := range casos {
		r := ok
		r.Playbooks = append([]string(nil), ok.Playbooks...)
		c.mut(&r)
		if got := ValidateTemplate(r); !errors.Is(got, c.want) {
			t.Errorf("%s: %v, quería %v", c.nombre, got, c.want)
		}
	}
}

// Lo del servidor pisa lo de la plantilla, entero: una lista del servidor no
// se mezcla con la de la plantilla, la sustituye.
func TestServerVarsReplaceTemplateVars(t *testing.T) {
	tpl := map[string]any{"traefik_image": "traefik:v3.6", "firewall_web_ports": []any{80, 443}, "acme_email": "a@x"}
	srv := map[string]any{"firewall_web_ports": []any{443}, "base_domain": "gstd.guz-studio.dev"}
	got := MergeVars(tpl, srv)
	if got["traefik_image"] != "traefik:v3.6" || got["base_domain"] != "gstd.guz-studio.dev" {
		t.Errorf("faltan claves: %v", got)
	}
	if ports, _ := got["firewall_web_ports"].([]any); len(ports) != 1 {
		t.Errorf("la lista del servidor no sustituyó a la de la plantilla: %v", got["firewall_web_ports"])
	}
	if _, ok := tpl["base_domain"]; ok {
		t.Error("combinar cambió la plantilla")
	}
}
