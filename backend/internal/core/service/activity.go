package service

import (
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// ActivityService: la actividad de CI de una org (R9). Lo que hay que saber
// está en domain/activity.go; esto sólo acota lo que se pide.
type ActivityService struct {
	repo *repository.ActivityRepository
}

func NewActivityService(repo *repository.ActivityRepository) *ActivityService {
	return &ActivityService{repo: repo}
}

// Feed: una página de la actividad de la org. El tope de página se aplica aquí
// y no en el handler: la API no es el único que podría pedirla.
func (s *ActivityService) Feed(orgID string, f domain.ActivityFilter) (domain.ActivityPage, error) {
	if f.Limit <= 0 {
		f.Limit = domain.ActivityPageDefault
	}
	if f.Limit > domain.ActivityPageMax {
		f.Limit = domain.ActivityPageMax
	}
	return s.repo.Feed(orgID, f)
}
