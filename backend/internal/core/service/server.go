package service

import (
	"bytes"
	"fmt"
	"net"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"golang.org/x/crypto/ssh"
)

// swarmManageCompose is the stack file deployed on each server.
const swarmManageCompose = `version: '3.8'
services:
  swarm-manage:
    image: ghcr.io/romanshkvolkov/c-c/swarm-manage:latest
    ports:
      - "%d:%d"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
`

type ServerService struct {
	repo *repository.ServerRepository
}

func NewServerService(repo *repository.ServerRepository) *ServerService {
	return &ServerService{repo: repo}
}

func (s *ServerService) Create(req domain.CreateServerRequest) (*domain.ServerResponse, error) {
	server := &domain.Server{
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

	if err := repository.StoreSSHKey(server.ID, req.SSHPrivateKey); err != nil {
		_ = s.repo.Delete(server.ID)
		return nil, fmt.Errorf("failed to store SSH key: %w", err)
	}

	return toResponse(server), nil
}

func (s *ServerService) List() ([]domain.ServerResponse, error) {
	servers, err := s.repo.List()
	if err != nil {
		return nil, err
	}
	result := make([]domain.ServerResponse, len(servers))
	for i, srv := range servers {
		result[i] = *toResponse(&srv)
	}
	return result, nil
}

func (s *ServerService) Delete(id string) error {
	_ = repository.DeleteSSHKey(id)
	return s.repo.Delete(id)
}

// DeployAgent SSHes into the server and deploys the swarm-manage stack.
func (s *ServerService) DeployAgent(id string) error {
	server, err := s.repo.FindByID(id)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	privateKey, err := repository.GetSSHKey(id)
	if err != nil {
		return fmt.Errorf("SSH key not found in keychain: %w", err)
	}

	signer, err := ssh.ParsePrivateKey([]byte(privateKey))
	if err != nil {
		return fmt.Errorf("invalid SSH private key: %w", err)
	}

	config := &ssh.ClientConfig{
		User:            server.SSHUser,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: store and verify host key
		Timeout:         15 * time.Second,
	}

	addr := net.JoinHostPort(server.Host, fmt.Sprintf("%d", server.SSHPort))
	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return fmt.Errorf("SSH connection failed: %w", err)
	}
	defer client.Close()

	composeContent := fmt.Sprintf(swarmManageCompose, server.AgentPort, server.AgentPort)
	commands := []string{
		fmt.Sprintf("cat > /tmp/swarm-manage.yml << 'EOF'\n%sEOF", composeContent),
		"docker stack deploy -c /tmp/swarm-manage.yml cac",
		"rm -f /tmp/swarm-manage.yml",
	}

	for _, cmd := range commands {
		if err := runSSH(client, cmd); err != nil {
			_ = s.repo.UpdateStatus(id, "error")
			return fmt.Errorf("command failed: %w", err)
		}
	}

	return s.repo.UpdateStatus(id, "online")
}

func runSSH(client *ssh.Client, cmd string) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	var stderr bytes.Buffer
	session.Stderr = &stderr

	if err := session.Run(cmd); err != nil {
		return fmt.Errorf("%w: %s", err, stderr.String())
	}
	return nil
}

func toResponse(s *domain.Server) *domain.ServerResponse {
	return &domain.ServerResponse{
		ID:        s.ID,
		Name:      s.Name,
		Host:      s.Host,
		SSHPort:   s.SSHPort,
		SSHUser:   s.SSHUser,
		Type:      s.Type,
		AgentPort: s.AgentPort,
		Status:    s.Status,
	}
}
