package service

import (
	"context"
	"sort"
	"strings"

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
