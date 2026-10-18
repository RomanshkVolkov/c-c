package repository

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"syscall"
	"time"
)

// Lo que necesitan los backups de bases (v9, #166): entrar en el contenedor
// de una base a correr una orden —con la contraseña que ese contenedor ya
// tiene en su entorno, que así no sale de él— y sacar o meter un fichero.

// ContainerForService: el contenedor vivo de un servicio **en este nodo**. Una
// base de Swarm con una réplica tiene uno; si no corre aquí, no hay nada que
// hacer desde este agente.
func (c *DockerClient) ContainerForService(ctx context.Context, service string) (string, error) {
	f, _ := json.Marshal(map[string][]string{"service": {service}, "desired-state": {"running"}})
	var tasks []struct {
		Status struct {
			State           string `json:"State"`
			ContainerStatus struct {
				ContainerID string `json:"ContainerID"`
			} `json:"ContainerStatus"`
		} `json:"Status"`
	}
	if err := c.get(ctx, "/tasks?filters="+url.QueryEscape(string(f)), &tasks); err != nil {
		return "", err
	}
	for _, t := range tasks {
		if t.Status.State == "running" && t.Status.ContainerStatus.ContainerID != "" {
			// Que el contenedor esté en este nodo: /containers sólo ve los
			// locales.
			var probe struct{ ID string }
			if err := c.get(ctx, "/containers/"+t.Status.ContainerStatus.ContainerID+"/json", &probe); err == nil {
				return probe.ID, nil
			}
		}
	}
	return "", fmt.Errorf("the service %s has no running container on this node", service)
}

// ExecResult: cómo acabó una orden dentro de un contenedor.
type ExecResult struct {
	ExitCode int
	// Stderr: lo que dijo por la salida de error, con tope. Es donde sqlcmd y
	// pg_dump cuentan qué falló.
	Stderr string
}

// execStderrMax: lo que se guarda de la salida de error.
const execStderrMax = 64 << 10

// Exec corre `cmd` dentro del contenedor, con `env` añadido, y manda su salida
// estándar a `stdout` (en streaming: un pg_dump de gigas no pasa por memoria).
func (c *DockerClient) Exec(ctx context.Context, container string, cmd []string, env []string, stdout io.Writer) (ExecResult, error) {
	body, _ := json.Marshal(map[string]any{
		"AttachStdout": true, "AttachStderr": true, "Tty": false, "Cmd": cmd, "Env": env,
	})
	var created struct{ Id string }
	if err := c.post(ctx, "/containers/"+container+"/exec", body, &created); err != nil {
		return ExecResult{}, fmt.Errorf("exec create: %w", err)
	}
	start, _ := json.Marshal(map[string]any{"Detach": false, "Tty": false})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL("/exec/"+created.Id+"/start"), bytes.NewReader(start))
	if err != nil {
		return ExecResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return ExecResult{}, fmt.Errorf("exec start: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return ExecResult{}, fmt.Errorf("exec start: %s %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	stderr := &capped{max: execStderrMax}
	if err := DemuxStream(resp.Body, stdout, stderr); err != nil {
		return ExecResult{}, fmt.Errorf("exec output: %w", err)
	}
	var inspect struct {
		Running  bool
		ExitCode int
	}
	// Al cerrarse la salida la orden ya acabó, pero Docker puede tardar un
	// instante en apuntar el código.
	for i := 0; i < 50; i++ {
		if err := c.get(ctx, "/exec/"+created.Id+"/json", &inspect); err != nil {
			return ExecResult{}, err
		}
		if !inspect.Running {
			break
		}
		select {
		case <-ctx.Done():
			return ExecResult{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return ExecResult{ExitCode: inspect.ExitCode, Stderr: stderr.String()}, nil
}

// DemuxStream separa en streaming el flujo multiplexado de Docker (sin TTY):
// cada trozo lleva 8 bytes de cabecera —1 de flujo (1 = stdout, 2 = stderr),
// 3 vacíos y 4 de largo— y detrás sus bytes. Como `Demux`, pero sin cargarlo
// todo en memoria.
func DemuxStream(r io.Reader, stdout, stderr io.Writer) error {
	var hdr [8]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		n := int64(binary.BigEndian.Uint32(hdr[4:8]))
		dst := io.Discard
		switch hdr[0] {
		case 1:
			if stdout != nil {
				dst = stdout
			}
		case 2:
			if stderr != nil {
				dst = stderr
			}
		}
		if _, err := io.CopyN(dst, r, n); err != nil {
			return err
		}
	}
}

// capped guarda hasta `max` bytes y descarta el resto.
type capped struct {
	buf bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

func (c *capped) String() string { return c.buf.String() }

// CopyFrom saca un fichero del contenedor. Docker lo da como tar; se devuelve
// el contenido del único fichero, en streaming, y su tamaño.
func (c *DockerClient) CopyFrom(ctx context.Context, container, file string) (io.ReadCloser, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.apiURL("/containers/"+container+"/archive?path="+url.QueryEscape(file)), nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, 0, fmt.Errorf("copy from container: %s %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	tr := tar.NewReader(resp.Body)
	for {
		h, err := tr.Next()
		if err != nil {
			resp.Body.Close()
			return nil, 0, fmt.Errorf("copy from container: %s not in the archive: %w", file, err)
		}
		if h.Typeflag == tar.TypeReg {
			return struct {
				io.Reader
				io.Closer
			}{tr, resp.Body}, h.Size, nil
		}
	}
}

// CopyTo deja un fichero dentro del contenedor, en `dir`, con `name`. Docker
// lo recibe como tar.
func (c *DockerClient) CopyTo(ctx context.Context, container, dir, name string, size int64, content io.Reader) error {
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		err := tw.WriteHeader(&tar.Header{Name: path.Base(name), Mode: 0o644, Size: size, ModTime: time.Now(), Typeflag: tar.TypeReg})
		if err == nil {
			_, err = io.CopyN(tw, content, size)
		}
		if err == nil {
			err = tw.Close()
		}
		pw.CloseWithError(err)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.apiURL("/containers/"+container+"/archive?path="+url.QueryEscape(dir)), pr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-tar")
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("copy to container: %s %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// FreeBytes: el espacio libre en el disco de `dir` (el temporal del agente).
func FreeBytes(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// TempDir: donde el agente deja el fichero cifrado antes de subirlo.
func TempDir() string { return os.TempDir() }

// SelfServiceID: el servicio de Swarm de este agente, por la etiqueta que
// Swarm pone a sus contenedores. El hostname de un contenedor es su id corto.
func (c *DockerClient) SelfServiceID(ctx context.Context) (string, error) {
	host, err := os.Hostname()
	if err != nil {
		return "", err
	}
	var ct struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := c.get(ctx, "/containers/"+host+"/json", &ct); err != nil {
		return "", err
	}
	id := ct.Config.Labels["com.docker.swarm.service.id"]
	if id == "" {
		return "", errors.New("this agent is not running as a Swarm service")
	}
	return id, nil
}

// FindSecretByName: el id del secret con ese nombre exacto, o "" si no hay.
func (c *DockerClient) FindSecretByName(ctx context.Context, name string) (string, error) {
	f, _ := json.Marshal(map[string][]string{"name": {name}})
	var list []struct {
		ID   string `json:"ID"`
		Spec struct {
			Name string `json:"Name"`
		} `json:"Spec"`
	}
	if err := c.get(ctx, "/secrets?filters="+url.QueryEscape(string(f)), &list); err != nil {
		return "", err
	}
	for _, s := range list {
		// El filtro por nombre de Docker casa por prefijo.
		if s.Spec.Name == name {
			return s.ID, nil
		}
	}
	return "", nil
}

// AddSecretToService monta un secret en un servicio, como `/run/secrets/<file>`,
// sin tocar nada más del spec. Si ya lo tiene, no hace nada.
func (c *DockerClient) AddSecretToService(ctx context.Context, serviceID, secretID, secretName, file string) (bool, error) {
	var svc map[string]any
	if err := c.get(ctx, "/services/"+serviceID, &svc); err != nil {
		return false, err
	}
	version := 0
	if v, ok := svc["Version"].(map[string]any); ok {
		if n, ok := v["Index"].(float64); ok {
			version = int(n)
		}
	}
	spec, _ := svc["Spec"].(map[string]any)
	tt, _ := spec["TaskTemplate"].(map[string]any)
	cs, _ := tt["ContainerSpec"].(map[string]any)
	if cs == nil {
		return false, fmt.Errorf("service %s has no ContainerSpec", serviceID)
	}
	secrets, _ := cs["Secrets"].([]any)
	for _, s := range secrets {
		if m, ok := s.(map[string]any); ok && m["SecretName"] == secretName {
			return false, nil
		}
	}
	cs["Secrets"] = append(secrets, map[string]any{
		"SecretID": secretID, "SecretName": secretName,
		"File": map[string]any{"Name": file, "UID": "0", "GID": "0", "Mode": 0o400},
	})
	body, err := json.Marshal(spec)
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.apiURL(fmt.Sprintf("/services/%s/update?version=%d", serviceID, version)), bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return false, fmt.Errorf("service update: %s %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return true, nil
}
