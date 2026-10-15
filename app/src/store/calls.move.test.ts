import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pedir la mudanza llega al servidor. Mutante: no mandar `moveCall` (el
 * diálogo lo pediría y la llamada no se mudaría; ver `call_move_test.go`).
 */
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post, get: vi.fn(), delete: vi.fn() } }));

import { useCalls } from "./calls.store";

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ success: true, data: { id: "inv-1", spaceId: "esp-1" } });
});

describe("crear una reunión desde la llamada", () => {
  it("pide mudar la llamada sólo cuando se le dice", async () => {
    await useCalls.getState().create({ orgId: "org-1", spaceId: "esp-1", title: "x", ttlHours: 24, moveCall: true });
    expect(post).toHaveBeenLastCalledWith("/api/v1/call-invites", expect.objectContaining({ moveCall: true }), true);
    await useCalls.getState().create({ orgId: "org-1", spaceId: "esp-1", title: "x", ttlHours: 24 });
    expect(post.mock.lastCall?.[1]).not.toHaveProperty("moveCall");
  });
});
