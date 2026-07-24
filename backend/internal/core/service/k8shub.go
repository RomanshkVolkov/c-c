package service

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/guz-studio/cac/backend/internal/adapters/k8s"
	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// K8sHubService reads live cluster state for the platform hub. Results are
// cached briefly so the UI polling doesn't hammer the API server.
type K8sHubService struct {
	client *k8s.Client

	mu    sync.Mutex
	cache map[string]cacheEntry
	ttl   time.Duration
}

type cacheEntry struct {
	at   time.Time
	data any
}

func NewK8sHubService(client *k8s.Client) *K8sHubService {
	return &K8sHubService{client: client, cache: map[string]cacheEntry{}, ttl: 15 * time.Second}
}

func (s *K8sHubService) Available() bool { return s.client.Enabled() }

// cached runs load() unless a fresh entry exists for key.
func (s *K8sHubService) cached(key string, load func() (any, error)) (any, error) {
	s.mu.Lock()
	if e, ok := s.cache[key]; ok && time.Since(e.at) < s.ttl {
		s.mu.Unlock()
		return e.data, nil
	}
	s.mu.Unlock()

	data, err := load()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache[key] = cacheEntry{at: time.Now(), data: data}
	s.mu.Unlock()
	return data, nil
}

func (s *K8sHubService) Routes(ctx context.Context) (*domain.K8sRoutesResponse, error) {
	data, err := s.cached("routes", func() (any, error) {
		gateways, err := s.client.Gateways(ctx)
		if err != nil {
			return nil, err
		}
		routes, err := s.client.HTTPRoutes(ctx)
		if err != nil {
			return nil, err
		}
		certs, err := s.client.Certificates(ctx)
		if err != nil {
			return nil, err
		}

		out := &domain.K8sRoutesResponse{
			Gateways: make([]domain.K8sGateway, 0, len(gateways)),
			Routes:   make([]domain.K8sRoute, 0, len(routes)),
		}
		for _, g := range gateways {
			out.Gateways = append(out.Gateways, domain.K8sGateway{
				Name: g.Name, Namespace: g.Namespace, Address: g.Address, Programmed: g.Programmed,
			})
		}
		for _, r := range routes {
			links := make([]string, 0, len(r.Hostnames))
			for _, h := range r.Hostnames {
				links = append(links, "https://"+h)
			}
			route := domain.K8sRoute{
				Name: r.Name, Namespace: r.Namespace, Gateway: r.Gateway,
				Hostnames: r.Hostnames, Links: links,
			}
			// Attach cert status if a cert covers any of the route's hostnames.
			if c := matchCert(certs, r.Hostnames); c != nil {
				ready := c.Ready
				route.CertReady = &ready
				route.CertExpiry = c.NotAfter
			}
			out.Routes = append(out.Routes, route)
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return data.(*domain.K8sRoutesResponse), nil
}

func matchCert(certs []k8s.CertInfo, hostnames []string) *k8s.CertInfo {
	for i := range certs {
		for _, dns := range certs[i].DNSNames {
			for _, h := range hostnames {
				if strings.EqualFold(dns, h) {
					return &certs[i]
				}
			}
		}
	}
	return nil
}

func (s *K8sHubService) Health(ctx context.Context) (*domain.K8sHealth, error) {
	data, err := s.cached("health", func() (any, error) {
		nodes, err := s.client.Nodes(ctx)
		if err != nil {
			return nil, err
		}
		deps, err := s.client.Deployments(ctx)
		if err != nil {
			return nil, err
		}
		certs, err := s.client.Certificates(ctx)
		if err != nil {
			return nil, err
		}
		pgs, err := s.client.CNPGClusters(ctx)
		if err != nil {
			return nil, err
		}

		out := &domain.K8sHealth{}
		for _, n := range nodes {
			out.Nodes = append(out.Nodes, domain.K8sNode{
				Name: n.Name, KubeletVersion: n.KubeletVer, Ready: n.Ready,
			})
		}
		for _, d := range deps {
			out.Workloads = append(out.Workloads, domain.K8sWorkload{
				Name: d.Name, Namespace: d.Namespace, Ready: d.Ready, Desired: d.Desired,
				Healthy: d.Desired > 0 && d.Ready >= d.Desired,
			})
		}
		now := time.Now()
		for _, c := range certs {
			cert := domain.K8sCert{
				Name: c.Name, Namespace: c.Namespace, DNSNames: c.DNSNames,
				NotAfter: c.NotAfter, Ready: c.Ready,
			}
			if c.NotAfter != nil {
				days := int(c.NotAfter.Sub(now).Hours() / 24)
				cert.DaysLeft = &days
			}
			out.Certs = append(out.Certs, cert)
		}
		for _, p := range pgs {
			out.Datastores = append(out.Datastores, domain.K8sDatastore{
				Kind: "postgres-cnpg", Name: p.Name, Namespace: p.Namespace,
				Instances: p.Instances, Ready: p.Ready, Phase: p.Phase,
				Healthy: p.Instances > 0 && p.Ready >= p.Instances,
			})
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return data.(*domain.K8sHealth), nil
}
