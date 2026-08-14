import { describe, expect, it } from "vitest";
import { cardHref, taskIdFromHref } from "./card-menu";

// Citing a card is the reason this chat exists instead of a Slack channel, and
// the whole mechanism is one link: written by the picker, read back by the
// renderer. If the two ever disagree, a citation renders as a dead link that
// navigates the app away from itself — the failure is silent and looks like the
// chat "just doesn't do that".

describe("a citation survives the round trip", () => {
  it("reads back the id the picker wrote", () => {
    const id = "8474cb83-1c2f-4a54-9c1e-3a2b6d0e5f11";
    expect(taskIdFromHref(cardHref(id))).toBe(id);
  });

  it("stays relative, so it resolves against whichever backend the app points at", () => {
    expect(cardHref("abc").startsWith("/")).toBe(true);
  });
});

describe("what must not be claimed as a citation", () => {
  it("ignores an ordinary link somebody pasted", () => {
    // Claiming this would swallow the click and never open the browser.
    expect(taskIdFromHref("https://example.com/docs")).toBeNull();
  });

  it("ignores a link to the board itself", () => {
    expect(taskIdFromHref("/tasks")).toBeNull();
  });

  it("ignores /tasks with some other query", () => {
    expect(taskIdFromHref("/tasks?list=abc")).toBeNull();
  });

  it("ignores an empty task id rather than opening a drawer for nothing", () => {
    expect(taskIdFromHref("/tasks?task=")).toBeNull();
  });

  it("does not match a path that merely ends in the word tasks", () => {
    // `/api/v1/mytasks?task=x` is not ours. Matching on `includes` would take it.
    expect(taskIdFromHref("/api/v1/mytasks?task=x")).toBeNull();
  });

  it("does not match an external host that happens to have /tasks", () => {
    expect(taskIdFromHref("https://evil.example.com/tasks?task=abc")).toBeNull();
  });
});
