import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hablarle a un agente con identidad (versión 2).
 *
 * Desde la versión 2 el agente exige en todo `/api/v1` un pase que firma el
 * backend. Quien llama sólo tiene la URL, así que `agentFetch` busca de qué
 * servidor es por el origen y le pone el pase. Lo que se fija aquí:
 *
 * 1. Un agente de los de antes (sin identidad) se sigue llamando sin pase.
 * 2. Uno con identidad lleva `Authorization: Bearer <pase>`, y el pase se
 *    reusa mientras no esté por caducar — no uno por petición.
 * 3. Un 401 pide otro pase y reintenta **una vez**.
 * 4. El stream de logs (`EventSource`, que no manda cabeceras) lleva el pase
 *    en la URL.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post } }));

const { agentFetch, agentStreamUrl, registerAgent } = await import("./agent");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

let n = 0;
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  post.mockReset().mockImplementation(async () => ({
    success: true,
    data: { token: `pase-${++n}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  }));
});

const cabecera = (i: number) => new Headers((fetchMock.mock.calls[i][1] as RequestInit).headers).get("Authorization");

describe("hablarle al agente", () => {
  it("a uno de los de antes, sin pase", async () => {
    registerAgent({ id: "viejo", host: "10.0.0.9", agentPort: 9090, hasAgentToken: false });
    await agentFetch("http://10.0.0.9:9090/api/v1/nodes");
    expect(post).not.toHaveBeenCalled();
    expect(cabecera(0)).toBeNull();
  });

  it("a uno con identidad, con su pase, y el mismo pase para la siguiente", async () => {
    registerAgent({ id: "srv-1", host: "10.0.0.1", agentPort: 9090, hasAgentToken: true });
    await agentFetch("http://10.0.0.1:9090/api/v1/nodes");
    await agentFetch("http://10.0.0.1:9090/api/v1/services");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/agent-session", {}, true);
    expect(cabecera(0)).toMatch(/^Bearer pase-/);
    expect(cabecera(1)).toBe(cabecera(0));
  });

  it("un 401 pide otro pase y reintenta una vez", async () => {
    registerAgent({ id: "srv-2", host: "10.0.0.2", agentPort: 9090, hasAgentToken: true });
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await agentFetch("http://10.0.0.2:9090/api/v1/nodes");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cabecera(1)).not.toBe(cabecera(0));
  });

  it("y si el segundo también es 401, no insiste más", async () => {
    registerAgent({ id: "srv-3", host: "10.0.0.3", agentPort: 9090, hasAgentToken: true });
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const res = await agentFetch("http://10.0.0.3:9090/api/v1/nodes");
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("el stream de logs lleva el pase en la URL", async () => {
    registerAgent({ id: "srv-4", host: "10.0.0.4", agentPort: 9090, hasAgentToken: true });
    const url = await agentStreamUrl("http://10.0.0.4:9090/api/v1/services/abc/logs");
    expect(new URL(url).searchParams.get("access_token")).toMatch(/^pase-/);
    // Y a uno sin identidad, la URL tal cual.
    expect(await agentStreamUrl("http://10.0.0.9:9090/api/v1/services/abc/logs")).toBe(
      "http://10.0.0.9:9090/api/v1/services/abc/logs",
    );
  });
});
