import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * «Sin leer» en el resumen es lo de esta org.
 *
 * Los directos y los canales sin leer llegan del servidor con todas tus orgs
 * juntas, y el resumen los listaba todos: la conversación con alguien de otro
 * cliente salía aquí, y pulsarla abría un hilo de otra org. Igual que la barra
 * lateral — ver `lib/unread.ts`.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/hooks/use-servers", () => ({ useServers: () => ({ servers: [] }) }));

const { default: Overview } = await import("./Overview");
const { useOrgsStore } = await import("@/store/orgs.store");

beforeEach(() => {
  api.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/task-spaces"))
      return { success: true, data: [{ id: "sp-1", orgId: "org-1", name: "Uno", folders: [], lists: [] }] };
    if (url.startsWith("/api/v1/chat/unread"))
      return { success: true, data: [{ spaceId: "sp-1", count: 2 }, { spaceId: "sp-2", count: 5 }] };
    if (url.startsWith("/api/v1/dm"))
      return {
        success: true,
        data: [
          { conversationId: "c-1", orgId: "org-1", userId: "u-2", username: "bea", unread: 1 },
          { conversationId: "c-2", orgId: "org-2", userId: "u-3", username: "carla", unread: 4 },
        ],
      };
    return { success: true, data: [] };
  });
  useOrgsStore.setState({ orgs: [{ id: "org-1", name: "Uno" }], currentOrgId: "org-1" } as never);
});
afterEach(cleanup);

describe("sin leer, en el resumen", () => {
  it("sólo los directos y canales de esta org", async () => {
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText("@bea").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("#Uno").length).toBeGreaterThan(0));
    expect(screen.queryByText("@carla")).toBeNull();
    // El canal de la otra org no está en el árbol: saldría sin nombre.
    expect(screen.queryByText("#a space")).toBeNull();
  });
});
