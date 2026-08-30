import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * The boundary exists because a crash used to leave no trace at all: React
 * unmounted everything and the window showed its own background. Two bugs were
 * diagnosed from that one symptom, both by guessing from a screenshot.
 *
 * So what is checked here is not the styling — it is that the crash gets
 * *recorded*, and recorded once.
 */

const post = vi.fn(async (_path: string, _body?: unknown, _auth?: boolean) => ({
  success: true,
  data: {},
}));
vi.mock("@/lib/api", () => ({
  api: { post: (p: string, b?: unknown, a?: boolean) => post(p, b, a), get: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));

const { default: ErrorBoundary } = await import("@/components/ErrorBoundary");

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  post.mockClear();
  // The boundary deliberately does not file while developing — otherwise every
  // crash somebody is in the middle of causing lands on the real board. Tests
  // run as dev, so that guard has to be lifted to exercise the reporting.
  vi.stubEnv("DEV", false);
  // React logs the caught error itself; silencing keeps the run readable.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
  cleanup();
});

const bodyOf = (call: number) => (post.mock.calls[call]?.[1] ?? {}) as Record<string, unknown>;

describe("when a render throws", () => {
  it("says so on screen instead of leaving it blank", () => {
    render(
      <ErrorBoundary>
        <Boom message="algo explotó" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something broke/i)).toBeTruthy();
    // The message itself, because that is what somebody would otherwise have to
    // photograph and send.
    expect(screen.getByText(/algo explotó/)).toBeTruthy();
  });

  it("files it as a card on cac's own board", () => {
    render(
      <ErrorBoundary>
        <Boom message="algo explotó" />
      </ErrorBoundary>,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain("/api/v1/task-lists/ca0bfd49-0909-43eb-8135-bc8ecd0f282c/tasks");
    expect(String(bodyOf(0).title)).toContain("algo explotó");
  });

  it("marks it internal, so a stack trace can never reach a client", () => {
    render(
      <ErrorBoundary>
        <Boom message="algo explotó" />
      </ErrorBoundary>,
    );
    expect(bodyOf(0).visibility).toBe("internal");
  });

  it("gives the same crash the same key, so reloading doesn't flood the board", () => {
    render(
      <ErrorBoundary>
        <Boom message="siempre el mismo" />
      </ErrorBoundary>,
    );
    cleanup();
    render(
      <ErrorBoundary>
        <Boom message="siempre el mismo" />
      </ErrorBoundary>,
    );
    expect(post).toHaveBeenCalledTimes(2);
    // Two attempts, one card: the server dedupes on this.
    expect(bodyOf(0).idempotencyKey).toBe(bodyOf(1).idempotencyKey);
    expect(String(bodyOf(0).idempotencyKey)).toMatch(/^crash-/);
  });

  it("gives a different crash a different key", () => {
    render(
      <ErrorBoundary>
        <Boom message="uno" />
      </ErrorBoundary>,
    );
    cleanup();
    render(
      <ErrorBoundary>
        <Boom message="otro distinto" />
      </ErrorBoundary>,
    );
    expect(bodyOf(0).idempotencyKey).not.toBe(bodyOf(1).idempotencyKey);
  });
});
