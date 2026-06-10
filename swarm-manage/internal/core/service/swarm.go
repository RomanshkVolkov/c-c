package service

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/guz-studio/cac/swarm-manage/internal/core/domain"
	"github.com/guz-studio/cac/swarm-manage/internal/core/repository"
)

const stackLabel = "com.docker.stack.namespace"

type SwarmService struct {
	docker *repository.DockerClient
}

func NewSwarmService(docker *repository.DockerClient) *SwarmService {
	return &SwarmService{docker: docker}
}

func (s *SwarmService) ListStacks(ctx context.Context) ([]domain.Stack, error) {
	services, err := s.docker.ListServices(ctx)
	if err != nil {
		return nil, err
	}

	stackMap := map[string]*domain.Stack{}
	for _, svc := range services {
		name := svc.Spec.Labels[stackLabel]
		if name == "" {
			name = "_standalone"
		}
		if _, exists := stackMap[name]; !exists {
			stackMap[name] = &domain.Stack{Name: name, CreatedAt: svc.CreatedAt}
		}
		stackMap[name].Services++
	}

	result := make([]domain.Stack, 0, len(stackMap))
	for _, stack := range stackMap {
		result = append(result, *stack)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (s *SwarmService) ListServices(ctx context.Context, stack string) ([]domain.Service, error) {
	all, err := s.docker.ListServices(ctx)
	if err != nil {
		return nil, err
	}

	result := make([]domain.Service, 0, len(all))
	for _, svc := range all {
		svcStack := svc.Spec.Labels[stackLabel]
		if stack != "" && svcStack != stack {
			continue
		}

		var running, desired uint64
		if svc.ServiceStatus != nil {
			running = svc.ServiceStatus.RunningTasks
			desired = svc.ServiceStatus.DesiredTasks
		}

		image := svc.Spec.TaskTemplate.ContainerSpec.Image
		if idx := strings.Index(image, "@"); idx != -1 {
			image = image[:idx]
		}

		result = append(result, domain.Service{
			ID:        svc.ID,
			Name:      svc.Spec.Name,
			Image:     image,
			Stack:     svcStack,
			Replicas:  domain.ServiceReplicas{Running: running, Desired: desired},
			UpdatedAt: svc.UpdatedAt,
		})
	}
	return result, nil
}

func (s *SwarmService) StreamServiceLogs(ctx context.Context, serviceID string, w io.Writer, flush func()) error {
	body, err := s.docker.StreamServiceLogs(ctx, serviceID)
	if err != nil {
		return err
	}
	defer body.Close()

	hdr := make([]byte, 8)
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		if _, err := io.ReadFull(body, hdr); err != nil {
			return nil // client disconnected or stream ended
		}
		size := binary.BigEndian.Uint32(hdr[4:8])
		if size == 0 {
			continue
		}
		frame := make([]byte, size)
		if _, err := io.ReadFull(body, frame); err != nil {
			return nil
		}
		line := strings.TrimRight(string(frame), "\r\n")
		if line == "" {
			continue
		}
		fmt.Fprintf(w, "data: %s\n\n", line)
		flush()
	}
}

func (s *SwarmService) ForceUpdateService(ctx context.Context, serviceID string) error {
	return s.docker.ForceUpdateService(ctx, serviceID)
}

// NodeStats returns per-container resource usage for every swarm-managed
// container running on this node. Containers whose stats call fails are
// returned with an Error field set so the caller can render the row anyway.
func (s *SwarmService) NodeStats(ctx context.Context) ([]domain.ContainerStats, error) {
	containers, err := s.docker.ListSwarmContainers(ctx)
	if err != nil {
		return nil, err
	}

	results := make([]domain.ContainerStats, len(containers))
	var wg sync.WaitGroup
	for i, ctr := range containers {
		wg.Add(1)
		go func(idx int, ctr repository.DockerContainer) {
			defer wg.Done()
			row := domain.ContainerStats{
				ContainerID: ctr.ID,
				TaskID:      ctr.Labels["com.docker.swarm.task.id"],
				NodeID:      ctr.Labels["com.docker.swarm.node.id"],
				ServiceID:   ctr.Labels["com.docker.swarm.service.id"],
				ServiceName: ctr.Labels["com.docker.swarm.service.name"],
				Stack:       ctr.Labels["com.docker.stack.namespace"],
				State:       ctr.State,
			}
			stats, err := s.docker.ContainerStats(ctx, ctr.ID)
			if err != nil {
				row.Error = err.Error()
				results[idx] = row
				return
			}
			fillStats(&row, stats)
			results[idx] = row
		}(i, ctr)
	}
	wg.Wait()
	return results, nil
}

func fillStats(out *domain.ContainerStats, s *repository.DockerContainerStats) {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemCPUUsage) - float64(s.PreCPUStats.SystemCPUUsage)
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(s.PreCPUStats.OnlineCPUs)
	}
	if sysDelta > 0 && cpuDelta > 0 && cpus > 0 {
		out.CPUPercent = (cpuDelta / sysDelta) * cpus * 100.0
	}
	out.OnlineCPUs = uint64(cpus)

	// Docker reports memory_stats.usage including page cache. Subtract it for a
	// more accurate RSS-like figure. cgroup v1 exposes 'cache'; v2 exposes 'inactive_file'.
	usage := s.MemoryStats.Usage
	if s.MemoryStats.Stats.Cache > 0 && s.MemoryStats.Stats.Cache <= usage {
		usage -= s.MemoryStats.Stats.Cache
	} else if s.MemoryStats.Stats.InactiveFile > 0 && s.MemoryStats.Stats.InactiveFile <= usage {
		usage -= s.MemoryStats.Stats.InactiveFile
	}
	out.MemUsage = usage
	out.MemLimit = s.MemoryStats.Limit

	for _, n := range s.Networks {
		out.NetRx += n.RxBytes
		out.NetTx += n.TxBytes
	}

	for _, b := range s.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(b.Op) {
		case "read":
			out.BlockRead += b.Value
		case "write":
			out.BlockWrite += b.Value
		}
	}
}

func (s *SwarmService) ListNodes(ctx context.Context) ([]domain.Node, error) {
	raw, err := s.docker.ListNodes(ctx)
	if err != nil {
		return nil, err
	}

	result := make([]domain.Node, 0, len(raw))
	for _, n := range raw {
		result = append(result, domain.Node{
			ID:            n.ID,
			Hostname:      n.Description.Hostname,
			Role:          n.Spec.Role,
			Status:        n.Status.State,
			Availability:  n.Spec.Availability,
			EngineVersion: n.Description.Engine.EngineVersion,
		})
	}
	return result, nil
}
