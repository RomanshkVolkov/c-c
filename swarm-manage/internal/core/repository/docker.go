package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"
)

const socketPath = "/var/run/docker.sock"

type DockerClient struct {
	http *http.Client
}

func NewDockerClient() *DockerClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &DockerClient{
		http: &http.Client{Transport: transport, Timeout: 30 * time.Second},
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
