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

// El tope de un build: lo menor entre «todo menos 2 GB» y «lo libre menos
// 512 MB», en pasos de 256 MB; sin tope si no se sabe; y si lo libre no da
// para 1 GB, no se construye.
// Mutantes: no mirar lo libre (vuelve a mandar la base a la swap); sin la
// reserva; aceptar un tope de menos de 1 GB; un tope inventado sin saber.
func TestTheBuildOnlyUsesFreeMemory(t *testing.T) {
	const gb = int64(1 << 30)
	for _, c := range []struct {
		total, avail int64
		want         int
		ok           bool
	}{
		{8 * gb, 7 * gb, 6144, true},             // mucho libre: manda «todo menos 2 GB»
		{8 * gb, 3584 << 20, 3072, true},         // boaty con SQL Server: manda lo libre
		{8 * gb, 1229 << 20, 512, false},         // poco libre: no se construye
		{8 * gb, 0, 6144, true},                  // sin dato de libre: como antes
		{0, 3 * gb, 0, true},                     // sin dato de total: sin tope
		{8 * gb, (3584 + 100) << 20, 3072, true}, // redondeado a 256 MB
	} {
		mb, ok := BuildMemoryMB(c.total, c.avail)
		if mb != c.want || ok != c.ok {
			t.Errorf("total %d MB, libre %d MB → %d MB ok=%v; se esperaba %d ok=%v", c.total>>20, c.avail>>20, mb, ok, c.want, c.ok)
		}
	}
}

// La swap propia de un build: de la libre, menos medio GB, hasta 4 GB.
// Mutantes: sin margen; sin máximo; sin suelo en cero.
func TestBuildSwapMB(t *testing.T) {
	for _, c := range []struct {
		free int64
		want int
	}{
		{3 << 30, 2560},
		{16 << 30, 4096},
		{300 << 20, 0},
		{0, 0},
		{(1 << 30) + 100<<20, 512},
	} {
		if got := BuildSwapMB(c.free); got != c.want {
			t.Errorf("swap libre %d MB → %d MB; se esperaba %d", c.free>>20, got, c.want)
		}
	}
}

// Con tope, el build va por un constructor propio con la memoria, su swap
// propia acotada (la memoria más SwapMB) y con poco peso de CPU, y limpia la caché **después** de construir;
// si el constructor no arranca, construye como antes. Sin tope, como hasta
// la v7. Y el guion es shell válida.
// Mutantes: sin `cpu-shares`; `memory-swap` sin poner (el build se va a la
// swap de la máquina); limpiar antes de construir; fallar sin constructor.
func TestTheBuildScriptCapsTheBuilder(t *testing.T) {
	r := req()
	r.MemoryMB = 5894
	r.SwapMB = 2048
	s, err := BuildScript(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--driver docker-container --driver-opt image=" + BuilderImage,
		"--driver-opt memory=5894m --driver-opt memory-swap=7942m --driver-opt cpu-shares=256",
		"B=" + BuilderName,
		`docker update --memory 5894m --memory-swap 7942m "buildx_buildkit_${B}0"`,
		`BUILDER="--builder $B"`,
		"docker buildx build $BUILDER --progress=plain",
		"docker buildx prune $BUILDER --force --keep-storage 5gb",
		`docker buildx stop "$B"`,
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
