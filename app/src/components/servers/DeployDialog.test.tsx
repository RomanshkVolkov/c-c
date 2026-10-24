import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
 * 7. Con el PAT de la app, la llave del CI va sola a los secrets del repo.
 * 8. Lo que se despliega se elige de los commits de la rama del servicio, que
 *    da el backend (sin PAT): el más nuevo ya elegido, y marcado el que corre.
 * 6. El aviso del CI: la llave se enseña una vez y no se queda en el store,
 *    acuñar otra (que tumba la de ahora) se confirma, y pasar a que cac
 *    despliegue cada aviso también, porque es lo que cambia quién despliega.
 */

const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, patch }, apiUrl: (p: string) => `https://cac.test${p}` }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// El Rust de GitHub de la app, simulado: sin PAT por defecto.
function tauri({ pat = false, pushFails = false } = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "github_token_configured") return pat;
    if (cmd === "set_github_secret") {
      if (pushFails) throw new Error("GitHub API 403");
      return null;
    }
    throw new Error(`comando inesperado ${cmd}`);
  });
}
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
  ref: "refs/heads/main", actor: "ana", runUrl: "", source: "ci" as const,
});

const fila = (over: Record<string, unknown> = {}) => ({
  id: "d-1", createdAt: "2026-09-30T10:00:00Z", deployableId: "dp-1", serverId: "srv-1",
  image: "ghcr.io/dwit-mexico/api:abc1234", finalImage: "ghcr.io/dwit-mexico/api:abc1234", previousImage: "",
  requestedBy: "user", requestedByUserId: "u", requestedByName: "Ana", status: "succeeded", error: "", rollbackOfId: "",
  ...over,
});

function respuestas(deployables: unknown[], history: unknown[], builds: unknown[] = [], commits: unknown = { success: true, data: [] }) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/deployables")) return { success: true, data: deployables };
    if (url.endsWith("/commits")) return commits;
    if (url.endsWith("/builds")) return { success: true, data: builds };
    if (url.endsWith("/deployments")) return { success: true, data: history };
    return { success: true, data: { log: "" } };
  });
}

const pintar = (s: Server = server()) =>
  render(<DeployDialog server={s} service={service} open full onOpenChange={() => {}} />);

const botonDesplegar = () => screen.getByRole("button", { name: /^(desplegar|deploy|desplegando…|deploying…)$/i }) as HTMLButtonElement;

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {}, builds: {}, commits: {}, commitsStale: {} });
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  confirmar.mockReset();
  invoke.mockReset();
  tauri();
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
      imageRepo: "ghcr.io/dwit-mexico/api", environment: "prod", shortTags: false,
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

  // Volver atrás despliega en producción: se pregunta antes, diciendo qué
  // imagen vuelve, y un «no» no manda nada. Mutante: volver sin preguntar.
  it("volver atrás se confirma, y si no, no se manda", async () => {
    respuestas([deployable], [fila({ id: "d-2", status: "succeeded", previousImage: "ghcr.io/dwit-mexico/api:viejo" })]);
    confirmar.mockResolvedValue(false);
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /(volver a lo de antes|go back to the previous)/i }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(JSON.stringify(confirmar.mock.calls[0][0])).toContain("viejo");
    await new Promise((r) => setTimeout(r, 0));
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/rollback"), expect.anything(), expect.anything());
  });
});

// El modal es para desplegar: la configuración vive en la página
// «Despliegue», y el modal lleva a ella. Mutantes: el modal con toda la
// configuración; el enlace sin llevar a ningún sitio.
describe("el modal rápido", () => {
  it("despliega y lleva a configurar, sin la configuración dentro", async () => {
    respuestas([deployable], []);
    const configurar = vi.fn();
    render(<DeployDialog server={server()} service={service} open onOpenChange={() => {}} onConfigure={configurar} />);
    fireEvent.click(await screen.findByRole("button", { name: /^(configurar el despliegue|set up the deploy)$/i }));
    expect(configurar).toHaveBeenCalled();
    expect(screen.queryByText(/^(aviso del ci|ci notice)$/i)).toBeNull();
    expect(screen.queryByText(/^(rama y build|branch and build)$/i)).toBeNull();
    expect(screen.queryByLabelText(/^(migraciones|migrations)$/i)).toBeNull();
    expect(screen.getByLabelText(/^(commit|sha)/i)).toBeTruthy();
  });
});

describe("el aviso del CI", () => {
  const KEY = "dk_0123456789abcdef0123456789abcdef";

  // Un servicio que construye en el servidor lo despliega el push: la llave
  // del `curl` no se ofrece. Mutante: ofrecerla igual.
  it("a un servicio que construye en el servidor no se le ofrece llave", async () => {
    respuestas([{ ...deployable, repoFullName: "dwit/api", buildOnHost: true }], []);
    pintar();
    await screen.findByText(/(sin llave del CI|no CI key needed)/i);
    expect(screen.queryByRole("button", { name: /^(generar llave|mint key)$/i })).toBeNull();
  });

  it("la llave se enseña una vez, con el paso para el workflow, y no se queda en el store", async () => {
    respuestas([deployable], []);
    post.mockResolvedValue({ success: true, data: { key: KEY, preview: "dk_012345…" } });
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /^(generar llave|mint key)$/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /^(generar otra|mint another)$/i }));
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
      { name: "app", environment: "prod", repoFullName: "", onCINotify: "deploy", buildWorkflow: "", shortTags: false, migrateCommand: "", rotateCommand: "", branch: "", buildOnHost: false, dockerfile: "", buildContext: "" },
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
        { name: "app", environment: "prod", repoFullName: "dwit/api", onCINotify: "deploy", buildWorkflow: "prod.yml", shortTags: false, migrateCommand: "", rotateCommand: "", branch: "", buildOnHost: false, dockerfile: "", buildContext: "" },
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

describe("sin ir a GitHub", () => {
  const KEY = "dk_0123456789abcdef0123456789abcdef";

  it("con el PAT, la llave se guarda sola en el repo deducido de la imagen y no se enseña", async () => {
    tauri({ pat: true });
    respuestas([deployable], []);
    post.mockResolvedValue({ success: true, data: { key: KEY, preview: "dk_012345…" } });
    patch.mockResolvedValue({ success: true, data: { ...deployable, repoFullName: "dwit-mexico/api" } });
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /^(generar llave|mint key)$/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_github_secret", {
        serverId: "PATK_global_usage", owner: "dwit-mexico", repo: "api", name: "CAC_DEPLOY_KEY", value: KEY,
      }),
    );
    await waitFor(() => expect(screen.getByText(/(guardada como el secret|saved as)/i)).toBeTruthy());
    expect(screen.queryByTestId("ci-key")).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
    // El repo deducido se queda puesto en el servicio.
    await waitFor(() => expect(patch.mock.calls[patch.mock.calls.length - 1]?.[1].repoFullName).toBe("dwit-mexico/api"));
  });

  it("si GitHub no la acepta, se enseña para copiarla a mano", async () => {
    tauri({ pat: true, pushFails: true });
    respuestas([deployable], []);
    post.mockResolvedValue({ success: true, data: { key: KEY, preview: "dk_012345…" } });
    pintar();
    fireEvent.click(await screen.findByRole("button", { name: /^(generar llave|mint key)$/i }));
    await waitFor(() => expect(screen.getByTestId("ci-key").textContent).toBe(KEY));
  });

  it("si el servicio corre con un tag corto, el paso del workflow manda el sha corto", async () => {
    respuestas([deployable], []);
    post.mockResolvedValue({ success: true, data: { key: KEY, preview: "dk_012345…" } });
    render(<DeployDialog server={server()} service={{ ...service, image: "ghcr.io/dwit-mexico/api:9c55939" }} open full onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^(generar llave|mint key)$/i }));
    const paso = (await screen.findByText(/X-Deploy-Key/)).textContent ?? "";
    expect(paso).toContain("git rev-parse --short=7 HEAD");
    expect(paso).not.toContain("$GITHUB_SHA");
  });

  it("un servicio que corre con tag corto se registra y se guarda diciéndolo", async () => {
    const corto = { ...service, image: "ghcr.io/dwit-mexico/api:9c55939" };
    respuestas([], []);
    post.mockResolvedValue({ success: true, data: deployable });
    render(<DeployDialog server={server()} service={corto} open full onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^(registrar|register)$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].shortTags).toBe(true);
    cleanup();

    respuestas([deployable], []);
    patch.mockResolvedValue({ success: true, data: { ...deployable, repoFullName: "dwit/api", shortTags: true } });
    render(<DeployDialog server={server()} service={corto} open full onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/(repo de github|github repo)/i), { target: { value: "dwit/api" } });
    fireEvent.click(screen.getByRole("button", { name: /^(guardar|save)$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].shortTags).toBe(true);
  });

  it("el comando de migración se guarda, y avisa si el agente no sabe correrlo", async () => {
    respuestas([deployable], []);
    patch.mockResolvedValue({ success: true, data: { ...deployable, migrateCommand: "npx prisma migrate deploy" } });
    pintar(server({ agentVersion: 3 }));
    const campo = await screen.findByLabelText(/^(migraciones|migrations)$/i);
    const guardar = screen.getByRole("button", { name: /(guardar comando|save command)/i }) as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);
    fireEvent.change(campo, { target: { value: " npx prisma migrate deploy " } });
    expect(screen.getByText(/(no sabe correr migraciones|can't run migrations)/i)).toBeTruthy();
    fireEvent.click(guardar);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].migrateCommand).toBe("npx prisma migrate deploy");
    expect(patch.mock.calls[0][1].onCINotify).toBe("record");
  });

  it("con un agente v4 no avisa", async () => {
    respuestas([{ ...deployable, migrateCommand: "migrate" }], []);
    pintar(server({ agentVersion: 4 }));
    await screen.findByLabelText(/^(migraciones|migrations)$/i);
    expect(screen.queryByText(/(no sabe correr migraciones|can't run migrations)/i)).toBeNull();
  });
});

// Hasta la v1.12.0 la lista la pedía la app con el token de GitHub de la
// máquina y de la rama por defecto: sin token no salía, y un servicio de `dev`
// enseñaba `main`. Mutantes: no elegir el más nuevo; no marcar el que corre;
// desplegar el sha entero teniendo tag publicado; desplegar el tag
// construyendo en el servidor; esconder el porqué cuando no hay lista.
describe("qué commit se despliega", () => {
  const c = (sha: string, message: string) => ({ sha: sha.padEnd(40, "0"), message, author: "ana", date: "2026-10-01T10:00:00Z" });
  const lista = { success: true, data: [c("def5678", "lo nuevo"), c("abc1234", "fix: login"), c("1111111", "lo viejo")] };
  const conRepo = { ...deployable, repoFullName: "dwit-mexico/api", branch: "dev" };
  const corriendo = { ...service, image: "ghcr.io/dwit-mexico/api:abc1234" };
  const elegir = () => within(screen.getByRole("group", { name: /(commits para desplegar|commits to deploy)/i }));

  it("salen los de la rama del backend, con el más nuevo desplegable elegido y marcado el que corre", async () => {
    respuestas([conRepo], [], [build("abc1234")], lista);
    // Terminado: con uno en cola el botón pasa a «Desplegando…» y no se pide otro.
    post.mockResolvedValue({ success: true, data: fila({ status: "succeeded" }) });
    render(<DeployDialog server={server()} service={corriendo} open full onOpenChange={() => {}} />);
    const opciones = await screen.findAllByRole("option");
    expect(get).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/commits", true);
    expect(invoke).not.toHaveBeenCalledWith("list_github_commits", expect.anything());
    expect(elegir().getByText(/(commits de dev|commits on dev)/i)).toBeTruthy();
    expect(elegir().getByText(/^1 (sin desplegar|not deployed)$/i)).toBeTruthy();
    // La imagen la publica el CI: por defecto, el más nuevo que ya la tiene
    // (abc1234). El de arriba (def5678) aún no tiene imagen: desplegarlo
    // pediría un tag que no existe, así que no va elegido.
    expect(opciones[1].getAttribute("aria-selected")).toBe("true");
    expect(opciones[0].getAttribute("aria-selected")).toBe("false");
    expect(opciones[1].textContent).toMatch(/(en el servidor|on the server)/i);
    expect(opciones[0].textContent).not.toMatch(/(en el servidor|on the server)/i);
    expect(opciones[1].textContent).toMatch(/(imagen publicada|image published)/i);

    // Uno sin imagen, si se elige a mano, va con su sha entero.
    fireEvent.click(opciones[0]);
    fireEvent.click(elegir().getByRole("button", { name: /(desplegar|deploy) def5678/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "def5678".padEnd(40, "0") }, true),
    );
    // Uno con imagen publicada, con el tag con el que se publicó. Es el que
    // corre, así que antes se confirma.
    post.mockClear();
    confirmar.mockResolvedValue(true);
    fireEvent.click(opciones[1]);
    fireEvent.click(elegir().getByRole("button", { name: /(desplegar|deploy) abc1234/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "abc1234" }, true),
    );
  });

  // La lista de una pantalla abierta desde antes de un merge tenía arriba lo
  // que ya corría, ya elegido, y se desplegó eso (19-oct-2026). Mutantes: no
  // refrescar al llegar un commit; el botón sin refrescar; desplegar lo que
  // corre sin preguntar; desplegarlo aunque se diga que no.
  it("un commit nuevo refresca la lista y queda elegido; y también el botón", async () => {
    respuestas([conRepo], [], [], lista);
    render(<DeployDialog server={server()} service={corriendo} open full onOpenChange={() => {}} />);
    await screen.findAllByRole("option");
    respuestas([conRepo], [], [], { success: true, data: [c("9999999", "el merge"), ...lista.data] });
    act(() => useDeploymentsStore.getState().onBuild(build("9999999")));
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toMatch(/el merge/));
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    expect(elegir().getByText(/^2 (sin desplegar|not deployed)$/i)).toBeTruthy();

    respuestas([conRepo], [], [], { success: true, data: [c("7777777", "otro push"), c("9999999", "el merge"), ...lista.data] });
    fireEvent.click(screen.getByRole("button", { name: /(actualizar la lista|refresh the list)/i }));
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toMatch(/otro push/));
  });

  // Rotura que detecta: el botón sigue apuntando a un commit que ya no está
  // en la lista (cambió la rama o se refrescó) y desplegaría ese.
  it("lo elegido a mano se suelta si deja de estar en la lista", async () => {
    respuestas([conRepo], [], [build("abc1234")], lista);
    render(<DeployDialog server={server()} service={corriendo} open full onOpenChange={() => {}} />);
    const opciones = await screen.findAllByRole("option");
    fireEvent.click(opciones[0]);
    expect(elegir().getByRole("button", { name: /(desplegar|deploy) def5678/i })).toBeTruthy();
    respuestas([conRepo], [], [build("abc1234")], { success: true, data: [c("7777777", "otra rama"), c("abc1234", "fix: login")] });
    act(() => useDeploymentsStore.getState().onBuild(build("7777777")));
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toMatch(/otra rama/));
    expect(elegir().queryByRole("button", { name: /(desplegar|deploy) def5678/i })).toBeNull();
    expect(elegir().getByRole("button", { name: /(desplegar|deploy) (abc1234|7777777)/i })).toBeTruthy();
  });

  it("desplegar lo que ya corre se pregunta, y si no, no se manda", async () => {
    respuestas([conRepo], [], [build("def5678")], lista);
    post.mockResolvedValue({ success: true, data: fila({ status: "succeeded" }) });
    render(
      <DeployDialog server={server()} service={{ ...service, image: "ghcr.io/dwit-mexico/api:def5678" }} open full onOpenChange={() => {}} />,
    );
    await screen.findAllByRole("option");
    confirmar.mockResolvedValue(false);
    fireEvent.click(elegir().getByRole("button", { name: /(desplegar|deploy) def5678/i }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();

    confirmar.mockResolvedValue(true);
    fireEvent.click(elegir().getByRole("button", { name: /(desplegar|deploy) def5678/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
  });

  it("construyendo en el servidor se despliega el commit entero, aunque haya imagen", async () => {
    respuestas([{ ...conRepo, buildOnHost: true }], [], [build("abc1234")], lista);
    post.mockResolvedValue({ success: true, data: fila({ status: "queued" }) });
    render(<DeployDialog server={server()} service={corriendo} open full onOpenChange={() => {}} />);
    const opciones = await screen.findAllByRole("option");
    expect(opciones[1].textContent).not.toMatch(/(imagen publicada|image published)/i);
    // Es el que corre: se pregunta, y se dice que sí.
    confirmar.mockResolvedValue(true);
    fireEvent.click(opciones[1]);
    fireEvent.click(elegir().getByRole("button", { name: /(desplegar|deploy) abc1234/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "abc1234".padEnd(40, "0") }, true),
    );
  });

  it("otro commit se escribe a mano, detrás de «Otro commit…»", async () => {
    respuestas([conRepo], [], [], lista);
    pintar();
    await screen.findAllByRole("option");
    expect(screen.queryByLabelText(/^(commit)$/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /(otro commit|another commit)/i }));
    fireEvent.change(screen.getByLabelText(/^(commit)$/i), { target: { value: "9999999" } });
    expect(botonDesplegar().disabled).toBe(false);
  });

  it("sin lista queda el campo, y dice por qué", async () => {
    respuestas([conRepo], [], [], { success: false, error: "github-off" });
    pintar();
    // El porqué, en tu idioma («GitHub App» también sale en el aviso del CI).
    expect(await screen.findByText(/(no se pudieron traer los commits|couldn't fetch the commits).*github app/i)).toBeTruthy();
    expect(screen.getByLabelText(/^(commit)$/i)).toBeTruthy();
    cleanup();
    get.mockClear();
    useDeploymentsStore.setState({ deployables: {}, commits: {} });

    respuestas([deployable], []);
    pintar();
    expect(await screen.findByText(/(para elegir de sus commits|to pick from its commits)/i)).toBeTruthy();
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("/commits"), true);
  });
});

// Hasta la v1.21.0 el log se abría solo debajo del historial, en una caja con
// scroll propio entre otras dos (commits e historial), y la rueda se quedaba
// atrapada en cada una. Ahora el log ocupa el sitio del historial, con un
// «atrás», y las listas enseñan cinco filas y «Ver N más» sin scroll propio.
// Roturas que atrapa: abrir el log solo al entrar; abrirlo debajo dejando el
// historial; no poder volver; enseñar todas las filas de golpe; no ofrecer
// las que faltan.
describe("el historial y su log", () => {
  const filas = Array.from({ length: 7 }, (_, i) =>
    fila({ id: `d-${i}`, image: `ghcr.io/dwit-mexico/api:aaaa00${i}`, finalImage: `ghcr.io/dwit-mexico/api:aaaa00${i}` }),
  );
  const historial = () => screen.queryByRole("list", { name: /^(historial|history)$/i });

  it("el log se abre en el sitio del historial, con un atrás, y sólo si se pide", async () => {
    respuestas([deployable], filas);
    get.mockImplementation(async (url: string) => {
      if (url.endsWith("/deployables")) return { success: true, data: [deployable] };
      if (url.endsWith("/deployments")) return { success: true, data: filas };
      if (url.endsWith("/deployments/d-2")) return { success: true, data: { ...filas[2], log: "#5 RUN bun run build\nERROR: falló" } };
      return { success: true, data: [] };
    });
    pintar();
    await waitFor(() => expect(historial()).toBeTruthy());
    expect(screen.queryByLabelText(/^log$/i)).toBeNull();

    fireEvent.click(within(historial()!).getAllByRole("button", { name: /^log$/i })[2]);
    await waitFor(() => expect(screen.getByLabelText(/^log$/i).textContent).toContain("ERROR: falló"));
    expect(historial()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^(historial|history)$/i }));
    expect(historial()).toBeTruthy();
    expect(screen.queryByLabelText(/^log$/i)).toBeNull();
  });

  it("enseña cinco y el resto con «Ver más», sin caja con scroll propio", async () => {
    respuestas([deployable], filas);
    pintar();
    await waitFor(() => expect(historial()).toBeTruthy());
    expect(within(historial()!).getAllByRole("listitem")).toHaveLength(5);
    expect(historial()!.className).not.toMatch(/overflow|max-h/);
    fireEvent.click(screen.getByRole("button", { name: /^(ver 2 más|show 2 more)$/i }));
    expect(within(historial()!).getAllByRole("listitem")).toHaveLength(7);
  });

  it("los commits también: cinco y el resto con «Ver más»", async () => {
    const c = (i: number) => ({ sha: `${i}`.repeat(7).padEnd(40, "0"), message: `commit ${i}`, author: "ana", date: "2026-10-01T10:00:00Z" });
    respuestas([{ ...deployable, repoFullName: "dwit-mexico/api", branch: "dev" }], [], [], {
      success: true, data: [1, 2, 3, 4, 5, 6, 7, 8].map(c),
    });
    pintar();
    const lista = await screen.findByRole("listbox");
    expect(within(lista).getAllByRole("option")).toHaveLength(5);
    expect(lista.className).not.toMatch(/overflow|max-h/);
    fireEvent.click(screen.getByRole("button", { name: /^(ver 3 más|show 3 more)$/i }));
    expect(within(lista).getAllByRole("option")).toHaveLength(8);
  });
});
