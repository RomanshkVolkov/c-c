package repository

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Construir la imagen de un commit en el servidor (v6, 14-oct-2026), para los
// proyectos que se quedaron sin minutos de GitHub Actions.
//
// Como las migraciones, con un **job de Swarm**, pero de la imagen oficial de
// Docker con buildx en vez de la de la app: el agente no lleva git ni buildx,
// y no hace falta. El job habla con el Docker del host por su socket y
// construye ahí, así que la imagen queda en el servidor sin subirla a ningún
// registro.
//
//   - **El código lo clona BuildKit** desde el contexto remoto
//     `https://github.com/<repo>.git#<sha>:<carpeta>`, con el token de la
//     GitHub App como el secret `GIT_AUTH_TOKEN`: nunca en la línea de
//     comandos, nunca en un log.
//   - **Los build args** son Docker secrets del servicio, montados en el job:
//     se exportan al entorno y van como `--build-arg NOMBRE`, sin valor, que
//     buildx lee del entorno. Ningún valor en argv.

// BuildImage: con qué se construye. La oficial, con buildx dentro; fijada para
// que un cambio de versión no llegue sin que nadie lo decida.
const BuildImage = "docker:27.5-cli"

// BuildTokenFile: el fichero del token dentro del job.
const BuildTokenFile = "cac_git_token"

// BuildRequest: lo que hay que construir (el BuildSpec del backend, ya en
// manos del agente).
type BuildRequest struct {
	Repo       string
	Sha        string
	Dockerfile string
	Context    string
	BuildArgs  []string
	// Image: `repo:tag` a crear en el host.
	Image string
	// MemoryMB: el tope de memoria del build (ver BuildMemoryMB). 0: sin
	// constructor propio, en el BuildKit de dockerd y sin límites, como hasta
	// la v7.
	MemoryMB int
}

// BuilderImage: el BuildKit del constructor propio, fijado como BuildImage.
const BuilderImage = "moby/buildkit:v0.33.1"

// builderCPUShares: el peso del build frente al resto, que va con el de
// Docker por defecto (1024). No es un tope: con la máquina tranquila el build
// usa todo el procesador; sólo cuando alguien más lo pide, ese gana. En boaty
// (2 núcleos) un build de Next dejaba sin contestar a la web y al agente.
const builderCPUShares = 256

// buildCacheKeep: cuánta caché de builds se guarda al acabar. En boaty había
// 14 GB, casi 11 sin usar.
const buildCacheKeep = "5gb"

// buildMemoryReserve: lo que el build deja para los demás.
const buildMemoryReserve = 2048

// buildFreeMargin: lo que se deja libre además de lo que ya está en uso.
const buildFreeMargin = 512

// BuildMemoryMB: el tope de memoria de un build, según la memoria total y la
// que está **libre de verdad** al empezar (`MemAvailable`, en bytes).
//
// Hasta la v9 era «todo menos 2 GB», que en boaty (8 GB, con SQL Server en
// 2,5) dejaba al build 5,9 GB: más de lo libre. El kernel hacía sitio
// mandando a la swap la memoria fría de SQL Server, y la web iba lenta
// después hasta que volvía (18-oct-2026: 879 MB de SQL Server en swap). Ahora
// el tope es lo menor de las dos cosas, menos un margen, redondeado a 256 MB.
//
// `ok` es false si lo libre no da para un build (menos de 1 GB): mejor un
// deploy que falla diciéndolo que una web lenta. Sin saber la memoria total,
// 0 y ok: se construye como antes, sin tope.
func BuildMemoryMB(total, available int64) (mb int, ok bool) {
	if total <= 0 {
		return 0, true
	}
	mb = int(total/(1<<20)) - buildMemoryReserve
	if available > 0 {
		if free := int(available/(1<<20)) - buildFreeMargin; free < mb {
			mb = free
		}
	}
	mb = mb / 256 * 256
	if mb < 1024 {
		return mb, false
	}
	return mb, true
}

// MemAvailable: la memoria libre de verdad de la máquina, en bytes. El
// `/proc/meminfo` de un contenedor es el de la máquina.
func MemAvailable() int64 {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(l, "MemAvailable:") {
			f := strings.Fields(l)
			if len(f) >= 2 {
				if kb, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}

// BuilderName: el constructor de los builds. Uno solo, con su caché: el tope
// se le cambia en cada build con `docker update` (ver BuildScript). Hasta la
// v9 el tope iba en el nombre, y con un tope que cambia según la memoria libre
// cada build habría estrenado constructor con la caché vacía.
const BuilderName = "cac-build"

var (
	buildRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
	buildShaPattern  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	buildArgPattern  = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,39}$`)
	buildPathPattern = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,299}$`)
	buildImagePat    = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:-]{0,399}$`)
)

func validBuildPath(p string) bool {
	if p == "" {
		return true
	}
	if !buildPathPattern.MatchString(p) {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

// Validate: lo que va al guion tiene que tener la forma que se espera. El
// backend ya lo comprobó; esta es la máquina, y el guion es una shell.
func (b BuildRequest) Validate() error {
	switch {
	case !buildRepoPattern.MatchString(b.Repo):
		return fmt.Errorf("el repo %q no tiene forma de owner/name", b.Repo)
	case !buildShaPattern.MatchString(b.Sha):
		return fmt.Errorf("construir es de un commit entero, no de %q", b.Sha)
	case !validBuildPath(b.Dockerfile) || b.Dockerfile == "":
		return fmt.Errorf("el Dockerfile %q no es una ruta del repo", b.Dockerfile)
	case !validBuildPath(b.Context):
		return fmt.Errorf("la carpeta %q no es una ruta del repo", b.Context)
	case !buildImagePat.MatchString(b.Image):
		return fmt.Errorf("la imagen %q no tiene forma de repo:tag", b.Image)
	}
	for _, a := range b.BuildArgs {
		if !buildArgPattern.MatchString(a) {
			return fmt.Errorf("%q no es un nombre de build arg", a)
		}
	}
	return nil
}

// RemoteContext: de dónde clona BuildKit. El sha y no la rama: se construye
// exactamente el commit que se pidió, aunque la rama se haya movido.
func (b BuildRequest) RemoteContext() string {
	ctx := "https://github.com/" + b.Repo + ".git#" + b.Sha
	if b.Context != "" {
		ctx += ":" + strings.Trim(b.Context, "/")
	}
	return ctx
}

// BuildScript: lo que corre dentro del job. Pura, para probarla sin Docker.
// Cada nombre ya pasó por Validate, así que puede ir a la shell tal cual.
func BuildScript(b BuildRequest) (string, error) {
	if err := b.Validate(); err != nil {
		return "", err
	}
	var s strings.Builder
	s.WriteString("set -eu\n")
	for _, a := range b.BuildArgs {
		// Del fichero al entorno, sin pasar por la línea de comandos.
		fmt.Fprintf(&s, "%s=\"$(cat /run/secrets/%s)\"; export %s\n", a, a, a)
	}
	builder := ""
	if b.MemoryMB > 0 {
		// Un constructor propio (driver `docker-container`): el BuildKit de
		// dockerd construye dentro del demonio y ahí no hay tope que valga.
		// `--bootstrap` lo arranca ya, para que si no se puede (sin red a
		// Docker Hub, por ejemplo) se sepa aquí y se construya como antes en
		// vez de fallar el deploy.
		fmt.Fprintf(&s, `B=%s
BUILDER=""
if docker buildx inspect --bootstrap "$B" >/dev/null 2>&1 || docker buildx create --bootstrap --name "$B" --driver docker-container --driver-opt image=%s --driver-opt memory=%dm --driver-opt memory-swap=%dm --driver-opt cpu-shares=%d >/dev/null; then
  BUILDER="--builder $B"
  if docker update --memory %dm --memory-swap %dm "buildx_buildkit_${B}0" >/dev/null 2>&1; then
    echo "cac: build con prioridad baja de CPU y un tope de %d MB (la memoria libre ahora)"
  else
    echo "cac: no se pudo ajustar el tope del constructor; se usa el que tenía"
  fi
else
  echo "cac: no se pudo preparar el constructor con límites; se construye sin ellos"
fi
`, BuilderName, BuilderImage, b.MemoryMB, b.MemoryMB, builderCPUShares, b.MemoryMB, b.MemoryMB, b.MemoryMB)
		builder = " $BUILDER"
	}
	s.WriteString("docker buildx build" + builder + " --progress=plain")
	fmt.Fprintf(&s, " --secret id=GIT_AUTH_TOKEN,src=/run/secrets/%s", BuildTokenFile)
	for _, a := range b.BuildArgs {
		// Como build arg (lo que lee un `ARG` de hoy) y como secret de
		// BuildKit (`RUN --mount=type=secret,id=NOMBRE`, que no deja el valor
		// en el historial de la imagen).
		fmt.Fprintf(&s, " --build-arg %s --secret id=%s,src=/run/secrets/%s", a, a, a)
	}
	fmt.Fprintf(&s, " -f %s -t %s --load %s\n", b.Dockerfile, b.Image, b.RemoteContext())
	// Sólo tras un build bueno (`set -e`), y sin que un fallo al limpiar
	// tumbe un deploy que ya construyó.
	fmt.Fprintf(&s, "docker buildx prune%s --force --keep-storage %s >/dev/null 2>&1 || true\n", builder, buildCacheKeep)
	if builder != "" {
		// Parado al acabar: el contenedor de BuildKit se quedaba encendido entre
		// builds ocupando memoria (en boaty, 233 MB 24 horas sin hacer nada).
		// La caché vive en su volumen, y el siguiente build lo arranca solo.
		s.WriteString(`[ -n "$BUILDER" ] && docker buildx stop "$B" >/dev/null 2>&1 || true` + "\n")
	}
	return s.String(), nil
}

// BuildSecret: un Docker secret que se monta en el job, con el nombre del
// fichero dentro.
type BuildSecret struct {
	ID, Name, File string
}

// BuildJobSpec: el job que construye. Pura. Con el socket del host (para
// construir ahí), los secrets del build y el del token, y sin reintentos: un
// build que falla se cuenta, no se repite.
func BuildJobSpec(name, origin, script string, secrets []BuildSecret) map[string]any {
	sort.Slice(secrets, func(i, j int) bool { return secrets[i].File < secrets[j].File })
	mounted := make([]map[string]any, 0, len(secrets))
	for _, s := range secrets {
		mounted = append(mounted, map[string]any{
			"SecretID": s.ID, "SecretName": s.Name,
			"File": map[string]any{"Name": s.File, "UID": "0", "GID": "0", "Mode": 0o400},
		})
	}
	return map[string]any{
		"Name":   name,
		"Labels": map[string]string{"cac.build.of": origin},
		"TaskTemplate": map[string]any{
			"ContainerSpec": map[string]any{
				"Image":   BuildImage,
				"Command": []string{"sh", "-c", script},
				"Mounts": []map[string]any{{
					"Type": "bind", "Source": "/var/run/docker.sock", "Target": "/var/run/docker.sock",
				}},
				"Secrets": mounted,
			},
			// Donde está el socket que se monta: el manager, que en un
			// servidor de un nodo es el único.
			"Placement":     map[string]any{"Constraints": []string{"node.role == manager"}},
			"RestartPolicy": map[string]any{"Condition": "none"},
		},
		"Mode": map[string]any{"ReplicatedJob": map[string]any{"MaxConcurrent": 1, "TotalCompletions": 1}},
	}
}

// ─── Lo que el build pide a Docker ────────────────────────────────────────────

// FindServiceSecret: la versión vigente del Docker secret `key` de un
// servicio, como lo deja la rotación de la app (etiquetas `cac.service` y
// `cac.key`). Si hay varias (la puesta y la de antes), la más nueva.
func (c *DockerClient) FindServiceSecret(ctx context.Context, service, key string) (id, name string, err error) {
	f, _ := json.Marshal(map[string][]string{"label": {"cac.service=" + service, "cac.key=" + key}})
	var list []struct {
		ID        string `json:"ID"`
		CreatedAt string `json:"CreatedAt"`
		Spec      struct {
			Name string `json:"Name"`
		} `json:"Spec"`
	}
	if err := c.get(ctx, "/secrets?filters="+url.QueryEscape(string(f)), &list); err != nil {
		return "", "", err
	}
	if len(list) == 0 {
		return "", "", fmt.Errorf("el servicio %s no tiene el secret %s: llévalo desde cac (Secrets → Rotar)", service, key)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt > list[j].CreatedAt })
	return list[0].ID, list[0].Spec.Name, nil
}

// CreateSecret crea un Docker secret y devuelve su id.
func (c *DockerClient) CreateSecret(ctx context.Context, name string, data []byte, labels map[string]string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"Name": name, "Labels": labels, "Data": base64.StdEncoding.EncodeToString(data),
	})
	var out struct {
		ID      string `json:"ID"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/secrets/create", body, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("docker no creó el secret %s: %s", name, out.Message)
	}
	return out.ID, nil
}

// RemoveSecret borra un secret; uno que ya no está no es un error.
func (c *DockerClient) RemoveSecret(ctx context.Context, id string) error {
	return c.delete(ctx, "/secrets/"+id, "secret")
}

// CreateJob crea un servicio (un job) con el spec dado y devuelve su id.
func (c *DockerClient) CreateJob(ctx context.Context, spec map[string]any) (string, error) {
	body, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	var out struct {
		ID      string `json:"ID"`
		Message string `json:"message"`
	}
	if err := c.post(ctx, "/services/create", body, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("docker no creó el job: %s", out.Message)
	}
	return out.ID, nil
}

// NodeCount: cuántos nodos tiene el swarm. Una imagen construida en el host
// sólo existe en ese nodo.
func (c *DockerClient) NodeCount(ctx context.Context) (int, error) {
	var nodes []json.RawMessage
	if err := c.get(ctx, "/nodes", &nodes); err != nil {
		return 0, err
	}
	return len(nodes), nil
}

// HostMemory: la memoria de la máquina, en bytes (`MemTotal` de /info).
func (c *DockerClient) HostMemory(ctx context.Context) (int64, error) {
	var info struct {
		MemTotal int64 `json:"MemTotal"`
	}
	if err := c.get(ctx, "/info", &info); err != nil {
		return 0, err
	}
	return info.MemTotal, nil
}

func (c *DockerClient) post(ctx context.Context, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL(path), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil && resp.StatusCode < 400 {
		return err
	}
	if resp.StatusCode >= 400 {
		var e struct {
			Message string `json:"message"`
		}
		b, _ := json.Marshal(out)
		_ = json.Unmarshal(b, &e)
		return fmt.Errorf("docker %s: %s %s", path, resp.Status, e.Message)
	}
	return nil
}

func (c *DockerClient) delete(ctx context.Context, path, what string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiURL(path), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("docker no borró el %s: %s", what, resp.Status)
	}
	return nil
}
