package events

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Contra la topología de producción, sólo con CAC_VALKEY_IT=1: un primario,
// dos réplicas y un Sentinel de Valkey en Docker. El bus se probó en su día con
// un Valkey de un solo nodo (miniredis), y ahí funciona; lo que se rompía era
// esto: con réplicas, el pub/sub es de cada nodo y lo que se publica en una
// réplica no le llega a quien escucha en otra (#18-oct-2026, uno de cada tres
// avisos perdido en producción).
//
// Mutante: que BusConfig ignore Sentinel y use Addr (vuelve a perderse).
func TestEveryEventCrossesPodsThroughSentinel(t *testing.T) {
	if os.Getenv("CAC_VALKEY_IT") != "1" {
		t.Skip("CAC_VALKEY_IT no está puesto")
	}
	net := fmt.Sprintf("cac-valkey-it-%d", time.Now().UnixNano())
	run := func(args ...string) string {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("network", "create", net)
	var ids []string
	t.Cleanup(func() {
		for _, id := range ids {
			exec.Command("docker", "rm", "-f", id).Run()
		}
		exec.Command("docker", "network", "rm", net).Run()
	})
	const img = "valkey/valkey:8.1.3"
	start := func(name string, args ...string) string {
		id := run(append([]string{"run", "-d", "--rm", "--network", net, "--name", name + "-" + net, img}, args...)...)
		ids = append(ids, id)
		return run("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id)
	}
	primary := start("primary", "valkey-server", "--port", "6379")
	replica1 := start("replica1", "valkey-server", "--port", "6379", "--replicaof", primary, "6379")
	replica2 := start("replica2", "valkey-server", "--port", "6379", "--replicaof", primary, "6379")
	sentinel := start("sentinel", "sh", "-c",
		fmt.Sprintf("printf 'port 26379\\nsentinel monitor myprimary %s 6379 1\\n' > /tmp/s.conf && valkey-sentinel /tmp/s.conf", primary))

	ctx := context.Background()
	waitPing := func(addr string) {
		c := redis.NewClient(&redis.Options{Addr: addr})
		defer c.Close()
		for i := 0; i < 60; i++ {
			if c.Ping(ctx).Err() == nil {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		t.Fatalf("%s no contesta", addr)
	}
	for _, a := range []string{primary, replica1, replica2} {
		waitPing(a + ":6379")
	}
	waitPing(sentinel + ":26379")
	time.Sleep(2 * time.Second) // que las réplicas sincronicen

	// Cuenta cuántos de `n` eventos publicados en A le llegan a un
	// suscriptor de B.
	cross := func(a, b BusConfig, n int) int {
		podA, podB := NewHub(), NewHub()
		podA.UseBusConfig(a)
		podB.UseBusConfig(b)
		for i := 0; i < 60 && !(podA.bus.ready() && podB.bus.ready()); i++ {
			time.Sleep(200 * time.Millisecond)
		}
		ch, cancel := podB.Subscribe("u-1", []string{"org-1"})
		defer cancel()
		// Se lee a la vez que se publica, como un cliente de verdad: el hub
		// descarta lo que un suscriptor lento no recoge.
		done := make(chan int, 1)
		go func() {
			got := 0
			deadline := time.After(4 * time.Second)
			for got < n {
				select {
				case <-ch:
					got++
				case <-deadline:
					done <- got
					return
				}
			}
			done <- got
		}()
		time.Sleep(300 * time.Millisecond)
		for i := 0; i < n; i++ {
			podA.Publish(Event{Type: "backup:status", OrgID: "org-1", Data: map[string]int{"i": i}})
			time.Sleep(5 * time.Millisecond)
		}
		return <-done
	}

	// El fallo, reproducido: A publica por una réplica, B escucha en la otra.
	if got := cross(BusConfig{Addr: replica2 + ":6379"}, BusConfig{Addr: replica1 + ":6379"}, 20); got != 0 {
		t.Fatalf("publicando por una réplica le llegaron %d de 20 a la otra; el escenario no reproduce el fallo", got)
	}
	// El arreglo: los dos por Sentinel, todo llega.
	viaSentinel := BusConfig{SentinelAddr: sentinel + ":26379", PrimaryName: "myprimary"}
	if got := cross(viaSentinel, viaSentinel, 50); got != 50 {
		t.Fatalf("por Sentinel llegaron %d de 50", got)
	}
}
