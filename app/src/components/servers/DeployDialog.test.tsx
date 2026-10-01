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
 * 6. El aviso del CI: la llave se enseña una vez y no se queda en el store,
 *    acuñar otra (que tumba la de ahora) se confirma, y pasar a que cac
 *    despliegue cada aviso también, porque es lo que cambia quién despliega.
 */

const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, patch }, apiUrl: (p: string) => `https://cac.test${p}` }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
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
  repoFullName: "", onCINotify: "record", ciKeyPreview: "", currentImage: "", previousImage: "",
};

const build = (sha: string) => ({
  id: `b-${sha}`, createdAt: "2026-09-30T10:00:00Z", deployableId: "dp-1", sha, image: `ghcr.io/dwit-mexico/api:${sha}`,
  ref: "refs/heads/main", actor: "ana", runUrl: "", source: "ci",
});

const fila = (over: Record<string, unknown> = {}) => ({
  id: "d-1", createdAt: "2026-09-30T10:00:00Z", deployableId: "dp-1", serverId: "srv-1",
  image: "ghcr.io/dwit-mexico/api:abc1234", finalImage: "ghcr.io/dwit-mexico/api:abc1234", previousImage: "",
  requestedBy: "user", requestedByUserId: "u", requestedByName: "Ana", status: "succeeded", error: "", rollbackOfId: "",
  ...over,
});

function respuestas(deployables: unknown[], history: unknown[], builds: unknown[] = []) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/deployables")) return { success: true, data: deployables };
    if (url.endsWith("/builds")) return { success: true, data: builds };
    if (url.endsWith("/deployments")) return { success: true, data: history };
    return { success: true, data: { log: "" } };
  });
}

const pintar = (s: Server = server()) =>
  render(<DeployDialog server={s} service={service} open onOpenChange={() => {}} />);

const botonDesplegar = () => screen.getByRole("button", { name: /^(desplegar|deploy|desplegando…|deploying…)$/i }) as HTMLButtonElement;

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {}, builds: {} });
  get.mockReset();
  post.mockReset();
  patch.mockReset();
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

describe("el aviso del CI", () => {
  const KEY = "dk_0123456789abcdef0123456789abcdef";

  it("la llave se enseña una vez, con el paso para el workflow, y no se queda en el store", async () => {
    respuestas([deployable], []);
    post.mockResolvedValue({ success: true, data: { key: KEY, preview: "dk_012345…" } });
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /^(acuñar llave|mint key)$/i }));
    await waitFor(() => expect(screen.getByTestId("ci-key").textContent).toBe(KEY));
    // La primera no tumba nada: no se pregunta.
    expect(confirmar).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/ci-key", {}, true);

    const paso = screen.getByText(/X-Deploy-Key/).textContent ?? "";
    expect(paso).toContain("https://cac.test/ingest/v1/deploys");
    expect(paso).toContain("secrets.CAC_DEPLOY_KEY");
    expect(paso).not.toContain(KEY);

    expect(JSON.stringify(useDeploymentsStore.getState())).not.toContain(KEY);
    expect(screen.getByText(/dk_012345…/)).toBeTruthy();
  });

  it("acuñar otra tumba la de ahora: se pregunta, y si no, no se toca", async () => {
    respuestas([{ ...deployable, ciKeyPreview: "dk_viejaa…" }], []);
    confirmar.mockResolvedValue(false);
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /^(acuñar otra|mint another)$/i }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(confirmar.mock.calls[0][0].description).toContain("dk_viejaa…");
    expect(post).not.toHaveBeenCalled();
  });

  it("que cac despliegue cada aviso se confirma; volver a apuntar, no", async () => {
    respuestas([deployable], []);
    confirmar.mockResolvedValue(true);
    patch.mockResolvedValue({ success: true, data: { ...deployable, onCINotify: "deploy" } });
    pintar();
    fireEvent.click(await screen.findByRole("radio", { name: /^(desplegar|deploy)$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "/api/v1/servers/srv-1/deployables/dp-1",
      { name: "app", environment: "prod", repoFullName: "", onCINotify: "deploy", buildWorkflow: "" },
      true,
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^(desplegar|deploy)$/i }).getAttribute("aria-checked")).toBe("true"),
    );

    patch.mockResolvedValue({ success: true, data: { ...deployable, onCINotify: "record" } });
    fireEvent.click(screen.getByRole("radio", { name: /^(apuntar|record)$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(confirmar).toHaveBeenCalledTimes(1);
  });

  it("el repo y el workflow se guardan sin tocar lo demás de la fila", async () => {
    respuestas([{ ...deployable, onCINotify: "deploy", buildWorkflow: "viejo.yml" }], []);
    patch.mockResolvedValue({ success: true, data: { ...deployable, repoFullName: "dwit/api", buildWorkflow: "prod.yml" } });
    pintar();
    const guardar = await screen.findByRole("button", { name: /^(guardar|save)$/i });
    expect((guardar as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/(repo de github|github repo)/i), { target: { value: " dwit/api " } });
    fireEvent.change(screen.getByLabelText(/(workflow que publica|workflow that publishes)/i), { target: { value: "prod.yml" } });
    fireEvent.click(guardar);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/v1/servers/srv-1/deployables/dp-1",
        { name: "app", environment: "prod", repoFullName: "dwit/api", onCINotify: "deploy", buildWorkflow: "prod.yml" },
        true,
      ),
    );
  });

  it("cambiar de modo no borra el workflow", async () => {
    respuestas([{ ...deployable, buildWorkflow: "prod.yml" }], []);
    confirmar.mockResolvedValue(true);
    patch.mockResolvedValue({ success: true, data: { ...deployable, onCINotify: "deploy", buildWorkflow: "prod.yml" } });
    pintar();
    fireEvent.click(await screen.findByRole("radio", { name: /^(desplegar|deploy)$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].buildWorkflow).toBe("prod.yml");
  });

  it("una versión publicada se despliega desde su fila, salvo con otro en curso", async () => {
    respuestas([deployable], [], [
      { ...build("def5678aa"), runUrl: "javascript:alert(1)" },
      { ...build("abc1234bb"), runUrl: "https://github.com/a/b/actions/runs/9" },
    ]);
    post.mockResolvedValue({ success: true, data: fila({ status: "queued" }) });
    pintar();
    // El enlace a la ejecución sólo si es una página web: lo escribe el CI.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /(abrir la ejecución|open the ci run)/i })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /(desplegar|deploy) abc1234/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "abc1234bb" }, true),
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /(desplegar|deploy) def5678/i }) as HTMLButtonElement).disabled).toBe(true),
    );
  });
});
