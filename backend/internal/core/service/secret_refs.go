package service

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

var (
	ErrBadSecretName       = errors.New("bad-secret-name")
	ErrBadOpRef            = errors.New("bad-op-ref")
	ErrDuplicateName       = errors.New("duplicate-secret-name")
	ErrBadDockerName       = errors.New("bad-docker-secret-name")
	ErrRotationNeedsDeploy = errors.New("rotation-needs-deploy")
)

type SecretRefService struct {
	repo *repository.SecretRefRepository
}

func NewSecretRefService(repo *repository.SecretRefRepository) *SecretRefService {
	return &SecretRefService{repo: repo}
}

func (s *SecretRefService) List(d *domain.Deployable) ([]domain.DeployableSecretRef, error) {
	return s.repo.List(d.ID)
}

func (s *SecretRefService) Replace(d *domain.Deployable, req domain.PutSecretRefsRequest) ([]domain.DeployableSecretRef, error) {
	seen := map[string]bool{}
	for i, r := range req.Refs {
		r.Name, r.OpRef = strings.TrimSpace(r.Name), strings.TrimSpace(r.OpRef)
		if !domain.SecretNamePattern.MatchString(r.Name) {
			return nil, ErrBadSecretName
		}
		if !domain.OpRefPattern.MatchString(r.OpRef) {
			return nil, ErrBadOpRef
		}
		if seen[r.Name] {
			return nil, ErrDuplicateName
		}
		seen[r.Name] = true
		req.Refs[i] = r
	}
	return s.repo.Replace(d.OrgID, d.ID, req.Refs)
}

// RecordRotation apunta una rotación. Sólo nombres: los de las variables y
// los de los secrets de Docker, que llevan un HMAC del valor y no lo revelan.
//
// Con el CI desplegando él, su próximo `stack deploy` volvería a poner los
// secrets de su stack y tiraría los de cac sin avisar: por eso sólo se rota un
// servicio que despliega cac.
func (s *SecretRefService) RecordRotation(d *domain.Deployable, userID string, req domain.RecordRotationRequest) (*domain.SecretRotation, error) {
	if d.OnCINotify != "deploy" {
		return nil, ErrRotationNeedsDeploy
	}
	for _, n := range req.Names {
		if !domain.SecretNamePattern.MatchString(n) {
			return nil, ErrBadSecretName
		}
	}
	for k, v := range req.Versions {
		if !domain.SecretNamePattern.MatchString(k) || !domain.DockerSecretPattern.MatchString(v) {
			return nil, ErrBadDockerName
		}
	}
	versions, _ := json.Marshal(req.Versions)
	rot := &domain.SecretRotation{
		OrgID: d.OrgID, DeployableID: d.ID, StartedBy: userID,
		Names: strings.Join(req.Names, ","), Versions: string(versions),
		Status: req.Status, Error: req.Error,
	}
	if err := s.repo.RecordRotation(rot); err != nil {
		return nil, err
	}
	return rot, nil
}

func (s *SecretRefService) ListRotations(d *domain.Deployable) ([]domain.SecretRotationResponse, error) {
	return s.repo.ListRotations(d.ID, 20)
}
