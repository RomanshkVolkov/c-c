import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El diálogo de desplegar un servicio.
 *
 * Lo que se fija:
 * 1. Un servicio que no se despliega desde cac se **registra** primero, con lo
 *    que se deduce del propio servicio, y la pantalla dice que eso no toca el
 *    servidor.
 * 2. Desplegar pide un sha: con otra cosa, el botón no se enciende.
 * 3. Con un deploy en cola o en curso, no se puede pedir otro.
 * 4. Sin el agente con identidad no se despliega, y se dice por qué.
 * 5. Volver atrás sólo se ofrece en un deploy que salió bien y tenía algo antes.
 */

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post } }));
const { confirmar } = vi.hoisted(() => ({ confirmar: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const { default: DeployDialog } = await import("./DeployDialog");
const { useDeploymentsStore } = await import("@/store/deployments.store");
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

const server = (over: Partial<Server> = {}): Server =>
  ({
    id: "srv-1", orgId: "org-1", name: "tds", host: "10.0.0.1", sshPort: 22, sshUser: "root",
    type: "docker-swarm", agentPort: 9090, status: "online", hasAgentToken: true, agentVersion: 3, ...over,
  }) as Server;

const service: SwarmService = {
  id: "s1", name: "beta-api-prod_app", image: "ghcr.io/dwit-mexico/api:viejo", stack: "beta-api-prod",
  replicas: { running: 1, desired: 1 }, updatedAt: "2026-09-30T10:00:00Z",
};

const deployable = {
  id: "dp-1", orgId: "org-1", serverId: "srv-1", name: "app", stack: "beta-api-prod",
  serviceName: "beta-api-prod_app", imageRepo: "ghcr.io/dwit-mexico/api", environment: "prod",
  repoFullName: "", onCINotify: "record", currentImage: "", previousImage: "",
};

const fila = (over: Record<string, unknown> = {}) => ({
  id: "d-1", createdAt: "2026-09-30T10:00:00Z", deployableId: "dp-1", serverId: "srv-1",
  image: "ghcr.io/dwit-mexico/api:abc1234", finalImage: "ghcr.io/dwit-mexico/api:abc1234", previousImage: "",
  requestedBy: "user", requestedByUserId: "u", requestedByName: "Ana", status: "succeeded", error: "", rollbackOfId: "",
  ...over,
});

function respuestas(deployables: unknown[], history: unknown[]) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/deployables")) return { success: true, data: deployables };
    if (url.endsWith("/deployments")) return { success: true, data: history };
    return { success: true, data: { log: "" } };
  });
}

const pintar = (s: Server = server()) =>
  render(<DeployDialog server={s} service={service} open onOpenChange={() => {}} />);

const botonDesplegar = () => screen.getByRole("button", { name: /^(desplegar|deploy|desplegando…|deploying…)$/i }) as HTMLButtonElement;

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {} });
  get.mockReset();
  post.mockReset();
  confirmar.mockReset();
});
afterEach(cleanup);

describe("desplegar un servicio", () => {
  it("uno sin registrar se registra con lo que se deduce de él", async () => {
    respuestas([], []);
    post.mockResolvedValue({ success: true, data: deployable });
    pintar();
    await waitFor(() => expect(screen.getByText(/(todavía no se despliega|isn't deployed from cac)/i)).toBeTruthy());
    expect(screen.getByText(/(no cambia nada en el servidor|changes nothing on the server)/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^(registrar|register)$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({
      name: "app", stack: "beta-api-prod", serviceName: "beta-api-prod_app",
      imageRepo: "ghcr.io/dwit-mexico/api", environment: "prod",
    });
  });

  it("pide un sha: con otra cosa el botón no se enciende", async () => {
    respuestas([deployable], []);
    pintar();
    await waitFor(() => expect(botonDesplegar()).toBeTruthy());
    const campo = screen.getByLabelText(/^(commit)$/i);
    fireEvent.change(campo, { target: { value: "latest" } });
    expect(botonDesplegar().disabled).toBe(true);
    fireEvent.change(campo, { target: { value: "abc1234" } });
    expect(botonDesplegar().disabled).toBe(false);

    post.mockResolvedValue({ success: true, data: fila({ status: "queued" }) });
    fireEvent.click(botonDesplegar());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "abc1234" }, true),
    );
  });

  it("con un deploy en curso no se pide otro", async () => {
    respuestas([deployable], [fila({ status: "running" })]);
    pintar();
    await waitFor(() => expect(screen.getByText(/(en curso|running)/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^(commit)$/i), { target: { value: "abc1234" } });
    expect(botonDesplegar().disabled).toBe(true);
  });

  it("sin el agente con identidad no se despliega, y lo dice", async () => {
    respuestas([deployable], []);
    pintar(server({ hasAgentToken: false }));
    await waitFor(() => expect(screen.getByText(/(update agent)/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^(commit)$/i), { target: { value: "abc1234" } });
    expect(botonDesplegar().disabled).toBe(true);
  });

  it("con un agente que no sabe desplegar, tampoco", async () => {
    respuestas([deployable], []);
    pintar(server({ agentVersion: 2 }));
    await waitFor(() => expect(screen.getByText(/(update agent)/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^(commit)$/i), { target: { value: "abc1234" } });
    expect(botonDesplegar().disabled).toBe(true);
  });

  it("el error de un deploy se lee en tu idioma, y el del agente tal cual", async () => {
    respuestas([deployable], [
      fila({ id: "d-2", status: "failed", error: "agent-stopped-responding" }),
      fila({ id: "d-1", status: "failed", error: "docker rechazó la actualización" }),
    ]);
    pintar();
    await waitFor(() => expect(screen.getByText(/(dejó de contestar|stopped responding)/i)).toBeTruthy());
    expect(screen.queryByText(/agent-stopped-responding/)).toBeNull();
    expect(screen.getByText(/docker rechazó la actualización/)).toBeTruthy();
  });

  it("volver atrás sólo en uno que salió bien y tenía algo antes", async () => {
    respuestas([deployable], [
      fila({ id: "d-2", status: "succeeded", previousImage: "ghcr.io/dwit-mexico/api:viejo" }),
      fila({ id: "d-1", status: "failed", previousImage: "ghcr.io/dwit-mexico/api:otro" }),
      fila({ id: "d-0", status: "succeeded", previousImage: "" }),
    ]);
    confirmar.mockResolvedValue(true);
    post.mockResolvedValue({ success: true, data: fila({ id: "d-3", status: "queued" }) });
    pintar();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /(volver a lo de antes|go back to the previous)/i })).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /(volver a lo de antes|go back to the previous)/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deployments/d-2/rollback", {}, true),
    );
  });
});
