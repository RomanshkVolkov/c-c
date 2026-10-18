package repository

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Contra un Docker de verdad, sólo con CAC_DOCKER_IT=1: lo que el agente hace
// dentro del contenedor de una base no lo puede contestar un doble. Arranca un
// alpine desechable y lo borra al acabar.
// Mutantes: no separar stdout de stderr; perder el código de salida; que
// CopyFrom devuelva el tar y no el fichero.
func TestExecAndCopyAgainstRealDocker(t *testing.T) {
	if os.Getenv("CAC_DOCKER_IT") != "1" {
		t.Skip("CAC_DOCKER_IT no está puesto")
	}
	out, err := exec.Command("docker", "run", "-d", "--rm", "-e", "SECRET_PW=hunter2", "alpine:3.20", "sleep", "300").Output()
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimSpace(string(out))
	defer exec.Command("docker", "rm", "-f", id).Run()

	c := NewDockerClient()
	ctx := context.Background()

	// La contraseña la lee el shell **dentro** del contenedor.
	var stdout bytes.Buffer
	res, err := c.Exec(ctx, id, []string{"sh", "-c", `echo "pw=$SECRET_PW db=$DB"; echo oops >&2; exit 3`}, []string{"DB=boaty"}, &stdout)
	if err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "pw=hunter2 db=boaty\n" || strings.TrimSpace(res.Stderr) != "oops" || res.ExitCode != 3 {
		t.Fatalf("stdout %q stderr %q código %d", stdout.String(), res.Stderr, res.ExitCode)
	}

	// Un fichero de ida y vuelta, más grande que un trozo del flujo.
	big := bytes.Repeat([]byte("0123456789"), 300_000)
	if err := c.CopyTo(ctx, id, "/tmp", "x.sql", int64(len(big)), bytes.NewReader(big)); err != nil {
		t.Fatal(err)
	}
	r, size, err := c.CopyFrom(ctx, id, "/tmp/x.sql")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(r)
	r.Close()
	if size != int64(len(big)) || !bytes.Equal(got, big) {
		t.Fatalf("ida y vuelta: %d bytes (tamaño %d), se mandaron %d", len(got), size, len(big))
	}
}
