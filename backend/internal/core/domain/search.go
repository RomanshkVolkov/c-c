package domain

// SearchHit is one thing found, in whatever it was found in.
//
// Flat and small on purpose: the palette shows a line and jumps somewhere, so
// anything richer would be shipping content nobody asked to read. In particular
// no message body travels here — a hit says *that* something matched and where,
// not what it said.
type SearchHit struct {
	Kind  SearchKind `json:"kind"`
	ID    string     `json:"id"`
	Title string     `json:"title"`
	// Where is human context: the list a task lives in, the channel a message
	// was in, the person a conversation is with.
	Where string `json:"where,omitempty"`
	// Link is the in-app route this jumps to.
	Link string `json:"link"`
}

type SearchKind string

const (
	SearchTask    SearchKind = "task"
	SearchNote    SearchKind = "note"
	SearchPerson  SearchKind = "person"
	SearchMessage SearchKind = "message"
	SearchDM      SearchKind = "dm"
)

// SearchResults keeps the sources apart all the way to the client.
//
// Not one merged list, and this is the whole design. Every source here has a
// different rule about who may see it: a task is the organization's, a note is
// one person's, a channel message is readable by everyone in that channel, and
// a direct message is readable by exactly two people. A single ranked list
// would mean one query joining across all of them, and the first person to add
// a source would have to rediscover four different authorization rules to keep
// it honest. Kept apart, each one is queried by a function that can only see
// what that source allows.
type SearchResults struct {
	Tasks    []SearchHit `json:"tasks"`
	Notes    []SearchHit `json:"notes"`
	People   []SearchHit `json:"people"`
	Messages []SearchHit `json:"messages"`
	DMs      []SearchHit `json:"dms"`
}
