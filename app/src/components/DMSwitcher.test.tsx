import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * The selector that took the screen down.
 *
 * The people store exposed `current()`, which built its result with `?? []` —
 * a fresh array every call. Read through `getState()` that is harmless, and two
 * callers do exactly that. Used as a zustand *selector* it is fatal: a new
 * reference every render means render → new reference → render, which React
 * ends with error #185 ("Maximum update depth exceeded"). With no error
 * boundary at the time, the app simply went blank.
 *
 * It reached a shipped release because nothing here mounted this component. So
 * the test is the mount itself: an infinite loop throws, and a plain render is
 * enough to catch it.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
// Invocable, no sólo `getState`: el componente lo usa como hook para saber
// quién eres y no ofrecerte una conversación contigo mismo.
vi.mock("@/store/auth.store", () => {
  const estado = { accessToken: "t", session: { id: "u-yo", username: "yo" } };
  return {
    useAuthStore: Object.assign((sel: (s: typeof estado) => unknown) => sel(estado), {
      getState: () => estado,
      subscribe: () => () => {},
    }),
  };
});
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: Object.assign(
    (sel: (s: { currentOrgId: string }) => unknown) => sel({ currentOrgId: "org-1" }),
    { getState: () => ({ currentOrgId: "org-1" }) },
  ),
}));

const { default: DMSwitcher } = await import("@/components/DMSwitcher");
const { usePeopleStore } = await import("@/store/people.store");

afterEach(cleanup);

describe("the direct-message picker", () => {
  it("renders when nobody has been loaded yet", () => {
    // The exact state that looped: no entry for this org, so the selector had
    // to produce the empty case.
    usePeopleStore.setState({ byOrg: {} });
    expect(() => render(<DMSwitcher onPicked={() => {}} />)).not.toThrow();
  });

  it("renders with colleagues loaded", () => {
    usePeopleStore.setState({ byOrg: { "org-1": [{ id: "u-1", username: "ana" }] } });
    expect(() => render(<DMSwitcher onPicked={() => {}} />)).not.toThrow();
  });
});

describe("a quién se ofrece escribir", () => {
  it("no se ofrece a uno mismo", () => {
    usePeopleStore.setState({
      byOrg: {
        "org-1": [
          { id: "u-yo", username: "yo" },
          { id: "u-otra", username: "otra" },
        ],
      },
    } as never);

    const { container } = render(<DMSwitcher onPicked={() => {}} />);
    // El servidor rechaza una conversación contigo mismo, así que ofrecerla
    // sería proponer algo que la app va a negar.
    expect(container.textContent).toContain("otra");
    expect(container.textContent).not.toContain("yo");
  });
});
