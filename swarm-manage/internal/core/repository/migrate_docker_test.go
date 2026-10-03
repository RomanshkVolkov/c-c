package repository

import (
	"encoding/binary"
	"reflect"
	"testing"
)

// El job copia del servicio lo que hace falta para llegar a la base (redes,
// secrets, entorno), y deja lo que lo haría otra app: puertos, labels que lee
// Traefik, healthcheck, reinicios y réplicas.
func TestTheMigrationJobIsTheServiceWithoutWhatMakesItAnApp(t *testing.T) {
	svc := map[string]any{
		"Name":   "rrhh-prod_app",
		"Labels": map[string]any{"traefik.enable": "true"},
		"TaskTemplate": map[string]any{
			"ContainerSpec": map[string]any{
				"Image": "ghcr.io/a/b:viejo", "Args": []any{"node", "server.js"}, "Env": []any{"NODE_ENV=production"},
				"Secrets":     []any{map[string]any{"SecretName": "cac_DATABASE_URL_0123456789abcdef"}},
				"Healthcheck": map[string]any{"Test": []any{"CMD", "curl"}}, "Labels": map[string]any{"x": "y"},
			},
			"Networks":      []any{map[string]any{"Target": "db_net"}},
			"Placement":     map[string]any{"Constraints": []any{"node.role==manager"}},
			"RestartPolicy": map[string]any{"Condition": "any"},
		},
		"Mode":         map[string]any{"Replicated": map[string]any{"Replicas": 2}},
		"EndpointSpec": map[string]any{"Ports": []any{map[string]any{"PublishedPort": 3000}}},
	}
	spec, err := MigrationSpec(svc, "rrhh-prod_app-migrate-d1", "rrhh-prod_app", "ghcr.io/a/b:abc1234@sha256:x", "npx prisma migrate deploy")
	if err != nil {
		t.Fatal(err)
	}
	tt := spec["TaskTemplate"].(map[string]any)
	cs := tt["ContainerSpec"].(map[string]any)
	if cs["Image"] != "ghcr.io/a/b:abc1234@sha256:x" {
		t.Errorf("imagen %v", cs["Image"])
	}
	if !reflect.DeepEqual(cs["Command"], []string{"sh", "-c", "npx prisma migrate deploy"}) {
		t.Errorf("comando %v", cs["Command"])
	}
	for _, k := range []string{"Args", "Healthcheck", "Labels"} {
		if _, ok := cs[k]; ok {
			t.Errorf("el job lleva %s del servicio", k)
		}
	}
	for _, k := range []string{"Secrets", "Env"} {
		if _, ok := cs[k]; !ok {
			t.Errorf("el job no lleva %s: no llegaría a la base", k)
		}
	}
	if tt["Networks"] == nil || tt["Placement"] == nil {
		t.Error("el job perdió las redes o las restricciones")
	}
	if !reflect.DeepEqual(tt["RestartPolicy"], map[string]any{"Condition": "none"}) {
		t.Errorf("un job que falla se reintentaría: %v", tt["RestartPolicy"])
	}
	if _, ok := spec["EndpointSpec"]; ok {
		t.Error("el job publica los puertos del servicio")
	}
	if labels := spec["Labels"].(map[string]string); labels["traefik.enable"] != "" || labels["cac.migration.of"] != "rrhh-prod_app" {
		t.Errorf("labels del job: %v", labels)
	}
	if _, ok := spec["Mode"].(map[string]any)["ReplicatedJob"]; !ok {
		t.Errorf("no es un job: %v", spec["Mode"])
	}
}

func TestDemuxSplitsDockerLogFrames(t *testing.T) {
	frame := func(stream byte, s string) []byte {
		h := make([]byte, 8)
		h[0] = stream
		binary.BigEndian.PutUint32(h[4:], uint32(len(s)))
		return append(h, s...)
	}
	raw := append(frame(1, "applied 1\n"), frame(2, "warn: x\napplied 2\n")...)
	if got := Demux(raw); !reflect.DeepEqual(got, []string{"applied 1", "warn: x", "applied 2"}) {
		t.Errorf("Demux = %q", got)
	}
	if got := Demux([]byte("con tty\nsin cabeceras\n")); !reflect.DeepEqual(got, []string{"con tty", "sin cabeceras"}) {
		t.Errorf("sin cabeceras = %q", got)
	}
}

func TestATaskThatStoppedIsDone(t *testing.T) {
	for _, s := range []string{"complete", "failed", "rejected"} {
		if !(TaskState{State: s}).Done() {
			t.Errorf("%s no cuenta como acabada", s)
		}
	}
	for _, s := range []string{"", "new", "pending", "running", "starting"} {
		if (TaskState{State: s}).Done() {
			t.Errorf("%s cuenta como acabada", s)
		}
	}
}
