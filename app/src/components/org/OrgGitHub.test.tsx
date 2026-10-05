import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// Con router: la fila de cada repo lleva un enlace a su actividad (R9).
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
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
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
    const select = (await screen.findByLabelText(/dwit\/api/)) as HTMLSelectElement;
    const ofrecidos = Array.from(select.options).map((o) => o.value);
    expect(ofrecidos).toEqual(["", "sp-1"]);

    // Sin enlazar, `#12` a secas no se enciende.
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: "sp-1" } });
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/repos/r-1", { spaceId: "sp-1", bareRefs: false }, true),
    );
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
  });

  it("quien no es admin lo ve pero no lo cambia", async () => {
    api.get.mockResolvedValue(estado({ repos: [repo({ spaceId: "sp-1" })] }));
    render(<MemoryRouter><OrgGitHub canManage={false} /></MemoryRouter>);
    const select = (await screen.findByLabelText(/dwit\/api/)) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /(conectar|connect)/i })).toBeNull();
  });
});
