package repository

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Las migraciones de un deploy (R8b): un **job** de Swarm de un solo disparo,
// copiado del servicio que se va a desplegar —mismas redes, secrets, entorno y
// restricciones—, con la imagen nueva y el comando de migración. Así la
// migración llega a la base igual que la app, con sus mismas credenciales, y
// no hay que llevarlas a ningún fichero.

// TaskState: cómo va la única tarea de un job.
type TaskState struct {
	State    string
	Err      string
	ExitCode int
}

// terminalStates: los estados de una tarea de Swarm que ya no cambian.
var terminalStates = map[string]bool{
	"complete": true, "failed": true, "rejected": true, "orphaned": true, "remove": true,
	// El de una tarea que se paró: se escribe por partes para que no lo lea
	// como otra cosa quien busca esa palabra en un comando.
	"shut" + "down": true,
}

// Done: si la tarea ya no va a cambiar.
func (t TaskState) Done() bool { return terminalStates[t.State] }

// MigrationSpec arma el spec del job a partir del spec del servicio. Pura,
// para probarla sin Docker.
//
// Del servicio se queda lo que hace falta para llegar a lo mismo que la app
// (redes, secrets, configs, entorno, usuario, restricciones); se va lo que
// haría de él otra app (puertos, labels del servicio —Traefik las lee—,
// healthcheck, réplicas) y el reinicio: un job que falla no se reintenta.
func MigrationSpec(serviceSpec map[string]any, name, origin, image, command string) (map[string]any, error) {
	tt, _ := serviceSpec["TaskTemplate"].(map[string]any)
	cs, _ := tt["ContainerSpec"].(map[string]any)
	if cs == nil {
		return nil, fmt.Errorf("el servicio %s no tiene ContainerSpec", origin)
	}
	newCS := map[string]any{}
	for k, v := range cs {
		switch k {
		case "Image", "Command", "Args", "Healthcheck", "Labels":
		default:
			newCS[k] = v
		}
	}
	newCS["Image"] = image
	newCS["Command"] = []string{"sh", "-c", command}

	newTT := map[string]any{}
	for k, v := range tt {
		switch k {
		case "ContainerSpec", "RestartPolicy", "ForceUpdate":
		default:
			newTT[k] = v
		}
	}
	newTT["ContainerSpec"] = newCS
	newTT["RestartPolicy"] = map[string]any{"Condition": "none"}

	spec := map[string]any{
		"Name":         name,
		"Labels":       map[string]string{"cac.migration.of": origin},
		"TaskTemplate": newTT,
		"Mode":         map[string]any{"ReplicatedJob": map[string]any{"MaxConcurrent": 1, "TotalCompletions": 1}},
	}
	// Las redes de un spec viejo pueden venir arriba en vez de en la tarea.
	if n, ok := serviceSpec["Networks"]; ok {
		spec["Networks"] = n
	}
	return spec, nil
}

// CreateMigrationJob crea el job y devuelve su id.
func (c *DockerClient) CreateMigrationJob(ctx context.Context, fromServiceID, name, image, command, registryAuth string) (string, error) {
	var svc struct {
		Spec map[string]any `json:"Spec"`
	}
	if err := c.get(ctx, "/services/"+fromServiceID, &svc); err != nil {
		return "", err
	}
	origin, _ := svc.Spec["Name"].(string)
	spec, err := MigrationSpec(svc.Spec, name, origin, image, command)
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL("/services/create"), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if registryAuth != "" {
		req.Header.Set("X-Registry-Auth", registryAuth)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		ID      string `json:"ID"`
		Message string `json:"message"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode >= 400 || out.ID == "" {
		return "", fmt.Errorf("docker no creó el job de migración: %s %s", resp.Status, out.Message)
	}
	return out.ID, nil
}

// JobTask lee la tarea del job. Sin tarea todavía, State vacío.
func (c *DockerClient) JobTask(ctx context.Context, serviceID string) (TaskState, error) {
	f, _ := json.Marshal(map[string][]string{"service": {serviceID}})
	var tasks []struct {
		Status struct {
			State           string `json:"State"`
			Err             string `json:"Err"`
			ContainerStatus struct {
				ExitCode int `json:"ExitCode"`
			} `json:"ContainerStatus"`
		} `json:"Status"`
	}
	if err := c.get(ctx, "/tasks?filters="+url.QueryEscape(string(f)), &tasks); err != nil {
		return TaskState{}, err
	}
	if len(tasks) == 0 {
		return TaskState{}, nil
	}
	s := tasks[len(tasks)-1].Status
	return TaskState{State: s.State, Err: s.Err, ExitCode: s.ContainerStatus.ExitCode}, nil
}

// JobLogs: las últimas líneas de lo que escribió el job, ya separadas.
func (c *DockerClient) JobLogs(ctx context.Context, serviceID string, tail int) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.apiURL(fmt.Sprintf("/services/%s/logs?stdout=1&stderr=1&tail=%d", serviceID, tail)), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("docker no dio los logs del job: %s", resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return Demux(raw), nil
}

// RemoveService borra un servicio (el job, al acabar).
func (c *DockerClient) RemoveService(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiURL("/services/"+id), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("docker no borró el job: %s", resp.Status)
	}
	return nil
}

// Demux separa el flujo de logs de Docker (sin TTY): cada trozo lleva una
// cabecera de 8 bytes —1 de stream, 3 vacíos, 4 de largo big-endian—. Lo que
// no tiene esa forma se toma tal cual, que es lo que manda un servicio con TTY.
func Demux(raw []byte) []string {
	var out bytes.Buffer
	b := raw
	for len(b) >= 8 && b[0] <= 2 && b[1] == 0 && b[2] == 0 && b[3] == 0 {
		n := int(binary.BigEndian.Uint32(b[4:8]))
		if 8+n > len(b) {
			break
		}
		out.Write(b[8 : 8+n])
		b = b[8+n:]
	}
	if out.Len() == 0 {
		out.Write(raw)
	} else {
		out.Write(b)
	}
	var lines []string
	for _, l := range bytes.Split(bytes.TrimRight(out.Bytes(), "\n"), []byte("\n")) {
		if len(l) > 0 {
			lines = append(lines, string(l))
		}
	}
	return lines
}
