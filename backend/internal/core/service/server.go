package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

type ServerService struct {
	repo     *repository.ServerRepository
	platform PlatformCluster
}

func NewServerService(repo *repository.ServerRepository) *ServerService {
	return &ServerService{repo: repo}
}

// PlatformCluster: el clúster donde corre el backend (K8sHubService).
type PlatformCluster interface {
	Owns(ctx context.Context, host string) bool
	NodesReady(ctx context.Context) (bool, error)
}

// WithPlatform: con él, un servidor kubernetes que es el clúster de cac
// cuenta su estado por sus nodos (ver respond).
func (s *ServerService) WithPlatform(p PlatformCluster) *ServerService {
	s.platform = p
	return s
}

// respond: la respuesta de un servidor, con el estado de un kubernetes sacado
// de su clúster. Un kubernetes no tiene agente swarm-manage: si arrastra la
// identidad de cuando era Swarm (gstd, 5-nov-2026), su latido no cuenta. Si
// es el clúster de cac, `online` con todos los nodos Ready y `offline` si no;
// si es otro, lo guardado (`pending`): cac no tiene cómo mirarlo.
func (s *ServerService) respond(srv *domain.Server) *domain.ServerResponse {
	out := toResponse(srv)
	if srv.Type != domain.ServerTypeKubernetes {
		return out
	}
	out.Status = srv.Status
	if s.platform == nil {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if !s.platform.Owns(ctx, srv.Host) {
		return out
	}
	if ready, err := s.platform.NodesReady(ctx); err == nil && ready {
		out.Status = "online"
	} else {
		out.Status = "offline"
	}
	return out
}

func (s *ServerService) Create(req domain.CreateServerRequest) (*domain.ServerResponse, error) {
	server := &domain.Server{
		OrgID:     req.OrgID,
		Name:      req.Name,
		Host:      req.Host,
		SSHPort:   req.SSHPort,
		SSHUser:   req.SSHUser,
		Type:      req.Type,
		AgentPort: req.AgentPort,
		Status:    "pending",
	}
	server.ID = uuid.NewString()

	if err := s.repo.Create(server); err != nil {
		return nil, err
	}

	return s.respond(server), nil
}

func (s *ServerService) List(orgIDs []string, superadmin bool) ([]domain.ServerResponse, error) {
	var servers []domain.Server
	var err error
	if superadmin {
		servers, err = s.repo.ListAll()
	} else {
		servers, err = s.repo.ListByOrgs(orgIDs)
	}
	if err != nil {
		return nil, err
	}
	result := make([]domain.ServerResponse, len(servers))
	for i, srv := range servers {
		result[i] = *s.respond(&srv)
	}
	return result, nil
}

// Find returns a single server (used for authorization before mutations).
// ReportAgentStatus anota si el agente contestó.
//
// Lo cuenta la app y no el servidor porque el agente vive en la VPS del
// cliente y quien alcanza esa red es el escritorio del operador —el backend
// está en otro sitio y no tiene por qué llegar—. La consecuencia hay que
// asumirla y decirla: esto es «lo que la última consola que miró pudo
// alcanzar», no una verdad absoluta sobre la máquina.
//
// Con un agente con identidad, esto **no manda**: su estado sale de su propio
// latido y se calcula al leer (`toResponseAt`), que ignora lo guardado. Así que
// no hace falta filtrar aquí; la garantía está en la lectura, y la fija
// `TestTheAppNoLongerDecidesAnAgentWithIdentity`.
func (s *ServerService) ReportAgentStatus(id, status string) error {
	return s.repo.UpdateStatus(id, status)
}

// ErrNoAgentToken: pedir un pase para un agente que todavía no tiene identidad.
var ErrNoAgentToken = errors.New("agent-has-no-token")

// agentSessionTTL: lo que dura un pase de la app al agente. Corto porque no
// se revoca —el agente lo verifica sin preguntar—; la app pide otro solo.
const agentSessionTTL = 10 * time.Minute

// MintAgentToken acuña la identidad del agente. Revoca la anterior: el token
// viejo deja de casar y los pases firmados con la sal vieja dejan de valer.
func (s *ServerService) MintAgentToken(id string) (*domain.AgentTokenResponse, error) {
	plain, hash, salt, err := repository.GenerateAgentToken()
	if err != nil {
		return nil, err
	}
	preview := plain[:len(repository.AgentTokenPrefix)+6] + "…"
	if err := s.repo.SetAgentToken(id, hash, salt, preview); err != nil {
		return nil, err
	}
	return &domain.AgentTokenResponse{
		Token:      plain,
		SessionKey: repository.AgentSessionKey(id, salt),
		Preview:    preview,
	}, nil
}

// AgentSession firma un pase corto para que `userID` le hable al agente.
func (s *ServerService) AgentSession(id, userID string, write bool, now time.Time) (*domain.AgentSessionResponse, error) {
	srv, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	if len(srv.AgentTokenHash) == 0 {
		return nil, ErrNoAgentToken
	}
	exp := now.Add(agentSessionTTL)
	key := repository.AgentSessionKey(srv.ID, srv.AgentTokenSalt)
	return &domain.AgentSessionResponse{
		Token:     repository.SignAgentSession(key, srv.ID, repository.AgentSubject(userID, write), exp.Unix()),
		ExpiresAt: exp,
	}, nil
}

// AgentByToken: el servidor que presenta ese token, o error.
func (s *ServerService) AgentByToken(plain string) (*domain.Server, error) {
	return s.repo.FindByAgentTokenHash(repository.HashAgentToken(plain))
}

// Heartbeat: el agente preguntó, luego está.
func (s *ServerService) Heartbeat(id string, version int, now time.Time) error {
	return s.repo.TouchAgent(id, version, now)
}

func (s *ServerService) Find(id string) (*domain.ServerResponse, error) {
	srv, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	return s.respond(srv), nil
}

func (s *ServerService) Update(id string, req domain.UpdateServerRequest) (*domain.ServerResponse, error) {
	srv, err := s.repo.FindByID(id)
	if err != nil {
		return nil, err
	}
	srv.Name = req.Name
	srv.Host = req.Host
	srv.SSHPort = req.SSHPort
	srv.SSHUser = req.SSHUser
	srv.Type = req.Type
	srv.AgentPort = req.AgentPort
	if err := s.repo.Update(srv); err != nil {
		return nil, err
	}
	return s.respond(srv), nil
}

func (s *ServerService) Delete(id string) error {
	return s.repo.Delete(id)
}

func toResponse(s *domain.Server) *domain.ServerResponse {
	return toResponseAt(s, time.Now())
}

// toResponseAt calcula el estado de un agente con identidad a partir de su
// latido: sin latido todavía, `pending`; con uno más viejo que
// `domain.AgentSilence`, `offline`. Se decide al leer y no con un proceso que
// barra la tabla: un agente que se calla no avisa, y leerlo es el único
// momento en que alguien necesita saberlo.
func toResponseAt(s *domain.Server, now time.Time) *domain.ServerResponse {
	status := s.Status
	if len(s.AgentTokenHash) > 0 {
		switch {
		case s.AgentSeenAt == nil:
			status = "pending"
		case now.Sub(*s.AgentSeenAt) > domain.AgentSilence:
			status = "offline"
		default:
			status = "online"
		}
	}
	return &domain.ServerResponse{
		ID:        s.ID,
		OrgID:     s.OrgID,
		Name:      s.Name,
		Host:      s.Host,
		SSHPort:   s.SSHPort,
		SSHUser:   s.SSHUser,
		Type:      s.Type,
		AgentPort: s.AgentPort,
		Status:    status,

		HasAgentToken:     len(s.AgentTokenHash) > 0,
		AgentTokenPreview: s.AgentTokenPreview,
		AgentSeenAt:       s.AgentSeenAt,
		AgentVersion:      s.AgentVersion,
	}
}
