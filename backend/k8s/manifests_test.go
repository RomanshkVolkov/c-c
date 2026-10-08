package k8s_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Los manifiestos del relé TURN (W3) tienen que casar entre sí, y nada falla
// si no casan: el Gateway acepta la ruta, LiveKit arranca, y la llamada de un
// invitado detrás de un firewall se queda en «conectando» sin que ningún log
// lo diga. Por eso se vigilan aquí, leyendo los mismos ficheros que se
// despliegan.

type doc map[string]any

func docs(t *testing.T, path string) []doc {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	var out []doc
	for {
		var d doc
		if err := dec.Decode(&d); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if d != nil {
			out = append(out, d)
		}
	}
	return out
}

func find(t *testing.T, ds []doc, kind, name string) doc {
	t.Helper()
	for _, d := range ds {
		md, _ := d["metadata"].(doc)
		if d["kind"] == kind && md["name"] == name {
			return d
		}
	}
	t.Fatalf("no hay %s/%s", kind, name)
	return nil
}

// m recorre un mapa por claves.
func m(v any, keys ...string) any {
	for _, k := range keys {
		mm, ok := v.(doc)
		if !ok {
			return nil
		}
		v = mm[k]
	}
	return v
}

func asInt(v any) int {
	n, _ := v.(int)
	return n
}

// turnConfig: el bloque `turn` de la configuración de LiveKit, que va como
// texto dentro del ConfigMap.
func turnConfig(t *testing.T, ds []doc) doc {
	t.Helper()
	raw, _ := m(find(t, ds, "ConfigMap", "livekit-config"), "data", "livekit.yaml").(string)
	var conf doc
	if err := yaml.Unmarshal([]byte(raw), &conf); err != nil {
		t.Fatal(err)
	}
	turn, _ := conf["turn"].(doc)
	if turn == nil {
		t.Fatal("la configuración de LiveKit no tiene bloque turn")
	}
	return turn
}

// El puerto de TURN es el mismo en los tres sitios: donde escucha LiveKit, el
// Service y el TCPRoute. Y el TLS lo termina Envoy (`external_tls`): sin eso,
// LiveKit esperaría TLS sobre una conexión que Envoy ya descifró.
func TestTheTurnPortMatchesAcrossTheManifests(t *testing.T) {
	lk := docs(t, "5-livekit.yaml")
	turn := turnConfig(t, lk)
	if turn["enabled"] != true || turn["external_tls"] != true {
		t.Fatalf("TURN tiene que estar encendido y con el TLS fuera: %v", turn)
	}
	port := asInt(turn["tls_port"])

	svcPort := 0
	for _, p := range m(find(t, lk, "Service", "livekit"), "spec", "ports").([]any) {
		if pp := p.(doc); pp["name"] == "turn-tls" {
			svcPort = asInt(pp["targetPort"])
		}
	}
	route := find(t, docs(t, "6-livekit-route.yaml"), "TCPRoute", "livekit-turn-route")
	rules := m(route, "spec", "rules").([]any)
	backend := m(rules[0], "backendRefs").([]any)[0].(doc)
	parent := m(route, "spec", "parentRefs").([]any)[0].(doc)

	if port == 0 || svcPort != port || asInt(backend["port"]) != port {
		t.Fatalf("el puerto de TURN no casa: livekit %d, service %d, ruta %d", port, svcPort, asInt(backend["port"]))
	}
	// Con sección: sin ella el TCPRoute se ataría también al listener de
	// Postgres.
	if parent["sectionName"] != "turn-tls" {
		t.Fatalf("el TCPRoute cuelga de %v", parent["sectionName"])
	}
}

// El relé, fuera de los NodePorts de Kubernetes (30000-32767). El rango por
// defecto de LiveKit (30000-40000) se pisa con ellos, y el Gateway mismo tiene
// NodePorts ahí: una asignación que coincidiera dejaría a alguien sin relé.
func TestTheRelayRangeStaysOutOfTheNodePorts(t *testing.T) {
	turn := turnConfig(t, docs(t, "5-livekit.yaml"))
	from, to := asInt(turn["relay_range_start"]), asInt(turn["relay_range_end"])
	if from == 0 || to < from {
		t.Fatalf("rango del relé sin poner: %d-%d", from, to)
	}
	if from <= 32767 && to >= 30000 {
		t.Fatalf("el relé %d-%d se pisa con los NodePorts 30000-32767", from, to)
	}
}

// El dominio que anuncia LiveKit es el que el script mete en el certificado y
// en el listener del Gateway. Si se separan, el navegador pide un TLS que el
// Gateway no sabe a quién dar.
func TestTheTurnDomainIsTheOneTheGatewayServes(t *testing.T) {
	domain, _ := turnConfig(t, docs(t, "5-livekit.yaml"))["domain"].(string)
	script, err := os.ReadFile("../../infra/k8s/turn-setup.sh")
	if err != nil {
		t.Fatal(err)
	}
	if domain == "" || !strings.Contains(string(script), "HOST="+domain+"\n") ||
		!strings.Contains(string(script), `"hostname":"`+domain+`"`) {
		t.Fatalf("el dominio de TURN (%q) no es el que configura turn-setup.sh", domain)
	}
}
