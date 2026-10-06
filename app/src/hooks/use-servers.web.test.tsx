import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * En la versión web no se piden servidores ni se sondea a sus agentes: un
 * navegador no alcanza la red del agente, y el sondeo **escribe** el estado, así
 * que un teléfono daría por caído un servidor sano. Mutante: quitar la guarda.
 */
vi.stubEnv("VITE_TARGET", "web");

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post } }));
vi.mock("@/lib/agent", () => ({ agentResponde: vi.fn(async () => false), registerAgent: vi.fn() }));

const { useServers } = await import("./use-servers");

describe("los servidores en la versión web", () => {
  it("ni se piden ni se sondean", async () => {
    const { result } = renderHook(() => useServers());
    await new Promise((r) => setTimeout(r, 0));
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(result.current.servers).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
