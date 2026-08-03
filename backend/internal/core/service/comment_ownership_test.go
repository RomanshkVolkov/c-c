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
	mine, neighbour := "proj-1", "proj-2"
	tenant := commentAuthor{projectID: &mine}

	if !ownsComment(tenant, &domain.ReportComment{AuthorProjectID: &mine}) {
		t.Error("a tenant cannot change the reply it wrote itself")
	}
	// Belt and braces: the report gate already keeps a tenant off another
	// project's reports, but ownership must not depend on that being right.
	if ownsComment(tenant, &domain.ReportComment{AuthorProjectID: &neighbour}) {
		t.Error("a tenant reached another project's comment")
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
	other := "proj-1"
	if ownsComment(author, &domain.ReportComment{AuthorProjectID: &other}) {
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
