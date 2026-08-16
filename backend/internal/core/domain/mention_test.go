package domain

import "testing"

// What counts as naming somebody.
//
// The body is free text typed by a person, so this is a parser over hostile
// input in the ordinary sense: it decides who gets pinged, and being wrong in
// either direction is a bug people notice — a mention that never arrives, or a
// notification for something that wasn't a mention at all.
func TestExtractMentions(t *testing.T) {
	const ana = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8"
	const bea = "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"

	t.Run("reads the ids a message names", func(t *testing.T) {
		body := "ojo con esto [@ana](" + MentionRef(ana) + ") y [@bea](" + MentionRef(bea) + ")"
		got := ExtractMentions(body)
		if len(got) != 2 || got[0] != ana || got[1] != bea {
			t.Errorf("got %v", got)
		}
	})

	t.Run("names somebody once however many times they appear", func(t *testing.T) {
		body := "[@ana](" + MentionRef(ana) + ") … otra vez [@ana](" + MentionRef(ana) + ")"
		if got := ExtractMentions(body); len(got) != 1 {
			t.Errorf("one person, one notification: got %v", got)
		}
	})

	t.Run("ignores an @ that is just text", func(t *testing.T) {
		// Writing "@ana" by hand, or an email address, must not ping anyone:
		// only the link the picker inserts counts.
		for _, body := range []string{"avisa a @ana", "escribe a ana@example.com", "sin nada"} {
			if got := ExtractMentions(body); got != nil {
				t.Errorf("%q should name nobody, got %v", body, got)
			}
		}
	})

	t.Run("ignores something shaped like the scheme but not an id", func(t *testing.T) {
		for _, body := range []string{
			"[x](cac:user/todos)",
			"[x](cac:user/)",
			"[x](cac:user/12345)",
		} {
			if got := ExtractMentions(body); got != nil {
				t.Errorf("%q is not a user id, got %v", body, got)
			}
		}
	})
}
