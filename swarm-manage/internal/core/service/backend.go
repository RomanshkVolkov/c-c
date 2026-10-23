package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

// Poller le pregunta al backend si hay trabajo para esta máquina.
//
// La conexión la abre **el agente**, hacia fuera: el VPS sólo necesita salida
// HTTPS a cac, y el backend nunca tiene que alcanzar la IP del servidor —que
// puede estar detrás de un NAT, de un firewall o en una tailnet a la que el
// clúster no pertenece—. Cada pregunta es además el latido: el backend da el
// servidor por caído cuando deja de oírla.
//
// En esta rebanada no hay trabajos todavía: lo que llegue se registra y se
// ignora. Los de despliegue llegan en la siguiente.
// Version es la versión de este agente, la de `swarm-manage/VERSION`. Va en
// cada pregunta (`X-Agent-Version`): el backend no le encola un deploy a un
// agente que no sabe hacerlo. Lo ata al fichero `TestTheVersionIsTheFile`.
const Version = 12

type Poller struct {
	BaseURL string
	Token   string
	Client  *http.Client
	// Wait: cuánto se le pide al backend que sostenga la pregunta.
	Wait time.Duration
	// Backoff tras un fallo, doblando hasta MaxBackoff.
	MinBackoff, MaxBackoff time.Duration
	// OnJob recibe cada trabajo. nil: se registra y se ignora.
	OnJob func(ctx context.Context, job Job)
	// BeatEvery: cada cuánto late mientras hace un trabajo (ver runJob).
	BeatEvery time.Duration
}

// Job es lo que el backend manda cuando hay algo que hacer.
type Job struct {
	ID   string          `json:"id"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

func NewPoller(baseURL, token string) *Poller {
	return &Poller{
		BaseURL: baseURL,
		Token:   token,
		// Por encima de lo que el backend sostiene la pregunta: si el
		// timeout fuera menor, cortaríamos nosotros cada long-poll.
		Client:     &http.Client{Timeout: 40 * time.Second},
		Wait:       25 * time.Second,
		MinBackoff: time.Second,
		MaxBackoff: time.Minute,
		// Lo que tarda en volver una pregunta sin trabajo: el backend ve el
		// mismo ritmo trabajando que esperando.
		BeatEvery: 25 * time.Second,
	}
}

// Run pregunta hasta que se cancele el contexto.
func (p *Poller) Run(ctx context.Context) {
	backoff := p.MinBackoff
	for ctx.Err() == nil {
		job, err := p.poll(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("backend: %v; reintento en %s", err, backoff)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			backoff *= 2
			if backoff > p.MaxBackoff {
				backoff = p.MaxBackoff
			}
			continue
		}
		backoff = p.MinBackoff
		if job == nil {
			continue
		}
		if p.OnJob == nil {
			log.Printf("backend: trabajo %s de tipo %q, que esta versión no sabe hacer", job.ID, job.Kind)
			continue
		}
		p.runJob(ctx, *job)
	}
}

// runJob hace el trabajo latiendo mientras tanto. Preguntar por trabajo es el
// latido, y mientras se despliega no se pregunta: hasta la v6, un build de
// diez minutos dejaba el servidor offline en cac con el agente sano (boaty,
// 16-oct-2026). Se late en paralelo y por su propia ruta, que no reclama el
// siguiente trabajo de la cola.
func (p *Poller) runJob(ctx context.Context, job Job) {
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		t := time.NewTicker(p.BeatEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				if err := p.beat(ctx); err != nil {
					log.Printf("backend: el latido no llegó: %v", err)
				}
			}
		}
	}()
	// Al acabar, se espera al latido que estuviera en el aire: un latido
	// tardío no debe llegar después de que el agente vuelva a preguntar.
	defer func() { close(done); <-stopped }()
	p.OnJob(ctx, job)
}

// beat: «sigo aquí». Un backend de antes de esta ruta contesta 404, y el
// servidor se verá offline mientras construye, como antes.
func (p *Poller) beat(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/agent/v1/heartbeat", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("X-Agent-Version", strconv.Itoa(Version))
	res, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("el backend contestó %d", res.StatusCode)
	}
	return nil
}

// poll hace una pregunta. nil, nil = sin trabajo (204).
func (p *Poller) poll(ctx context.Context) (*Job, error) {
	url := fmt.Sprintf("%s/agent/v1/jobs?wait=%d", p.BaseURL, int(p.Wait/time.Second))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("X-Agent-Version", strconv.Itoa(Version))
	res, err := p.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		var job Job
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&job); err != nil {
			return nil, fmt.Errorf("trabajo ilegible: %w", err)
		}
		return &job, nil
	case http.StatusUnauthorized:
		// El token ya no vale: se reacuñó. Se sigue preguntando (con el
		// backoff al máximo) para que el log lo diga, pero no hay arreglo
		// desde aquí: hay que reinstalar el agente.
		return nil, fmt.Errorf("el backend rechaza el token (¿se reacuñó? reinstala el agente)")
	default:
		return nil, fmt.Errorf("el backend contestó %d", res.StatusCode)
	}
}
