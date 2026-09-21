package domain

import "regexp"

// ─── What a body cites ────────────────────────────────────────────────────────
//
// Beside mention.go, and on purpose: this is the same question asked of the
// same text. A message body is the only record of what it points at — there is
// no join table for "this message shows that image" and there is not going to
// be one — so the tabs that list a channel's media and links are built by
// reading the bodies back.
//
// Everything here is **pure**. It takes a string and returns what the string
// says, asserts nothing about whether those things exist, and belongs to
// whoever calls it to check. Same contract as ExtractMentions, for the same
// reason: the text arrives as free text somebody typed.

// RecordingRef is how a recording is pointed at from inside a body:
// `[watch it](cac:recording/<uuid>)`.
//
// The scheme mention.go already argued for, reused rather than re-decided. A
// real path would collide with a route somebody adds later and would be
// followed by anything treating the markdown as ordinary text; a scheme of our
// own is unambiguous to extract and inert everywhere else.
func RecordingRef(recordingID string) string { return "cac:recording/" + recordingID }

// linkPattern matches a URL in a body, whether it was written as
// `[label](url)` or pasted bare.
//
// Two things it does deliberately:
//
//   - **It stops at `)`.** A markdown link's closing paren is not part of the
//     URL, and swallowing it hands every tidy `[docs](https://x.dev/a)` a
//     trailing bracket that breaks the link when somebody opens it.
//   - **It requires the scheme at a boundary.** Without `\b`, `shttp://x` and
//     the `http` inside a word both match, so the cheap `LIKE '%http%'`
//     prefilter the query uses would end up defining what a link is. It does
//     not: this does.
var linkPattern = regexp.MustCompile(`\bhttps?://[^\s<>()\[\]"']+`)

// mdLinkPattern matches `[label](url)`, so a link can keep the words it was
// given. A list of forty bare URLs is a list nobody reads.
var mdLinkPattern = regexp.MustCompile(`\[([^\]]*)\]\((https?://[^\s)]+)\)`)

// attachmentPattern matches the target of a chat attachment, and nothing else.
//
// Pinned to the exact shape ChatAttachmentRef writes, with the id as a uuid —
// the same discipline as mentionPattern. "Anything that looks like an
// attachment URL" would let a pasted string name a row in another space, and
// the space check downstream is what stops it from mattering; this is what
// stops it from being asked in the first place.
var attachmentPattern = regexp.MustCompile(
	`/api/v1/task-spaces/[0-9a-zA-Z-]{1,36}/chat/attachments/([0-9a-fA-F-]{36})/raw`)

// Link is one URL a body points at, with the words it was given.
type Link struct {
	URL   string `json:"url"`
	Label string `json:"label,omitempty"`
}

// ExtractLinks returns the URLs a body points at, deduplicated by URL and in
// the order they appear.
//
// Order is for stability, as in ExtractMentions: two identical bodies give the
// same list, so nothing downstream depends on map iteration.
//
// The label of the **first** occurrence wins. A URL pasted bare later in the
// same message doesn't erase the words it was introduced with.
func ExtractLinks(body string) []Link {
	out := []Link{}
	seen := map[string]int{}
	add := func(url, label string) {
		if i, ok := seen[url]; ok {
			// Already known. A later labelled occurrence still fills in a label
			// the first one didn't have — "bare, then named" is how somebody
			// pastes a URL and then explains it.
			if label != "" && out[i].Label == "" {
				out[i].Label = label
			}
			return
		}
		seen[url] = len(out)
		out = append(out, Link{URL: url, Label: label})
	}
	for _, m := range mdLinkPattern.FindAllStringSubmatch(body, -1) {
		add(m[2], m[1])
	}
	for _, url := range linkPattern.FindAllString(body, -1) {
		add(url, "")
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ExtractAttachmentIDs returns the chat attachments a body shows, without
// duplicates and in the order they appear.
//
// **These ids are asserted, not verified**, exactly like mentions: the body is
// text, and a body can name an attachment of another space. Answering whether
// the caller may see them is the query's job, and it does it with its own
// `space_id` clause.
func ExtractAttachmentIDs(body string) []string {
	matches := attachmentPattern.FindAllStringSubmatch(body, -1)
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
