package domain

import "time"

// ─── Stacks ──────────────────────────────────────────────────────────────────

type Stack struct {
	Name      string    `json:"name"`
	Services  int       `json:"services"`
	CreatedAt time.Time `json:"createdAt"`
}

// ─── Services ─────────────────────────────────────────────────────────────────

type ServiceReplicas struct {
	Running uint64 `json:"running"`
	Desired uint64 `json:"desired"`
}

type Service struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Image    string          `json:"image"`
	Stack    string          `json:"stack"`
	Replicas ServiceReplicas `json:"replicas"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

type Node struct {
	ID           string `json:"id"`
	Hostname     string `json:"hostname"`
	Role         string `json:"role"`
	Status       string `json:"status"`
	Availability string `json:"availability"`
	EngineVersion string `json:"engineVersion"`
}

// ─── Stats ────────────────────────────────────────────────────────────────────

// ContainerStats is a one-shot resource snapshot for a single swarm-managed
// container running on this node. cpuPercent comes from the one-shot precpu
// sample; net/blk values are cumulative byte counters since container start.
type ContainerStats struct {
	ContainerID string  `json:"containerId"`
	TaskID      string  `json:"taskId"`
	NodeID      string  `json:"nodeId"`
	ServiceID   string  `json:"serviceId"`
	ServiceName string  `json:"serviceName"`
	Stack       string  `json:"stack"`
	State       string  `json:"state"`
	CPUPercent  float64 `json:"cpuPercent"`
	MemUsage    uint64  `json:"memUsage"`
	MemLimit    uint64  `json:"memLimit"`
	NetRx       uint64  `json:"netRx"`
	NetTx       uint64  `json:"netTx"`
	BlockRead   uint64  `json:"blockRead"`
	BlockWrite  uint64  `json:"blockWrite"`
	Error       string  `json:"error,omitempty"`
}
