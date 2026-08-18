package domain

import "time"

// Notification is one thing that happened, kept for the person it happened to.
//
// The app already learns about events live, but only while it is open — the
// unread badge could never mean more than "since you last launched me". That
// gap is the whole reason this table exists: a row here outlives the session,
// so coming back after a day still tells you what you missed.
//
// One row per recipient rather than one per event with a join. A notification
// is read by one person, and "read" belongs to the row that person owns.
type Notification struct {
	BaseModel
	UserID string `gorm:"type:varchar(36);index:idx_notif_inbox,priority:1;not null" json:"-"`
	// OrgID scopes it, so switching organizations does not show another
	// client's traffic in your inbox.
	OrgID string `gorm:"type:varchar(36);index" json:"orgId"`
	// Kind is what happened, in the same vocabulary as the live events, so the
	// two paths can never disagree about what a thing is called.
	Kind  string `gorm:"type:varchar(40);not null" json:"kind"`
	Title string `gorm:"type:varchar(200);not null" json:"title"`
	Body  string `gorm:"type:varchar(400)" json:"body"`
	// Link is where this takes you when clicked — an in-app route. A
	// notification you cannot act on is just noise with a timestamp.
	Link string `gorm:"type:varchar(300)" json:"link"`
	// ReadAt nil means unread. A timestamp rather than a flag because "when did
	// I read this" is the question that orders an inbox.
	ReadAt *time.Time `gorm:"index:idx_notif_inbox,priority:2" json:"readAt,omitempty"`
}

// NotificationFeed is what the panel shows: the notifications and the number
// the badge needs, so it takes one request and not two.
type NotificationFeed struct {
	Items  []Notification `json:"items"`
	Unread int64          `json:"unread"`
}
