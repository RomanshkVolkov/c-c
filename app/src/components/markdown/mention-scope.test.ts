import { describe, expect, it } from "vitest";
import { mentionsAllowed } from "./mention-scope";

// The rule that keeps a teammate's name out of anything a client reads.

describe("when the mention picker is offered", () => {
  it("on an internal card — nobody outside can read it", () => {
    expect(mentionsAllowed(false, false)).toBe(true);
  });

  it("on a client's card, while writing an internal note", () => {
    expect(mentionsAllowed(true, true)).toBe(true);
  });

  it("never on a client's card in a comment they will read", () => {
    // The one that matters: this is the case where a name leaks.
    expect(mentionsAllowed(true, false)).toBe(false);
  });
});
