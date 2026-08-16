import { describe, expect, it } from "vitest";
import { mentionHref, userIdFromHref } from "./mention-menu";

// A mention is one link, written by the picker and read back twice: here, to
// render it as a person, and on the server, to decide who gets notified. The
// two parsers have to agree — if they drift, a mention renders perfectly and
// pings nobody, which looks like the feature working.
describe("a mention survives the round trip", () => {
  const id = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";

  it("reads back the id the picker wrote", () => {
    expect(userIdFromHref(mentionHref(id))).toBe(id);
  });

  it("claims nothing that isn't one", () => {
    for (const href of [
      "/tasks?task=" + id, // a card citation, which has its own handler
      "https://example.com/cac:user/" + id,
      "cac:user/todos", // not an id
      "cac:user/",
      "mailto:ana@example.com",
    ]) {
      expect(userIdFromHref(href)).toBeNull();
    }
  });
});
