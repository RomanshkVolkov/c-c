import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un push cambió los .md de un repo (`repo-docs:changed`): se vuelve a pedir
 * lo de ese repo y nada más.
 * Mutantes: pedir aunque el espacio no estuviera cargado; recargar el
 * fichero abierto de otro repo; dejar los includes con lo de antes; borrar el
 * include mientras se recarga (parpadea a enlace).
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));

const { useRepoDocs } = await import("@/store/repo-docs.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const doc = (id: string, repoId: number, title: string) =>
  ({ id, repoId, title, orgId: "org-1", spaceId: "sp-1", path: `${id}.md`, fullName: "dwit/web", branch: "main" }) as never;
const URL_A = "https://github.com/dwit/web/blob/main/a.md";
const URL_OTHER = "https://github.com/dwit/otro/blob/main/x.md";

beforeEach(() => {
  get.mockReset();
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useRepoDocs.setState({
    bySpace: { "sp-1": [] },
    open: doc("rd-open", 200, "viejo"),
    byUrl: { [URL_A]: doc("rd-a", 200, "A viejo"), [URL_OTHER]: doc("rd-x", 300, "X") },
  });
});

describe("cuando cambian los .md de un repo", () => {
  it("se vuelve a pedir el espacio, el fichero abierto y sus includes", async () => {
    let releaseLookup: () => void = () => {};
    get.mockImplementation((url: string) => {
      if (url.startsWith("/api/v1/repo-docs?")) return Promise.resolve({ data: [{ repoId: 200, files: [] }] });
      if (url === "/api/v1/repo-docs/rd-open") return Promise.resolve({ data: doc("rd-open", 200, "nuevo") });
      if (url.startsWith("/api/v1/repo-docs/lookup?"))
        return new Promise((r) => (releaseLookup = () => r({ data: doc("rd-a", 200, "A nuevo") })));
      return Promise.reject(new Error("?"));
    });
    useRepoDocs.getState().refreshRepo("sp-1", 200);
    // Mientras llega, el include no se queda sin nada.
    expect(useRepoDocs.getState().byUrl[URL_A]).toBeTruthy();
    releaseLookup();
    await vi.waitFor(() => expect(useRepoDocs.getState().byUrl[URL_A] as unknown as { title: string }).toMatchObject({ title: "A nuevo" }));
    expect((useRepoDocs.getState().open as unknown as { title: string }).title).toBe("nuevo");
    expect(useRepoDocs.getState().bySpace["sp-1"]).toHaveLength(1);
    // El include de otro repo, ni se pide.
    expect(get.mock.calls.filter(([u]) => String(u).includes("otro"))).toHaveLength(0);
  });

  it("de otro repo, no toca el fichero abierto; un espacio sin cargar no se pide", () => {
    get.mockResolvedValue({ data: [] });
    useRepoDocs.getState().refreshRepo("sp-9", 999);
    expect(get).not.toHaveBeenCalled();
  });
});
