package domain

import "regexp"

// ─── Mentions ─────────────────────────────────────────────────────────────────

// MentionRef is the link a mention is stored as: `[@jose](cac:user/<uuid>)`.
//
// A scheme of our own rather than a path like `/users/<id>`, for two reasons.
// A real path would collide with a route somebody might add later, and would be
// followed by anything that treats the markdown as ordinary text. And a scheme
// makes extracting mentions from a body unambiguous — the server has to do that
// on every message, and "looks like a link to a user" is not a rule worth
// guessing at.
func MentionRef(userID string) string { return "cac:user/" + userID }

// mentionPattern matches the target of a mention link, and nothing else. Ids
// are uuids, so the shape is pinned rather than left as "anything after the
// slash": a body is written by a person and arrives as free text.
var mentionPattern = regexp.MustCompile(`cac:user/([0-9a-fA-F-]{36})`)

// ExtractMentions returns the user ids named in a body, without duplicates and
// in the order they appear.
//
// Order matters only so the result is stable — two identical bodies produce the
// same list, which keeps events and tests from depending on map iteration.
//
// **These ids are asserted, not verified.** The body comes from whoever typed
// it, so a caller could name anybody in the platform. Deciding who may actually
// be mentioned is the service's job, against the item's organization; this
// function only reads what the text says.
func ExtractMentions(body string) []string {
	matches := mentionPattern.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		id := m[1]
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
