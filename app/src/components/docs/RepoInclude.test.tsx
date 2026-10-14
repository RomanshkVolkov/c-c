import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * El «include» de Confluence, y abrir en cac la URL de GitHub de un .md.
 *
 * Lo que se fija:
 * - la URL sola en su párrafo, en un documento, se pinta con el contenido del
 *   .md; en mitad de una frase, o fuera de la documentación, sigue siendo un
 *   enlace;
 * - si no es de un repo de la org, también: un enlace, nunca una tarjeta rota;
 * - `openInternalRef` reclama esas URLs y las abre en cac, o en GitHub si no
 *   están copiadas;
 * - lo que se pide desde fuera del router lo navega `RepoDocNavigator`.
 *
 * Mutantes: `loneLink` sin mirar que el enlace vaya solo; includes encendidos
 * por defecto (saldrían en el chat); la tarjeta aunque no se encuentre; no
 * reclamar la URL en `openInternalRef`; el navegador sin navegar.
 */

const { get, openExternal } = vi.hoisted(() => ({ get: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<object>()), openExternal }));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { default: Markdown } = await import("@/components/markdown/Markdown");
const { default: RepoDocNavigator } = await import("@/components/docs/RepoDocNavigator");
const { openInternalRef } = await import("@/lib/open-ref");
const { useRepoDocs } = await import("@/store/repo-docs.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const URL_MD = "https://github.com/dwit/web/blob/main/docs/deploy.md";
const DOC = {
  id: "rd-1",
  orgId: "org-1",
  repoId: 200,
  path: "docs/deploy.md",
  title: "Desplegar",
  body: "Con `make deploy` y nada más.",
  tooLarge: false,
  fullName: "dwit/web",
  branch: "main",
  spaceId: "sp-1",
  htmlUrl: URL_MD,
  syncedAt: null,
};

beforeEach(() => {
  get.mockReset();
  openExternal.mockReset().mockResolvedValue(undefined);
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useRepoDocs.setState({ bySpace: {}, open: null, byUrl: {}, pendingRoute: null });
  get.mockImplementation(async (url: string) =>
    url.startsWith("/api/v1/repo-docs/lookup?") && url.includes("path=docs%2Fdeploy.md")
      ? { success: true, data: DOC }
      : url.startsWith("/api/v1/repo-docs?")
        ? { success: true, data: [] }
        : Promise.reject(new Error("not-found")),
  );
});
afterEach(cleanup);

describe("el include de un .md del repo", () => {
  it("la URL sola en su párrafo se ve con su contenido", async () => {
    render(<Markdown includes>{`Antes.\n\n${URL_MD}\n\nDespués.`}</Markdown>);
    await waitFor(() => expect(screen.getByText("make deploy")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Desplegar" })).toBeTruthy();
    const q = get.mock.calls.map(([u]) => u).find((u: string) => u.startsWith("/api/v1/repo-docs/lookup?"));
    expect(q).toContain("orgId=org-1");
    expect(q).toContain("repo=dwit%2Fweb");
  });

  it("en mitad de una frase es un enlace, y fuera de la documentación también", async () => {
    render(<Markdown includes>{`Mira ${URL_MD} antes de desplegar.`}</Markdown>);
    render(<Markdown>{URL_MD}</Markdown>);
    await act(async () => {});
    expect(document.querySelector("[data-repo-include]")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("si no es de un repo de la org, se queda el enlace", async () => {
    const otro = "https://github.com/ajeno/x/blob/main/README.md";
    render(<Markdown includes>{otro}</Markdown>);
    await waitFor(() => expect(useRepoDocs.getState().byUrl[otro]).toBeNull());
    expect(document.querySelector("[data-repo-include]")).toBeNull();
    expect(screen.getByRole("link", { name: otro })).toBeTruthy();
  });
});

let where = "";
function Where() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}

describe("abrir en cac la URL de GitHub de un .md", () => {
  it("openInternalRef la reclama, y el navegador la lleva a /docs", async () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <RepoDocNavigator />
        <Where />
      </MemoryRouter>,
    );
    expect(openInternalRef(URL_MD)).toBe(true);
    await waitFor(() => expect(where).toBe("/docs?repoDoc=rd-1"));
    expect(useRepoDocs.getState().pendingRoute).toBeNull();
  });

  it("una que no está copiada se abre en GitHub", async () => {
    const otro = "https://github.com/dwit/web/blob/main/nada.md";
    expect(openInternalRef(otro)).toBe(true);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(otro));
  });
});
