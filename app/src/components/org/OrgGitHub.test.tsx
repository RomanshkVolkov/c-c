import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// Con router: la fila de cada repo lleva un enlace a su actividad (R9).
import { pick } from "@/test-pick";
import { MemoryRouter } from "react-router-dom";

/**
 * La pestaña GitHub de la org.
 *
 * Lo que se fija:
 * 1. Sin la App en el servidor, se dice, y no hay botón que no lleve a nada.
 * 2. Conectar abre en el navegador la URL que da el backend (con su `state`).
 * 3. Un repo se enlaza a un espacio de **esta** org con tareas: ni los de otra
 *    org ni la sala «general» se ofrecen.
 * 4. `#12` a secas no se puede encender en un repo sin enlazar.
 * 5. Quien no es admin lo ve, pero no lo cambia.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api }));
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
// Abrir fuera pasa por `lib/platform` (escritorio o navegador); aquí se mira
// que se pida, no cómo se abre.
vi.mock("@/lib/platform", () => ({ isTauri: false, isWeb: true, openExternal: openUrl }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const { default: OrgGitHub } = await import("./OrgGitHub");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useTasksStore } = await import("@/store/tasks.store");

const repo = (over: Record<string, unknown> = {}) => ({
  id: "r-1", installationId: 5, repoId: 100, fullName: "dwit/api", orgId: "org-1", spaceId: "", bareRefs: false, ...over,
});

const estado = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { configured: true, installations: [{ id: "i-1", installationId: 5, accountLogin: "dwit", orgId: "org-1" }], repos: [repo()], ...over },
});

beforeEach(() => {
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useTasksStore.setState({
    tree: [
      { id: "sp-1", orgId: "org-1", name: "Producto", color: "", folders: [], lists: [] },
      { id: "sp-g", orgId: "org-1", name: "General", color: "", kind: "general", folders: [], lists: [] },
      { id: "sp-x", orgId: "org-2", name: "Ajeno", color: "", folders: [], lists: [] },
    ],
  } as never);
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
  openUrl.mockReset();
});
afterEach(cleanup);

describe("la pestaña GitHub", () => {
  it("sin la App en el servidor lo dice, y no ofrece conectar", async () => {
    api.get.mockResolvedValue(estado({ configured: false }));
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/(no tiene la github app|doesn't have the github app)/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /(conectar|connect)/i })).toBeNull();
  });

  it("conectar abre en el navegador la URL del backend", async () => {
    api.get.mockResolvedValue(estado({ installations: [], repos: [] }));
    api.post.mockResolvedValue({ success: true, data: { url: "https://github.com/apps/cac/installations/new?state=s" } });
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^(conectar github|connect github)$/i }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://github.com/apps/cac/installations/new?state=s"));
    expect(api.post).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/link", {}, true);
  });

  it("un repo se enlaza sólo a un espacio de esta org con tareas", async () => {
    api.get.mockResolvedValue(estado());
    api.patch.mockResolvedValue({ success: true, data: repo({ spaceId: "sp-1" }) });
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);
    const select = await screen.findByLabelText(/dwit\/api/);
    fireEvent.click(select);
    const ofrecidos = (await screen.findAllByRole("option")).map((o) => o.textContent);
    // «Sin enlazar» y Producto: ni el general (sin tareas) ni el de otra org.
    expect(ofrecidos).toHaveLength(2);
    expect(ofrecidos[1]).toBe("Producto");
    fireEvent.keyDown(select, { key: "Escape" });

    // Sin enlazar, `#12` a secas no se enciende.
    expect((screen.getByRole("checkbox", { name: /bare #12/ }) as HTMLInputElement).disabled).toBe(true);

    await pick(select, "Producto");
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/repos/r-1", { spaceId: "sp-1", bareRefs: false }, true),
    );
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /bare #12/ }) as HTMLInputElement).disabled).toBe(false));
  });

  it("quien no es admin lo ve pero no lo cambia", async () => {
    api.get.mockResolvedValue(estado({ repos: [repo({ spaceId: "sp-1" })] }));
    render(<MemoryRouter><OrgGitHub canManage={false} /></MemoryRouter>);
    const select = await screen.findByLabelText(/dwit\/api/);
    expect(select.hasAttribute("disabled") || select.getAttribute("aria-disabled") === "true" || select.hasAttribute("data-disabled")).toBe(true);
    expect((screen.getByRole("checkbox", { name: /bare #12/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /(conectar|connect)/i })).toBeNull();
  });
});

/**
 * Los .md del repo en Documentación (docs as code): sólo con el repo atado,
 * se apagan con su casilla y se sincronizan a mano.
 * Mutantes: la casilla manda siempre `true`; el botón a otra ruta; enseñar
 * la casilla en un repo sin atar.
 */
describe("los docs de un repo", () => {
  it("sin atar no hay casilla de docs", async () => {
    api.get.mockResolvedValue(estado());
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);
    await screen.findByLabelText(/dwit\/api/);
    expect(screen.queryByRole("checkbox", { name: /Documentation/ })).toBeNull();
  });

  it("apagarlos lo manda, y «Sincronizar» pide la copia", async () => {
    const atado = repo({ spaceId: "sp-1", showDocs: true, docsSyncedAt: null, docsState: "" });
    api.get.mockResolvedValue(estado({ repos: [atado] }));
    api.patch.mockResolvedValue({ success: true, data: { ...atado, showDocs: false } });
    api.post.mockResolvedValue({ success: true, data: { ...atado, docsState: "ok", docsSyncedAt: "2026-10-13T10:00:00Z" } });
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: /Sync now/ }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/repos/r-1/docs/sync", {}, true),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Documentation/ }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/api/v1/organizations/org-1/github/repos/r-1",
        { spaceId: "sp-1", bareRefs: false, showDocs: false },
        true,
      ),
    );
  });
});

/**
 * Una cuenta de GitHub entera trae decenas de repos: se buscan por nombre, y
 * los atados a un espacio van primero.
 * Mutantes: el filtro sin efecto; sin ordenar los atados primero.
 */
describe("muchos repos", () => {
  it("se buscan por nombre, y los atados van primero", async () => {
    api.get.mockResolvedValue(
      estado({
        repos: [
          repo({ id: "r-a", fullName: "dwit/aaa" }),
          repo({ id: "r-z", fullName: "dwit/zzz", spaceId: "sp-1", showDocs: true }),
          repo({ id: "r-m", fullName: "dwit/mmm" }),
        ],
      }),
    );
    render(<MemoryRouter><OrgGitHub canManage /></MemoryRouter>);
    await screen.findByLabelText(/dwit\/aaa/);
    const names = () => [...document.querySelectorAll("li .font-mono")].map((n) => n.textContent);
    expect(names()).toEqual(["dwit/zzz", "dwit/aaa", "dwit/mmm"]);

    fireEvent.change(screen.getByRole("searchbox", { name: /Find a repository/ }), { target: { value: "MM" } });
    expect(names()).toEqual(["dwit/mmm"]);
    fireEvent.change(screen.getByRole("searchbox", { name: /Find a repository/ }), { target: { value: "nada" } });
    expect(screen.getByText(/No repository with that name/)).toBeTruthy();
  });
});
