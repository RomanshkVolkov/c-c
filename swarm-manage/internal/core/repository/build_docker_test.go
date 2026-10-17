package repository

import (
	"os/exec"
	"strings"
	"testing"
)

const sha40 = "abc1234def5678abc1234def5678abc1234def56"

func req() BuildRequest {
	return BuildRequest{
		Repo: "dwit-mexico/boat", Sha: sha40, Dockerfile: "Dockerfile", Context: "boat",
		BuildArgs: []string{"DATABASE_URL", "NEXT_PUBLIC_STRIPE_KEY"}, Image: "ghcr.io/dwit-mexico/boat:abc1234",
	}
}

// El guion del build: los valores salen de ficheros al entorno y nunca van a
// la línea de comandos; el contexto es el commit exacto con su carpeta; y el
// token, como secret de BuildKit.
// Mutantes: `--build-arg NOMBRE=valor`; la rama o nada en vez del sha; sin la
// carpeta; el token en la URL.
func TestTheBuildScriptKeepsValuesOutOfArgv(t *testing.T) {
	s, err := BuildScript(req())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`DATABASE_URL="$(cat /run/secrets/DATABASE_URL)"; export DATABASE_URL`,
		" --build-arg DATABASE_URL --secret id=DATABASE_URL,src=/run/secrets/DATABASE_URL ",
		" --build-arg NEXT_PUBLIC_STRIPE_KEY --secret id=NEXT_PUBLIC_STRIPE_KEY,src=/run/secrets/NEXT_PUBLIC_STRIPE_KEY ",
		" --secret id=GIT_AUTH_TOKEN,src=/run/secrets/" + BuildTokenFile,
		" https://github.com/dwit-mexico/boat.git#" + sha40 + ":boat\n",
		" -t ghcr.io/dwit-mexico/boat:abc1234 ",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("al guion le falta %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "--build-arg DATABASE_URL=") || strings.Contains(s, "@github.com") {
		t.Fatalf("un valor o el token en la línea de comandos:\n%s", s)
	}
}

// Lo que llega del backend va a una shell: lo que no tiene su forma se
// rechaza antes de escribir el guion. Mutantes: no mirar los nombres; aceptar
// `..`; aceptar un sha corto.
func TestTheBuildScriptRefusesWhatIsNotItsShape(t *testing.T) {
	for name, mod := range map[string]func(*BuildRequest){
		"build arg con shell": func(r *BuildRequest) { r.BuildArgs = []string{"X;rm -rf /"} },
		"ruta fuera":          func(r *BuildRequest) { r.Context = "../etc" },
		"sha corto":           func(r *BuildRequest) { r.Sha = "abc1234" },
		"repo raro":           func(r *BuildRequest) { r.Repo = "a/b;c" },
		"dockerfile vacío":    func(r *BuildRequest) { r.Dockerfile = "" },
	} {
		r := req()
		mod(&r)
		if _, err := BuildScript(r); err == nil {
			t.Errorf("%s: se aceptó", name)
		}
	}
}

// El job: la imagen de Docker con buildx, el socket del host, los secrets con
// el nombre de fichero que espera el guion, y sin reintentos.
// Mutantes: sin el socket; reintentar; montar el secret con su nombre de
// Docker en vez del de fichero.
func TestTheBuildJobMountsTheSocketAndTheSecrets(t *testing.T) {
	spec := BuildJobSpec("boat_app-build-1", "boat_app", "true", []BuildSecret{
		{ID: "s2", Name: "cac_DATABASE_URL_0011223344556677", File: "DATABASE_URL"},
		{ID: "s1", Name: "cac_build_token_1", File: BuildTokenFile},
	})
	tt := spec["TaskTemplate"].(map[string]any)
	cs := tt["ContainerSpec"].(map[string]any)
	if cs["Image"] != BuildImage {
		t.Fatalf("imagen %v", cs["Image"])
	}
	m := cs["Mounts"].([]map[string]any)
	if len(m) != 1 || m[0]["Source"] != "/var/run/docker.sock" {
		t.Fatalf("sin el socket: %v", m)
	}
	secrets := cs["Secrets"].([]map[string]any)
	files := []string{}
	for _, s := range secrets {
		files = append(files, s["File"].(map[string]any)["Name"].(string))
	}
	if strings.Join(files, ",") != "DATABASE_URL,"+BuildTokenFile {
		t.Fatalf("ficheros %v", files)
	}
	if tt["RestartPolicy"].(map[string]any)["Condition"] != "none" {
		t.Fatalf("un build que falla se reintenta: %v", tt["RestartPolicy"])
	}
}

// El tope de un build: todo menos 2 GB para lo que ya corre, con un suelo de
// 1 GB, y sin tope si no se sabe cuánta memoria hay.
// Mutantes: sin la reserva; sin el suelo; un tope inventado sin saber.
func TestTheBuildLeavesMemoryForTheRest(t *testing.T) {
	for total, want := range map[int64]int{8 << 30: 6144, 2 << 30: 1024, 0: 0} {
		if got := BuildMemoryMB(total); got != want {
			t.Errorf("con %d bytes: %d MB, se esperaba %d", total, got, want)
		}
	}
}

// Con tope, el build va por un constructor propio con la memoria, sin swap
// propia y con poco peso de CPU, y limpia la caché **después** de construir;
// si el constructor no arranca, construye como antes. Sin tope, como hasta
// la v7. Y el guion es shell válida.
// Mutantes: sin `cpu-shares`; `memory-swap` sin poner (el build se va a la
// swap de la máquina); limpiar antes de construir; fallar sin constructor.
func TestTheBuildScriptCapsTheBuilder(t *testing.T) {
	r := req()
	r.MemoryMB = 5894
	s, err := BuildScript(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--driver docker-container --driver-opt image=" + BuilderImage,
		"--driver-opt memory=5894m --driver-opt memory-swap=5894m --driver-opt cpu-shares=256",
		"B=" + BuilderName(5894),
		`BUILDER="--builder $B"`,
		"docker buildx build $BUILDER --progress=plain",
		"docker buildx prune $BUILDER --force --keep-storage 5gb",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("al guion le falta %q:\n%s", want, s)
		}
	}
	if strings.Index(s, "docker buildx prune") < strings.Index(s, "docker buildx build") {
		t.Errorf("limpia la caché antes de construir:\n%s", s)
	}
	if !strings.Contains(s, "else\n  echo") {
		t.Errorf("sin constructor, el build no sigue:\n%s", s)
	}

	plain, _ := BuildScript(req())
	if strings.Contains(plain, "cac-build") || !strings.Contains(plain, "docker buildx build --progress=plain") {
		t.Errorf("sin tope, el guion cambió:\n%s", plain)
	}

	for _, sc := range []string{s, plain} {
		if out, err := exec.Command("sh", "-n", "-c", sc).CombinedOutput(); err != nil {
			t.Errorf("el guion no es shell válida: %v %s\n%s", err, out, sc)
		}
	}
}
