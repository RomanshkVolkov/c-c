import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * La página de Actividad (R9).
 *
 * Lo que se fija: la insignia de un run dice su conclusión cuando terminó y
 * su estado cuando no; el filtro de la URL llega a la petición; un run abre
 * su enlace **sólo** si es de GitHub; el deploy que disparó un run se pinta
 * colgado de él; y la fila que pide el enlace (`?run=`) se resalta, o se dice
 * que no está en la página.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
// Abrir fuera pasa por `lib/platform` (escritorio o navegador); aquí se mira
// que se pida, no cómo se abre.
vi.mock("@/lib/platform", () => ({ isTauri: false, isWeb: true, isWebBuild: false, openExternal: openUrl }));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: "org-1" }),
}));

const { default: Activity } = await import("@/pages/Activity");
const { useActivityStore } = await import("@/store/activity.store");

const run = (over: Record<string, unknown> = {}) => ({
  id: "r-1", orgId: "org-1", repoId: 100, repoFullName: "dwit/api", runId: 9, runAttempt: 1, runNumber: 41,
  workflowName: "Deploy", path: ".github/workflows/prod.yml", event: "push", status: "completed", conclusion: "failure",
  headSha: "abc1234def", headBranch: "main", commitTitle: "fix: el login", actor: "ana",
  htmlUrl: "https://github.com/dwit/api/actions/runs/9", occurredAt: "2026-10-04T10:00:00Z",
  ...over,
});
const dep = (over: Record<string, unknown> = {}) => ({
  id: "d-1", orgId: "org-1", createdAt: "2026-10-04T10:05:00Z", deployableId: "dp-1", serverId: "srv-1",
  image: "ghcr.io/dwit/api:abc1234", finalImage: "", previousImage: "", requestedBy: "github", requestedByUserId: "",
  status: "succeeded", error: "", rollbackOfId: "", deployableName: "api", deployableEnv: "prod", workflowRunId: "r-1",
  ...over,
});

function feed(items: unknown[], hasMore = false) {
  get.mockResolvedValue({ success: true, data: { items, hasMore } });
}

const mount = (url = "/activity") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Activity />
    </MemoryRouter>,
  );

beforeEach(() => {
  useActivityStore.setState({ orgId: null, filter: {}, entries: [], hasMore: false, loading: false, error: null });
  get.mockReset();
  openUrl.mockReset();
});
afterEach(cleanup);

describe("la actividad", () => {
  it("un run terminado dice cómo acabó; uno en curso, cómo va", async () => {
    feed([
      { kind: "run", at: "2026-10-04T10:00:00Z", run: run() },
      { kind: "run", at: "2026-10-04T09:00:00Z", run: run({ id: "r-0", runId: 8, status: "in_progress", conclusion: "", commitTitle: "chore" }) },
    ]);
    mount();
    expect(await screen.findByText(/^(failed|falló)$/i)).toBeTruthy();
    expect(screen.getByText(/^(running|en curso)$/i)).toBeTruthy();
    expect(screen.getAllByText("dwit/api").length).toBe(2);
    expect(screen.getByText("fix: el login")).toBeTruthy();
  });

  it("el filtro de la URL llega a la petición, y se puede quitar", async () => {
    feed([]);
    mount("/activity?repo=dwit%2Fapi");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(String(get.mock.calls[0][0])).toContain("repo=dwit%2Fapi");
    expect(await screen.findByText(/dwit\/api/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /(clear filter|quitar el filtro)/i }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(String(get.mock.calls[1][0])).not.toContain("repo=");
  });

  it("abre el run en GitHub sólo si el enlace es de GitHub", async () => {
    feed([
      { kind: "run", at: "2026-10-04T10:00:00Z", run: run() },
      { kind: "run", at: "2026-10-04T09:00:00Z", run: run({ id: "r-x", runId: 7, htmlUrl: "https://evil.example/" }) },
    ]);
    mount();
    const buttons = await screen.findAllByRole("button", { name: /(open the run on github|abrir la ejecución en github)/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/dwit/api/actions/runs/9");
  });

  it("el deploy que disparó un run cuelga de él, con su estado", async () => {
    feed([{ kind: "run", at: "2026-10-04T10:00:00Z", run: run({ conclusion: "success" }), deployments: [dep()] }]);
    mount();
    const chip = await screen.findByText(/→ api · prod/);
    expect(chip.closest("a")?.getAttribute("href")).toBe("/servers/srv-1/services");
    expect(screen.getByText(/^(deployed|desplegado)$/i)).toBeTruthy();
  });

  it("la fila que pide el enlace se resalta; si no está, se dice", async () => {
    feed([{ kind: "run", at: "2026-10-04T10:00:00Z", run: run() }]);
    mount("/activity?run=r-1");
    const row = (await screen.findByText("Deploy")).closest("li")!;
    expect(row.className).toContain("ring-2");
    expect(screen.queryByText(/(older than what is loaded|más antigua que lo cargado)/i)).toBeNull();
    cleanup();
    mount("/activity?run=no-esta");
    expect(await screen.findByText(/(older than what is loaded|más antigua que lo cargado)/i)).toBeTruthy();
  });

  it("«cargar más» pide la siguiente página", async () => {
    feed([{ kind: "deployment", at: "2026-10-04T10:05:00Z", deployment: dep() }], true);
    mount();
    const more = await screen.findByRole("button", { name: /(load more|cargar más)/i });
    feed([], false);
    fireEvent.click(more);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(String(get.mock.calls[1][0])).toContain("beforeId=d-1");
  });
});

// Tres intentos del mismo run, una fila: la del último, con los anteriores
// debajo. Y un enlace al intento 2 resalta esa fila. Mutantes: tres filas;
// no enseñar los anteriores; no resaltar por un intento antiguo.
describe("los intentos de un run", () => {
  it("salen en una fila, con los anteriores debajo", async () => {
    feed([
      { kind: "run", at: "2026-10-07T20:53:50Z", run: run({ id: "a3", runId: 77, runAttempt: 3, conclusion: "success" }) },
      { kind: "run", at: "2026-10-07T20:48:07Z", run: run({ id: "a2", runId: 77, runAttempt: 2, conclusion: "failure" }) },
      { kind: "run", at: "2026-10-07T20:38:47Z", run: run({ id: "a1", runId: 77, runAttempt: 1, conclusion: "success" }) },
    ]);
    const { container } = mount("/activity?run=a2");
    await screen.findByText(/(intento 3|attempt 3)/i);
    expect(container.querySelectorAll("ul > li").length).toBe(1);
    const anteriores = container.querySelector("[data-earlier-attempts]");
    expect(anteriores?.textContent).toMatch(/(intento 1|attempt 1)/i);
    expect(anteriores?.textContent).toMatch(/(intento 2|attempt 2)/i);
    expect(container.querySelector("li.ring-2")).toBeTruthy();
  });
});
