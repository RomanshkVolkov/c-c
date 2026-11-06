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

// livekitConfig: la configuración de LiveKit, que va como texto dentro del
// ConfigMap.
func livekitConfig(t *testing.T, ds []doc) doc {
	t.Helper()
	raw, _ := m(find(t, ds, "ConfigMap", "livekit-config"), "data", "livekit.yaml").(string)
	var conf doc
	if err := yaml.Unmarshal([]byte(raw), &conf); err != nil {
		t.Fatal(err)
	}
	return conf
}

// turnConfig: el bloque `turn` de la configuración de LiveKit.
func turnConfig(t *testing.T, ds []doc) doc {
	t.Helper()
	turn, _ := livekitConfig(t, ds)["turn"].(doc)
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

// LiveKit no abre media por TCP. Con `hostNetwork` cada puerto que abre queda
// en la IP pública, y el respaldo por TCP ya lo hace TURN por el 443. El 0 tiene
// que estar escrito: si falta la clave, LiveKit abre el 7881 por defecto, así
// que borrar la línea también lo reabre.
func TestLiveKitOpensNoTCPMediaPort(t *testing.T) {
	lk := docs(t, "5-livekit.yaml")
	rtc, _ := livekitConfig(t, lk)["rtc"].(doc)
	if port, set := rtc["tcp_port"]; !set || asInt(port) != 0 {
		t.Fatalf("rtc.tcp_port = %v (escrito: %v): LiveKit abriría media por TCP en la IP pública", port, set)
	}
	containers := m(find(t, lk, "Deployment", "livekit"), "spec", "template", "spec", "containers").([]any)
	for _, p := range m(containers[0], "ports").([]any) {
		if asInt(p.(doc)["containerPort"]) == 7881 {
			t.Fatal("el Deployment sigue declarando el 7881")
		}
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

// Un deploy del backend no deja a nadie sin cac. Con Recreate se caían los dos
// pods a la vez y el proxy contestaba 503 un minuto entero en cada push al
// backend (14-oct-2026: seis deploys, seis ráfagas de 503 en el agente de un
// servidor). Mutantes: volver a Recreate; permitir bajar réplicas; quitar la
// sonda de listo (el proxy mandaría tráfico a un pod que arranca).
func TestABackendDeployKeepsServing(t *testing.T) {
	var dep doc
	for _, d := range docs(t, "2-deployment.yaml") {
		if d["kind"] == "Deployment" {
			dep = d
		}
	}
	if dep == nil {
		t.Fatal("no hay Deployment en 2-deployment.yaml")
	}
	spec := dep["spec"].(doc)
	strategy, _ := spec["strategy"].(doc)
	if strategy["type"] != "RollingUpdate" {
		t.Fatalf("estrategia %v: cada deploy tiraría todos los pods", strategy["type"])
	}
	ru, _ := strategy["rollingUpdate"].(doc)
	if ru["maxUnavailable"] != 0 {
		t.Fatalf("maxUnavailable = %v: un deploy bajaría réplicas", ru["maxUnavailable"])
	}
	containers := spec["template"].(doc)["spec"].(doc)["containers"].([]any)
	api := containers[0].(doc)
	probe, _ := api["readinessProbe"].(doc)
	get, _ := probe["httpGet"].(doc)
	if get["path"] != "/health" {
		t.Fatalf("sin sonda de listo en /health: %v", probe)
	}
}

// El backend reserva CPU y memoria y tiene tope de memoria. Sin reserva es
// BestEffort, y en gstd el nodo lo comparte con el CI de TCG: con la CPU llena
// le tocaba la parte mínima (la API lenta mientras corre un PR), y con la
// memoria corta era lo primero que desalojaba el kubelet, antes que un pod de
// pruebas. Roturas que atrapa: quitar `resources`, o cualquiera de las tres.
func TestTheBackendReservesWhatItNeeds(t *testing.T) {
	var dep doc
	for _, d := range docs(t, "2-deployment.yaml") {
		if d["kind"] == "Deployment" {
			dep = d
		}
	}
	api := m(dep, "spec", "template", "spec").(doc)["containers"].([]any)[0].(doc)
	for _, path := range [][]string{{"requests", "cpu"}, {"requests", "memory"}, {"limits", "memory"}} {
		if v, _ := m(api["resources"], path...).(string); v == "" {
			t.Errorf("cac-service sin resources.%s: es BestEffort y cede ante el CI", strings.Join(path, "."))
		}
	}
}

// Los mismos manifiestos se despliegan en dos clústeres a la vez hasta la
// mudanza: en pixel-vps a `default` (por SSH) y en gstd a `cac` (deploy.sh,
// con `-n cac`). Eso sólo funciona si ningún manifiesto fija su namespace: uno
// que dijera `namespace: default` aparecería en el `default` de gstd, junto al
// Gateway y sus certificados, con permisos que el runner no tiene. El
// `namespace` de un parentRefs sí va: es donde vive el Gateway, no el recurso.
//
// Roturas que atrapa: volver a poner `metadata.namespace` en uno de los
// ficheros que se aplican; que deploy.sh deje de aplicar alguno.
func TestDeployedManifestsDoNotPinTheirNamespace(t *testing.T) {
	deployed := []string{"0-rbac.yaml", "2-deployment.yaml", "3-service.yaml", "4-http-route.yaml",
		"5-livekit.yaml", "6-livekit-route.yaml", "7-livekit-egress.yaml", "../../app/web/k8s.yaml",
		"../../transcriber/k8s/mux.yaml"}
	for _, f := range deployed {
		ds := docs(t, f)
		if len(ds) == 0 {
			t.Fatalf("%s: sin documentos", f)
		}
		for _, d := range ds {
			md, ok := d["metadata"].(doc)
			if !ok {
				t.Fatalf("%s: %v sin metadata legible", f, d["kind"])
			}
			if ns, ok := md["namespace"]; ok {
				t.Errorf("%s: %v/%v fija namespace %v", f, d["kind"], md["name"], ns)
			}
		}
	}
	script, err := os.ReadFile("deploy.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range deployed[:7] {
		if !strings.Contains(string(script), f) {
			t.Errorf("deploy.sh no aplica %s", f)
		}
	}
	// deploy.sh no maneja secretos (los pone el playbook cac-secrets): si
	// volviera a crearlos, tendría que leerlos de algún sitio del runner.
	for _, bad := range []string{"kind: \"Secret\"", "create secret", "op run", "$ENV"} {
		if strings.Contains(string(script), bad) {
			t.Errorf("deploy.sh vuelve a tocar secretos (%q)", bad)
		}
	}
	// Ni consultar nada de clúster: el runner sólo tiene el Role de su
	// namespace, y `kubectl get namespace` le devolvió «forbidden» en el
	// primer despliegue a gstd (4-nov-2026).
	for _, bad := range []string{"get namespace", "get nodes", "get ns "} {
		if strings.Contains(string(script), "kubectl "+bad) || strings.Contains(string(script), "kubectl -n \"$NS\" "+bad) {
			t.Errorf("deploy.sh consulta algo de clúster (%q)", bad)
		}
	}
	// Lo de clúster no lo puede aplicar el runner: si deploy.sh lo intentara,
	// cada despliegue fallaría con «forbidden».
	if strings.Contains(string(script), "0-rbac-cluster.yaml\n") || strings.Contains(string(script), "0-rbac-cluster.yaml \\") {
		t.Error("deploy.sh aplica 0-rbac-cluster.yaml, que es de clúster")
	}
}

// El repo es público: un job que corre en `gstd` desde un pull_request
// correría el código de un fork dentro del servidor. Roturas que atrapa: un
// workflow que dispare con pull_request o pull_request_target y use `gstd`;
// un job de `gstd` sin su `if` de push o workflow_dispatch en main.
func TestNoGstdJobRunsFromAPullRequest(t *testing.T) {
	for _, wf := range []string{"backend", "web", "transcriber"} {
		path := "../../.github/workflows/" + wf + ".yml"
		d := docs(t, path)[0]
		on, _ := d["on"].(doc)
		jobs, _ := d["jobs"].(doc)
		gstd := 0
		for name, j := range jobs {
			job, _ := j.(doc)
			if job["runs-on"] != "gstd" {
				continue
			}
			gstd++
			cond, _ := job["if"].(string)
			if !strings.Contains(cond, "refs/heads/main") || !strings.Contains(cond, "github.event_name == 'push'") || strings.Contains(cond, "pull_request") {
				t.Errorf("%s: el job %s de gstd no se limita a push/dispatch en main: %q", wf, name, cond)
			}
			// Ningún secreto de cac pasa por GitHub: los pone el playbook
			// cac-secrets desde 1Password. Un `secrets.` en un job de gstd
			// es un secreto que vuelve a vivir en el repo.
			raw, _ := yaml.Marshal(job)
			if strings.Contains(string(raw), "secrets.") {
				t.Errorf("%s: el job %s de gstd lee secretos de GitHub", wf, name)
			}
			for _, ev := range []string{"pull_request", "pull_request_target"} {
				if _, ok := on[ev]; ok {
					t.Errorf("%s dispara con %s y tiene un job en gstd", wf, ev)
				}
			}
		}
		if gstd == 0 {
			t.Errorf("%s no despliega en gstd", wf)
		}
	}
}
