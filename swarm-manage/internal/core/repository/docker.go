package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

const socketPath = "/var/run/docker.sock"
const fallbackAPIVersion = "1.41"

type DockerClient struct {
	http       *http.Client // normal, with timeout
	httpStream *http.Client // no timeout, for log streaming
	apiVersion string
}

func NewDockerClient() *DockerClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	c := &DockerClient{
		http:       &http.Client{Transport: transport, Timeout: 30 * time.Second},
		httpStream: &http.Client{Transport: transport, Timeout: 0},
		apiVersion: fallbackAPIVersion,
	}
	c.negotiateVersion()
	return c
}

// negotiateVersion queries /_ping and uses the server's API-Version header.
func (c *DockerClient) negotiateVersion() {
	req, _ := http.NewRequest(http.MethodGet, "http://localhost/_ping", nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
	if v := resp.Header.Get("API-Version"); v != "" {
		c.apiVersion = v
	}
}

func (c *DockerClient) apiURL(path string) string {
	return "http://localhost/v" + c.apiVersion + path
}

func (c *DockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL(path), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker API error: %s - %s", resp.Status, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *DockerClient) Ping(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost/_ping", nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

type DockerService struct {
	ID   string `json:"ID"`
	Spec struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
		TaskTemplate struct {
			ContainerSpec struct {
				Image string `json:"Image"`
			} `json:"ContainerSpec"`
		} `json:"TaskTemplate"`
	} `json:"Spec"`
	ServiceStatus *struct {
		RunningTasks uint64 `json:"RunningTasks"`
		DesiredTasks uint64 `json:"DesiredTasks"`
	} `json:"ServiceStatus,omitempty"`
	UpdatedAt time.Time `json:"UpdatedAt"`
	CreatedAt time.Time `json:"CreatedAt"`
}

type DockerNode struct {
	ID          string `json:"ID"`
	Description struct {
		Hostname string `json:"Hostname"`
		Engine   struct {
			EngineVersion string `json:"EngineVersion"`
		} `json:"Engine"`
	} `json:"Description"`
	Spec struct {
		Role         string `json:"Role"`
		Availability string `json:"Availability"`
	} `json:"Spec"`
	Status struct {
		State string `json:"State"`
	} `json:"Status"`
}

func (c *DockerClient) StreamServiceLogs(ctx context.Context, serviceID string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.apiURL(fmt.Sprintf("/services/%s/logs?stdout=1&stderr=1&follow=1&tail=100", serviceID)), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpStream.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, fmt.Errorf("docker API error: %s", resp.Status)
	}
	return resp.Body, nil
}

func (c *DockerClient) ListServices(ctx context.Context) ([]DockerService, error) {
	var services []DockerService
	err := c.get(ctx, "/services?status=true", &services)
	return services, err
}

// DockerContainer is the subset of /containers/json we care about. Swarm-managed
// containers carry the com.docker.swarm.* labels populated below.
type DockerContainer struct {
	ID     string            `json:"Id"`
	State  string            `json:"State"`
	Labels map[string]string `json:"Labels"`
}

// ListSwarmContainers returns the swarm-managed containers running on this node
// (filter on the com.docker.swarm.task.id label, which is only set by swarmkit).
func (c *DockerClient) ListSwarmContainers(ctx context.Context) ([]DockerContainer, error) {
	filters := `{"label":["com.docker.swarm.task.id"]}`
	encoded := url.QueryEscape(filters)
	var containers []DockerContainer
	err := c.get(ctx, "/containers/json?all=true&filters="+encoded, &containers)
	return containers, err
}

// DockerContainerStats is the partial shape of /containers/{id}/stats?stream=false
// we care about. Fields are only the ones used to compute summary metrics.
type DockerContainerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint64 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint64 `json:"online_cpus"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
		Stats struct {
			Cache        uint64 `json:"cache"`         // cgroup v1
			InactiveFile uint64 `json:"inactive_file"` // cgroup v2
		} `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IoServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

func (c *DockerClient) ContainerStats(ctx context.Context, containerID string) (*DockerContainerStats, error) {
	var s DockerContainerStats
	err := c.get(ctx, "/containers/"+containerID+"/stats?stream=false&one-shot=false", &s)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (c *DockerClient) ListNodes(ctx context.Context) ([]DockerNode, error) {
	var nodes []DockerNode
	err := c.get(ctx, "/nodes", &nodes)
	return nodes, err
}

func (c *DockerClient) ForceUpdateService(ctx context.Context, serviceID string) error {
	var svc map[string]interface{}
	if err := c.get(ctx, fmt.Sprintf("/services/%s", serviceID), &svc); err != nil {
		return err
	}

	meta, _ := svc["Version"].(map[string]interface{})
	version, _ := meta["Index"].(float64)

	spec, _ := svc["Spec"].(map[string]interface{})
	taskTemplate, _ := spec["TaskTemplate"].(map[string]interface{})
	forceUpdate, _ := taskTemplate["ForceUpdate"].(float64)
	taskTemplate["ForceUpdate"] = forceUpdate + 1
	spec["TaskTemplate"] = taskTemplate

	body, err := json.Marshal(spec)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.apiURL(fmt.Sprintf("/services/%s/update?version=%d", serviceID, int(version))),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("docker API error: %s", resp.Status)
	}
	return nil
}
