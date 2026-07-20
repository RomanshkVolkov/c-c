package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func InitOrganizationRoutes(db *gorm.DB, r *chi.Mux) {
	repo := repository.NewOrganizationRepository(db)
	svc := service.NewOrganizationService(repo)
	h := handler.NewOrganizationHandler(svc)

	r.Route("/api/v1/organizations", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Patch("/{id}", h.Update)
		r.Delete("/{id}", h.Delete)
		r.Get("/{id}/members", h.ListMembers)
		r.Post("/{id}/members", h.AddMember)
		r.Patch("/{id}/members/{userId}", h.UpdateMember)
		r.Delete("/{id}/members/{userId}", h.RemoveMember)
	})
}
