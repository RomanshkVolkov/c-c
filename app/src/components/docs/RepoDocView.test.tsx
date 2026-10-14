import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un .md del repo, leído en cac: de sólo lectura y diciéndolo.
 * Mutantes: «Ver en GitHub» a otra URL; pintarlo con el editor (habría un
 * cuadro de texto); no cerrar el fichero al salir (el panel lo seguiría
 * marcando); pintar el cuerpo de uno demasiado grande.
 */

const { get, openExternal } = vi.hoisted(() => ({ get: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<object>()), openExternal }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));

const { default: RepoDocView } = await import("@/components/docs/RepoDocView");
const { useRepoDocs } = await import("@/store/repo-docs.store");

const DOC = {
  id: "rd-1",
  orgId: "org-1",
  repoId: 200,
  path: "docs/deploy.md",
  title: "Desplegar",
  body: "# Desplegar\n\nCon `make deploy`.",
  tooLarge: false,
  fullName: "dwit/web",
  branch: "main",
  spaceId: "sp-1",
  htmlUrl: "https://github.com/dwit/web/blob/main/docs/deploy.md",
  syncedAt: "2026-10-13T10:00:00Z",
};

beforeEach(() => {
  openExternal.mockResolvedValue(undefined);
  useRepoDocs.setState({ bySpace: {}, open: null });
});
afterEach(cleanup);

describe("un .md del repo", () => {
  it("se lee, sin editor, y «Ver en GitHub» lleva a su fichero", async () => {
    get.mockResolvedValue({ success: true, data: DOC });
    render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(screen.getByText("make deploy")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/api/v1/repo-docs/rd-1");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("[contenteditable]")).toBeNull();
    expect(screen.getByText("main")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /View on GitHub/ }));
    expect(openExternal).toHaveBeenCalledWith(DOC.htmlUrl);
  });

  it("al salir, el fichero deja de estar abierto", async () => {
    get.mockResolvedValue({ success: true, data: DOC });
    const { unmount } = render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(useRepoDocs.getState().open?.id).toBe("rd-1"));
    unmount();
    expect(useRepoDocs.getState().open).toBeNull();
  });

  it("uno demasiado grande no se pinta: se manda a GitHub", async () => {
    get.mockResolvedValue({ success: true, data: { ...DOC, tooLarge: true, body: "" } });
    render(<RepoDocView id="rd-1" />);
    await waitFor(() => expect(screen.getByText(/too large to show here/)).toBeTruthy());
  });

  it("uno que ya no está lo dice", async () => {
    get.mockRejectedValue(new Error("not-found"));
    render(<RepoDocView id="rd-x" />);
    await waitFor(() => expect(screen.getByText(/no longer in the repository/)).toBeTruthy());
  });
});
