import { describe, expect, it } from "vitest";
import { PRIORITIES, PRIORITY_META, priorityMeta } from "@/types/task";

// A value the table had never seen took the whole drawer down.
//
// The server stores `medium` where this API says `normal`, and the detail
// endpoint handed it over untranslated. `PRIORITY_META["medium"]` is undefined,
// reading `.className` off it throws inside render, and the screen goes blank —
// no message, no card, nothing to tell you which of the fifteen you clicked.
//
// The server side is fixed. This is the second half: an unrecognised string is
// something to draw plainly, not something to die on.

describe("drawing a priority", () => {
  it("draws every one this build knows", () => {
    for (const p of PRIORITIES) {
      expect(priorityMeta(p).label).toBe(PRIORITY_META[p].label);
    }
  });

  it("draws `medium` as the same rung it has always called `normal`", () => {
    expect(priorityMeta("medium")).toEqual(PRIORITY_META.normal);
  });

  it("survives a value it has never heard of", () => {
    for (const odd of ["blocker", "", "URGENT", "critical"]) {
      const meta = priorityMeta(odd);
      expect(typeof meta.label).toBe("string");
      expect(typeof meta.className).toBe("string");
    }
  });

  it("shows an unknown value by its own name rather than guessing", () => {
    expect(priorityMeta("blocker").label).toBe("blocker");
  });
});
