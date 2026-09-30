package repository

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Lo que hace falta de la API de Docker para desplegar una imagen en un
// servicio que ya existe. Todo es `service update` sobre el spec que hay —el
// mismo camino que `ForceUpdateService`—: nunca `stack deploy`, así que un
// stack que creó el CI de un proyecto conserva sus labels, redes y secrets.

// ServiceState es lo que se lee de un servicio para desplegarlo y para saber
// si terminó.
type ServiceState struct {
	ID      string
	Name    string
	Stack   string
	Version int
	Image   string
	// El estado de la última actualización: "" (no hay ninguna), "updating",
	// "completed", "paused", "rollback_started", "rollback_completed"…
	UpdateState   string
	UpdateMessage string
}

type rawService struct {
	ID      string `json:"ID"`
	Version struct {
		Index int `json:"Index"`
	} `json:"Version"`
	Spec struct {
		Name         string            `json:"Name"`
		Labels       map[string]string `json:"Labels"`
		TaskTemplate struct {
			ContainerSpec struct {
				Image string `json:"Image"`
			} `json:"ContainerSpec"`
		} `json:"TaskTemplate"`
	} `json:"Spec"`
	UpdateStatus *struct {
		State   string `json:"State"`
		Message string `json:"Message"`
	} `json:"UpdateStatus"`
}

func (r rawService) state() *ServiceState {
	s := &ServiceState{
		ID: r.ID, Name: r.Spec.Name, Stack: r.Spec.Labels["com.docker.stack.namespace"],
		Version: r.Version.Index, Image: r.Spec.TaskTemplate.ContainerSpec.Image,
	}
	if r.UpdateStatus != nil {
		s.UpdateState, s.UpdateMessage = r.UpdateStatus.State, r.UpdateStatus.Message
	}
	return s
}

// FindService busca un servicio por su nombre **exacto**. El filtro de Docker
// por nombre es por prefijo: `api` casaría con `api-staging`.
func (c *DockerClient) FindService(ctx context.Context, name string) (*ServiceState, error) {
	f, _ := json.Marshal(map[string][]string{"name": {name}})
	var list []rawService
	if err := c.get(ctx, "/services?filters="+url.QueryEscape(string(f)), &list); err != nil {
		return nil, err
	}
	for _, s := range list {
		if s.Spec.Name == name {
			return s.state(), nil
		}
	}
	return nil, fmt.Errorf("no hay un servicio que se llame %q en esta máquina", name)
}

// InspectService lee el estado actual de un servicio por su id.
func (c *DockerClient) InspectService(ctx context.Context, id string) (*ServiceState, error) {
	var s rawService
	if err := c.get(ctx, "/services/"+id, &s); err != nil {
		return nil, err
	}
	return s.state(), nil
}

// PullImage baja una imagen. Docker contesta 200 aunque el pull falle y cuenta
// el error **dentro** del stream, así que se lee entero y se busca `error`:
// fiarse del código de estado dejaría pasar un «no autorizado».
func (c *DockerClient) PullImage(ctx context.Context, image, registryAuth string) error {
	name, tag := splitTag(image)
	q := url.Values{"fromImage": {name}, "tag": {tag}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL("/images/create?"+q.Encode()), nil)
	if err != nil {
		return err
	}
	if registryAuth != "" {
		req.Header.Set("X-Registry-Auth", registryAuth)
	}
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("docker no pudo bajar %s: %s", image, resp.Status)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var line struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &line) == nil && line.Error != "" {
			return fmt.Errorf("docker no pudo bajar %s: %s", image, line.Error)
		}
	}
	return sc.Err()
}

// ImageDigest devuelve `repo@sha256:…` de una imagen ya bajada. Con el digest
// clavado en el spec, un rollback vuelve a los mismos bytes aunque alguien
// reutilice el tag.
func (c *DockerClient) ImageDigest(ctx context.Context, image string) (string, error) {
	var img struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if err := c.get(ctx, "/images/"+url.PathEscape(image)+"/json", &img); err != nil {
		return "", err
	}
	name, _ := splitTag(image)
	for _, d := range img.RepoDigests {
		if strings.HasPrefix(d, name+"@") {
			return d, nil
		}
	}
	return "", fmt.Errorf("la imagen %s no tiene digest de %s", image, name)
}

// UpdateServiceImage cambia la imagen de un servicio y nada más: el resto del
// spec se manda tal cual se leyó. `version` es la del spec leído; si alguien lo
// cambió entre medias, Docker lo rechaza en vez de pisarlo.
func (c *DockerClient) UpdateServiceImage(ctx context.Context, id string, version int, image, registryAuth string) error {
	var svc map[string]any
	if err := c.get(ctx, "/services/"+id, &svc); err != nil {
		return err
	}
	spec, _ := svc["Spec"].(map[string]any)
	tt, _ := spec["TaskTemplate"].(map[string]any)
	cs, _ := tt["ContainerSpec"].(map[string]any)
	if cs == nil {
		return fmt.Errorf("el servicio %s no tiene ContainerSpec", id)
	}
	cs["Image"] = image
	body, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.apiURL(fmt.Sprintf("/services/%s/update?version=%d", id, version)), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if registryAuth != "" {
		req.Header.Set("X-Registry-Auth", registryAuth)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("docker rechazó la actualización: %s %s", resp.Status, e.Message)
	}
	return nil
}

// splitTag separa `repo:tag` (con o sin digest) en `repo` y `tag`. El `:` de
// un puerto de registro (`registry:5000/x`) no es un tag.
func splitTag(image string) (string, string) {
	if i := strings.Index(image, "@"); i >= 0 {
		image = image[:i]
	}
	slash := strings.LastIndex(image, "/")
	colon := strings.LastIndex(image, ":")
	if colon > slash {
		return image[:colon], image[colon+1:]
	}
	return image, "latest"
}
