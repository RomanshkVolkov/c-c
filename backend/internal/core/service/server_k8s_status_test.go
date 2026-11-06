package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

type fakePlatform struct {
	host  string
	ready bool
	err   error
}

func (f fakePlatform) Owns(_ context.Context, host string) bool { return host == f.host }
func (f fakePlatform) NodesReady(context.Context) (bool, error) { return f.ready, f.err }

// El estado de un kubernetes sale de su clúster, no de un agente swarm-manage
// que no tiene: gstd arrastraba la identidad de cuando era Swarm y salía
// `offline` corriendo cac (5-nov-2026). Y uno que no es el clúster de cac no se
// da por vivo con los nodos de otro. Roturas que atrapa: contar el latido del
// agente en un kubernetes; dar `online` a otro clúster; `online` con un nodo
// caído o sin poder leerlos; tocar el estado de un swarm.
func TestAKubernetesServerStatusComesFromItsCluster(t *testing.T) {
	stale := time.Now().Add(-24 * time.Hour)
	fresh := time.Now()
	gstd := &domain.Server{Host: "13.140.235.112", Type: domain.ServerTypeKubernetes, Status: "pending",
		AgentTokenHash: []byte{1}, AgentSeenAt: &stale}
	pixel := &domain.Server{Host: "154.53.49.30", Type: domain.ServerTypeKubernetes, Status: "pending",
		AgentTokenHash: []byte{1}, AgentSeenAt: &fresh}
	// Un swarm en la misma IP que el clúster y con el agente callado: sigue
	// mandando su agente, no los nodos.
	swarm := &domain.Server{Host: "13.140.235.112", Type: domain.ServerTypeDockerSwarm,
		AgentTokenHash: []byte{1}, AgentSeenAt: &stale}

	s := (&ServerService{}).WithPlatform(fakePlatform{host: "13.140.235.112", ready: true})
	if got := s.respond(gstd).Status; got != "online" {
		t.Errorf("el clúster de cac con sus nodos Ready → %q", got)
	}
	if got := s.respond(pixel).Status; got != "pending" {
		t.Errorf("otro kubernetes, aunque su agente lata → %q, se esperaba lo guardado", got)
	}
	if got := s.respond(swarm).Status; got != "offline" {
		t.Errorf("un swarm sigue con su agente → %q, se esperaba offline", got)
	}
	for name, p := range map[string]fakePlatform{
		"un nodo caído":     {host: "13.140.235.112", ready: false},
		"sin poder leerlos": {host: "13.140.235.112", ready: true, err: errors.New("x")},
	} {
		if got := (&ServerService{}).WithPlatform(p).respond(gstd).Status; got != "offline" {
			t.Errorf("%s → %q, se esperaba offline", name, got)
		}
	}
	if got := (&ServerService{}).respond(gstd).Status; got != "pending" {
		t.Errorf("sin clúster que mirar → %q, se esperaba lo guardado", got)
	}
}

// Roturas que atrapa: distinguir mayúsculas o espacios; no resolver un nombre;
// resolver una IP; dar por bueno un nombre que no resuelve o un host vacío.
func TestAHostIsOneOfTheNodesAddresses(t *testing.T) {
	addrs := []string{"13.140.235.112", "vmi3713710"}
	lookup := func(_ context.Context, h string) ([]string, error) {
		if h == "gstd.guz-studio.dev" {
			return []string{"13.140.235.112"}, nil
		}
		return nil, errors.New("no resuelve")
	}
	for _, h := range []string{"13.140.235.112", " VMI3713710 ", "gstd.guz-studio.dev"} {
		if !hostIsOneOf(context.Background(), h, addrs, lookup) {
			t.Errorf("%q no se reconoce", h)
		}
	}
	for _, h := range []string{"154.53.49.30", "pixel.example", "", "13.140.235.11"} {
		if hostIsOneOf(context.Background(), h, addrs, lookup) {
			t.Errorf("%q se toma por el clúster", h)
		}
	}
}
