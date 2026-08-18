import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Server } from "@/types/server";

/**
 * Que el estado de un servidor deje de mentir.
 *
 * `status` se escribía «pending» al darlo de alta y no lo tocaba nadie más
 * nunca: un agente desplegado y funcionando se leía como pendiente para
 * siempre, y «Agents online» contaba 0 de 1 con la máquina en pie.
 * `UpdateStatus` llevaba en el repositorio sin un solo llamante.
 */

const { get, post, responde } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), responde: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { get, post, patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/agent", () => ({ agentResponde: responde }));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));

const { useServers } = await import("@/hooks/use-servers");

const server = (over: Partial<Server> = {}): Server =>
  ({
    id: "s-1", orgId: "org-1", name: "chido", host: "1.2.3.4", sshPort: 22,
    sshUser: "root", type: "docker-swarm", agentPort: 9090, status: "pending",
    ...over,
  }) as Server;

beforeEach(() => {
  get.mockReset();
  post.mockReset().mockResolvedValue({ success: true });
  responde.mockReset();
});

describe("el estado del agente", () => {
  it("un agente que contesta deja de estar «pending»", async () => {
    get.mockResolvedValue({ success: true, data: [server()] });
    responde.mockResolvedValue(true);

    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers[0]?.status).toBe("online"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/s-1/agent-status", { status: "online" }, true),
    );
  });

  it("uno que no contesta se marca «offline», no se queda en el limbo", async () => {
    get.mockResolvedValue({ success: true, data: [server()] });
    responde.mockResolvedValue(false);

    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers[0]?.status).toBe("offline"));
  });

  it("no reescribe lo que ya estaba bien", async () => {
    get.mockResolvedValue({ success: true, data: [server({ status: "online" })] });
    responde.mockResolvedValue(true);

    renderHook(() => useServers());
    await waitFor(() => expect(responde).toHaveBeenCalled());
    // Sin esta guarda, cada carga de pantalla escribiría el mismo valor.
    expect(post).not.toHaveBeenCalled();
  });

  it("a un kubernetes no se le inventa una avería", async () => {
    get.mockResolvedValue({ success: true, data: [server({ type: "kubernetes" })] });
    responde.mockResolvedValue(false);

    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    // No lleva este agente: probarlo y marcarlo «offline» sería inventarse una
    // avería que no existe.
    expect(responde).not.toHaveBeenCalled();
    expect(result.current.servers[0].status).toBe("pending");
  });
});
