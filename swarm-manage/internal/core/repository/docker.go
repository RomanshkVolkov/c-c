package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

const socketPath = "/var/run/docker.sock"

type DockerClient struct {
	http       *http.Client // normal, with timeout
	httpStream *http.Client // no timeout, for log streaming
}

func NewDockerClient() *DockerClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &DockerClient{
		http:       &http.Client{Transport: transport, Timeout: 30 * time.Second},
		httpStream: &http.Client{Transport: transport, Timeout: 0},
	}
}

func (c *DockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("docker API error: %s", resp.Status)
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
		fmt.Sprintf("http://localhost/v1.41/services/%s/logs?stdout=1&stderr=1&follow=1&tail=100", serviceID), nil)
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
	err := c.get(ctx, "/v1.41/services?status=true", &services)
	return services, err
}

func (c *DockerClient) ListNodes(ctx context.Context) ([]DockerNode, error) {
	var nodes []DockerNode
	err := c.get(ctx, "/v1.41/nodes", &nodes)
	return nodes, err
}

func (c *DockerClient) ForceUpdateService(ctx context.Context, serviceID string) error {
	var svc map[string]interface{}
	if err := c.get(ctx, fmt.Sprintf("/v1.41/services/%s", serviceID), &svc); err != nil {
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
		fmt.Sprintf("http://localhost/v1.41/services/%s/update?version=%d", serviceID, int(version)),
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
