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
