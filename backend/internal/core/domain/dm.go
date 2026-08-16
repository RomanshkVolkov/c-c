package domain

import (
	"time"

	"gorm.io/gorm"
)

// ─── Direct messages ──────────────────────────────────────────────────────────
//
// Two people, one organization, nobody else — not the rest of the org, not a
// superadmin's console, not a webhook.
//
// **Their own tables, deliberately.** A space's channel and a direct message
// have the same shape — author, body, unread, edit, withdraw — and merging them
// under one "conversation" table is the ordinary way to build this. It was not
// taken, for the same reason chat_messages has no visibility column: with one
// table, "who may read this" becomes a predicate every single read has to
// remember, and forgetting it once shows a private conversation to a whole
// organization. With two, a query written against the space channel cannot
// return a direct message however wrong it is, because it is not looking at
// them.
//
// The events these raise carry Event.UserID, which narrows delivery to one
// person — including cutting out the superadmin, who otherwise receives every
// organization's stream.

// DMConversation is the thread between two people inside one organization.
//
// UserLoID / UserHiID are the pair sorted by id, smallest first, with a unique
// index across the three columns. That ordering is what makes the conversation
// *the* conversation rather than one of two: without it, Ana opening a thread
// with Bea and Bea opening one with Ana create separate rows, and each writes
// into a thread the other never sees — with no error anywhere, because both
// look perfectly fine on their own screen.
//
// One conversation per organization, not per pair. Two people who work together
// in two organizations get two threads, because the context is part of what is
// being said and mixing them would carry one client's work into another's.
type DMConversation struct {
	BaseModel
	OrgID    string `gorm:"type:varchar(36);not null;uniqueIndex:idx_dm_pair,priority:1" json:"orgId"`
	UserLoID string `gorm:"type:varchar(36);not null;uniqueIndex:idx_dm_pair,priority:2" json:"-"`
	UserHiID string `gorm:"type:varchar(36);not null;uniqueIndex:idx_dm_pair,priority:3" json:"-"`
}

// SortPair puts two user ids in the canonical order this table stores them in.
// Every write and every lookup goes through it; that is the whole mechanism.
func SortPair(a, b string) (lo, hi string) {
	if a <= b {
		return a, b
	}
	return b, a
}

// Other names the person on the far side of a conversation.
func (c *DMConversation) Other(userID string) string {
	if c.UserLoID == userID {
		return c.UserHiID
	}
	return c.UserLoID
}

// Includes answers whether this conversation is one of somebody's.
//
// The authorization check for every read and write. Deliberately a method on
// the row rather than a WHERE clause repeated in each query: there is one
// answer to "is this yours", and it lives in one place.
func (c *DMConversation) Includes(userID string) bool {
	return userID != "" && (c.UserLoID == userID || c.UserHiID == userID)
}

// DMMessage is one line of a private conversation.
//
// No visibility column here either, and for a stronger reason than in chat:
// there is no audience this could be widened to. The only readers are the two
// people in the conversation.
type DMMessage struct {
	BaseModel
	ConversationID string `gorm:"type:varchar(36);not null;index:idx_dm_time,priority:1" json:"conversationId"`
	// OrgID is denormalised, like everywhere else, so the unread query can scope
	// without joining back to the conversation for every row.
	OrgID        string `gorm:"type:varchar(36);index;not null" json:"orgId"`
	AuthorUserID string `gorm:"type:varchar(36);index;not null" json:"authorUserId"`
	Body         string `gorm:"type:text;not null"              json:"body"`
	// Withdrawing hides; it does not destroy — as in the channels. The read
	// filters it explicitly rather than trusting the scope, because that exact
	// omission has shipped here before.
	DeletedAt gorm.DeletedAt `gorm:"index;index:idx_dm_time,priority:3" json:"-"`
	CreatedAt time.Time      `gorm:"index:idx_dm_time,priority:2"      json:"createdAt"`
}

// DMRead is how far somebody has read in a conversation.
type DMRead struct {
	ConversationID string    `gorm:"type:varchar(36);primaryKey" json:"conversationId"`
	UserID         string    `gorm:"type:varchar(36);primaryKey" json:"userId"`
	LastReadAt     time.Time `json:"lastReadAt"`
}

// ─── Requests / responses ─────────────────────────────────────────────────────

// OpenDMRequest names the person and the organization the thread belongs to.
//
// The organization is explicit rather than derived from the pair: two people
// can share more than one, and choosing for them would put the conversation in
// a context they did not pick.
type OpenDMRequest struct {
	OrgID  string `json:"orgId"  validate:"required"`
	UserID string `json:"userId" validate:"required"`
}

type DMMessageRequest struct {
	Body string `json:"body" validate:"required,min=1,max=8000"`
}

// DMMessageResponse carries the author's name so a thread renders without a
// lookup per line.
type DMMessageResponse struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversationId"`
	AuthorUserID   string    `json:"authorUserId"`
	AuthorName     string    `json:"authorName"`
	Body           string    `json:"body"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// DMSummary is one row of the conversation list: who it's with, and whether
// they have said anything you haven't read.
type DMSummary struct {
	ConversationID string     `json:"conversationId"`
	OrgID          string     `json:"orgId"`
	UserID         string     `json:"userId"`
	Username       string     `json:"username"`
	Unread         int64      `json:"unread"`
	LastMessageAt  *time.Time `json:"lastMessageAt,omitempty"`
}
