package service

import (
	"errors"
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

/*
Adjuntos en directos (6-oct-2026). Un directo es privado: su adjunto lo ven las
dos personas de la conversación y nadie más, tampoco una compañera de la misma
org. No como en un canal, donde basta ser de la org.
*/

// Mutantes: no mirar si eres de la conversación; servir el adjunto de otra
// conversación pidiéndolo por esta; dejar subir a quien no es de ella.
func TestADMAttachmentIsOnlyForTheTwoOfThem(t *testing.T) {
	db, cleanup := dmDB(t)
	defer cleanup()
	repo := repository.NewDMRepository(db)
	svc := NewDMService(repo, nil)
	anaBea, err := repo.OpenWith("org-1", "u-ana", "u-bea")
	if err != nil {
		t.Fatal(err)
	}
	anaCarla, err := repo.OpenWith("org-1", "u-ana", "u-carla")
	if err != nil {
		t.Fatal(err)
	}

	att := &domain.DMAttachment{Path: "dm/x/captura.png", FileName: "captura.png"}
	att.ID = "att-1"
	if err := svc.AddAttachment(anaBea.ID, "u-ana", att); err != nil {
		t.Fatal(err)
	}
	if att.ConversationID != anaBea.ID || att.UploadedBy != "u-ana" {
		t.Fatalf("se guardó como %q de %q", att.ConversationID, att.UploadedBy)
	}

	for _, quien := range []string{"u-ana", "u-bea"} {
		if _, err := svc.Attachment(anaBea.ID, "att-1", quien); err != nil {
			t.Errorf("%s, que es de la conversación → %v", quien, err)
		}
	}
	if _, err := svc.Attachment(anaBea.ID, "att-1", "u-carla"); !errors.Is(err, repository.ErrConversationNotFound) {
		t.Errorf("carla, de la misma org pero no de la conversación → %v", err)
	}
	// Carla sí es de su conversación con ana, pero el adjunto no es de esa.
	if _, err := svc.Attachment(anaCarla.ID, "att-1", "u-carla"); !errors.Is(err, repository.ErrDMAttachmentNotFound) {
		t.Errorf("el adjunto de otra conversación pedido por la suya → %v", err)
	}

	otro := &domain.DMAttachment{Path: "dm/x/y.png", FileName: "y.png"}
	otro.ID = "att-2"
	if err := svc.AddAttachment(anaBea.ID, "u-carla", otro); !errors.Is(err, repository.ErrConversationNotFound) {
		t.Errorf("carla subiendo a una conversación ajena → %v", err)
	}
	if err := svc.Member(anaBea.ID, "u-carla"); !errors.Is(err, repository.ErrConversationNotFound) {
		t.Errorf("Member deja pasar a carla: %v", err)
	}
}
