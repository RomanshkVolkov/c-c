package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

func userComment(userID string) *domain.ReportComment {
	return &domain.ReportComment{AuthorUserID: &userID}
}

// A tenant may correct or withdraw what its own key wrote, and nothing else.
// The middleware opens the door; this is the lock.
func TestATenantCanOnlyChangeItsOwnReplies(t *testing.T) {
	tenant := commentAuthor{label: "portento"}

	if !ownsComment(tenant, &domain.ReportComment{AuthorLabel: "portento"}) {
		t.Error("a tenant cannot change the reply it wrote itself")
	}
	// A person's comment on the tenant's own board stays off limits: the board
	// is shared with the cac team, and a key is not a licence to rewrite them.
	if ownsComment(tenant, userComment("u-1")) {
		t.Error("a tenant reached a person's comment")
	}
	// The reporter's own words, which carry neither an author id nor a label.
	if ownsComment(tenant, &domain.ReportComment{}) {
		t.Error("a tenant reached the reporter's comment")
	}
}

// The person path must not have loosened on the way through.
func TestAPersonStillOnlyChangesTheirOwn(t *testing.T) {
	me := "u-1"
	author := commentAuthor{userID: &me}

	if !ownsComment(author, userComment("u-1")) {
		t.Error("a person cannot edit their own comment")
	}
	if ownsComment(author, userComment("u-2")) {
		t.Error("a person reached someone else's comment")
	}
	if ownsComment(author, &domain.ReportComment{AuthorLabel: "portento"}) {
		t.Error("a person reached a tenant's comment")
	}
	// The reporter's comment has a nil author. Comparing two nils, or
	// dereferencing one, is how this check gets broken by a refactor.
	if ownsComment(author, &domain.ReportComment{}) {
		t.Error("a person reached the reporter's comment")
	}
	if ownsComment(commentAuthor{}, &domain.ReportComment{}) {
		t.Error("a caller with no identity at all matched the reporter's comment")
	}
}
