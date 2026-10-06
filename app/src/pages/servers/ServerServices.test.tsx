import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Un viewer ve los servicios y sus logs, pero no los reinicia ni los despliega:
 * su pase al agente es de lectura (agente v5) y el backend no le encola un
 * deploy. Los botones no salen, en vez de salir y fallar. Mutantes: enseñarlos
 * a todos; mirar el rol de otra org.
 */
vi.mock("./ServerLayout", () => ({
  useServerContext: () => ({
    server: { id: "srv-1", orgId: "org-1", host: "10.0.0.1", agentPort: 9090 },
    swarm: {
      loading: false,
      services: [{ id: "s1", name: "api", image: "x:1", stack: "a", replicas: { running: 1, desired: 1 }, updatedAt: "2026-10-01T00:00:00Z" }],
    },
  }),
}));
vi.mock("@/components/servers/DeployDialog", () => ({ default: () => null }));

const { default: ServerServices } = await import("./ServerServices");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const conRol = (role: string, orgId = "org-1") =>
  useOrgsStore.setState({ orgs: [{ id: orgId, role }, { id: "org-9", role: "admin" }] } as never);
const montar = () =>
  render(
    <MemoryRouter>
      <ServerServices />
    </MemoryRouter>,
  );
const hay = (re: RegExp) => screen.queryByRole("button", { name: re }) !== null;

beforeEach(() => useAuthStore.setState({ session: { id: "u-1", username: "vera", superadmin: false } } as never));
afterEach(cleanup);

describe("los servicios según el rol", () => {
  it("un viewer lee los logs, sin reiniciar ni desplegar", () => {
    conRol("viewer");
    montar();
    expect(hay(/^(logs|registros)$/i)).toBe(true);
    expect(hay(/^(restart|reiniciar)$/i)).toBe(false);
    expect(hay(/^(deploy|desplegar)$/i)).toBe(false);
  });

  it("un miembro sí", () => {
    conRol("member");
    montar();
    expect(hay(/^(restart|reiniciar)$/i)).toBe(true);
    expect(hay(/^(deploy|desplegar)$/i)).toBe(true);
  });
});
