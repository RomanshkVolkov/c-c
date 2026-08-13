import { beforeEach, describe, expect, it, vi } from "vitest";

// What the app sends when someone raises work in a client's list.
//
// The rule is the server's: saying nothing means the client sees it. So the one
// thing this store must never do is invent a value — sending "internal" because
// nobody chose would silently hide work from a customer, and sending "public"
// when someone chose internal would publish a note meant for the team. Both are
// wrong in a way nobody notices until the client reads it.

const post = vi.fn(async (_path: string, _body?: unknown, _auth?: boolean) => ({
  success: true,
  data: {},
}));
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ success: true, data: {} })),
    post: (path: string, body?: unknown, auth?: boolean) => post(path, body, auth),
    patch: vi.fn(async () => ({ success: true, data: {} })),
    del: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "org-1" }) },
}));

const { useTasksStore } = await import("@/store/tasks.store");

describe("what the app sends when creating in a client's list", () => {
  beforeEach(() => {
    post.mockClear();
    useTasksStore.setState({ activeListId: "list-1" });
  });

  const bodyOf = () => (post.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;

  it("says nothing when nobody chose, so the server's default applies", async () => {
    await useTasksStore.getState().createTask("una tarea", "st-1");
    expect(bodyOf()).not.toHaveProperty("visibility");
  });

  it("sends internal when that was the choice", async () => {
    await useTasksStore.getState().createTask("una nota interna", "st-1", "internal");
    expect(bodyOf().visibility).toBe("internal");
  });

  it("sends public when that was the choice", async () => {
    await useTasksStore.getState().createTask("algo que ven", "st-1", "public");
    expect(bodyOf().visibility).toBe("public");
  });
});

describe("what the app sends when commenting", () => {
  beforeEach(() => {
    post.mockClear();
  });

  const bodyOf = () => (post.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;

  it("says nothing when nobody chose, so the client reads it too", async () => {
    await useTasksStore.getState().addComment("task-1", "una respuesta");
    expect(bodyOf()).not.toHaveProperty("visibility");
  });

  it("sends internal when that was the choice", async () => {
    await useTasksStore.getState().addComment("task-1", "entre nosotros", "internal");
    expect(bodyOf().visibility).toBe("internal");
  });
});
