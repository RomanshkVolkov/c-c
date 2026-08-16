import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * Two pickers in one editor.
 *
 * Tiptap's Suggestion helper defaults to a single plugin key — `suggestion$` —
 * so a second one in the same editor is "a different instance of a keyed
 * plugin" and ProseMirror refuses to build the state at all. The editor throws
 * during render, and with no error boundary anywhere the whole screen goes
 * with it: the app is left showing its own background, which is what "the
 * screen just goes blue" was.
 *
 * It stayed hidden because no editor had ever loaded two: the `/` menu lives in
 * notes and docs, `#` in the chat, `@` in comments. The chat composer offering
 * `#` and `@` together was the first, and it broke every space's channel in a
 * shipped release.
 *
 * Mounted for real rather than with the editor mocked — the existing drawer
 * test swaps MarkdownEditor for a textarea, which is right for what it checks
 * and is exactly why it could never have caught this.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

const mount = (props: Record<string, unknown>) =>
  render(
    <PromptProvider>
      <MarkdownEditor value="" onChange={() => {}} {...props} />
    </PromptProvider>,
  );

const cards = () => [{ id: "t-1", seq: 1, title: "una tarjeta" }];
const people = () => [{ id: "u-1", username: "ana" }];

describe("an editor can carry more than one suggestion picker", () => {
  it("builds with the card picker and the mention picker together", () => {
    // The chat composer.
    expect(() => mount({ cards, people })).not.toThrow();
  });

  it("builds with all three at once", () => {
    // Nothing offers this combination today; it is here so that whoever does
    // finds out from a test rather than from a blank screen.
    expect(() => mount({ cards, people, blockTools: true })).not.toThrow();
  });

  it("still builds with each one alone", () => {
    expect(() => mount({ cards })).not.toThrow();
    expect(() => mount({ people })).not.toThrow();
    expect(() => mount({ blockTools: true })).not.toThrow();
  });
});
