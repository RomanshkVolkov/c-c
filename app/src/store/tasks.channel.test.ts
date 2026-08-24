import { beforeEach, describe, expect, it, vi } from "vitest";

// What the app sends when it touches a client's channel.
//
// Two of these are the kind of mistake that breaks an integration quietly, from
// our side, with nothing on theirs to explain it:
//
//   - Sending an empty webhook secret clears the one that is set. The server
//     only replaces a secret when a new one arrives, so "I didn't touch that
//     field" has to mean the field isn't in the request at all. Clear it and
//     every webhook they receive starts failing its signature check.
//
//   - Binding a node reuses the endpoint that renames it, so leaving `name` out
//     renames the space or list to nothing while you were choosing a client.

const post = vi.fn(async (_p: string, _b?: unknown, _a?: boolean) => ({ success: true, data: {} }));
const patch = vi.fn(async (_p: string, _b?: unknown, _a?: boolean) => ({ success: true, data: {} }));
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ success: true, data: null })),
    post: (p: string, b?: unknown, a?: boolean) => post(p, b, a),
    patch: (p: string, b?: unknown, a?: boolean) => patch(p, b, a),
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

describe("changing a channel's rules", () => {
  beforeEach(() => patch.mockClear());

  const body = () => (patch.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;

  it("leaves the webhook secret out when none was typed", async () => {
    await useTasksStore.getState().updateChannel("space", "sp-1", {
      name: "Cliente",
      webhookUrl: "https://example.test/hook",
    });
    expect(body()).not.toHaveProperty("webhookSecret");
  });

  it("sends it when one was typed", async () => {
    await useTasksStore.getState().updateChannel("space", "sp-1", {
      name: "Cliente",
      webhookSecret: "un-secreto-bastante-largo",
    });
    expect(body().webhookSecret).toBe("un-secreto-bastante-largo");
  });

  it("goes to the space or to the list, whichever owns the binding", async () => {
    await useTasksStore.getState().updateChannel("list", "li-1", { name: "Lista" });
    expect(patch.mock.calls[0]?.[0]).toBe("/api/v1/task-lists/li-1/channel");
  });
});

describe("binding a node to a channel", () => {
  beforeEach(() => patch.mockClear());

  it("carries the name, because this is the endpoint that renames", async () => {
    await useTasksStore.getState().bindNode("list", "li-1", "Sprint", "proj-1");
    const sent = (patch.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
    expect(sent.name).toBe("Sprint");
    expect(sent.projectId).toBe("proj-1");
  });

  it("clears the binding with an empty project, not by omitting it", async () => {
    await useTasksStore.getState().bindNode("space", "sp-1", "Espacio", "");
    const sent = (patch.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
    expect(sent).toHaveProperty("projectId", "");
  });
});

describe("moving where a client's reports arrive", () => {
  beforeEach(() => patch.mockClear());

  // Lo que hace posible este botón: el PATCH dejó de borrar lo que no se
  // menciona. Mandar la configuración entera para cambiar la bandeja era la
  // forma de perder un webhook por omisión.
  it("manda sólo la lista, y nada más", async () => {
    await useTasksStore.getState().setChannelInbox("proj-1", "li-9");
    const [url, sent] = patch.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/report-projects/proj-1");
    expect(sent).toEqual({ listId: "li-9" });
  });

  // No al del árbol: la bandeja es del proyecto, no del nodo.
  it("va al endpoint del proyecto", async () => {
    await useTasksStore.getState().setChannelInbox("proj-1", "li-9");
    expect(String(patch.mock.calls[0]?.[0])).not.toContain("task-lists");
  });
});

describe("the empty-secret guard lives in the store", () => {
  beforeEach(() => patch.mockClear());

  // Not in the dialog. A rule that protects a client's integration has to hold
  // for every caller, and the store is the only place all of them pass through.
  it("drops a blank secret even when the caller passes one", async () => {
    await useTasksStore.getState().updateChannel("space", "sp-1", {
      name: "Cliente",
      webhookSecret: "   ",
    });
    expect((patch.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>).not.toHaveProperty(
      "webhookSecret",
    );
  });
})
