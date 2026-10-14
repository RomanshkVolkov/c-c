import { describe, expect, it } from "vitest";

import { matchRepoBlobUrl, repoImageSrc, resolveRepoHref, resolveRepoPath } from "@/lib/repo-links";

const DOC = { path: "docs/x/b.md", fullName: "dwit/web", branch: "main", repoId: 200 };
const IDS = { "docs/a.md": "rd-a", "README.md": "rd-readme" };

/**
 * Los enlaces de un .md del repo, resueltos contra su ruta.
 * Mutantes: resolver contra la raíz y no contra la carpeta del fichero; dejar
 * que `..` se salga del repo; tirar el ancla; reconocer cualquier host como
 * GitHub; aceptar un fichero que no es markdown.
 */
describe("un enlace de un .md del repo", () => {
  it("una ruta relativa sube desde su carpeta, y no se sale del repo", () => {
    expect(resolveRepoPath("docs/x/b.md", "../a.md")).toBe("docs/a.md");
    expect(resolveRepoPath("docs/x/b.md", "./c/d.md")).toBe("docs/x/c/d.md");
    expect(resolveRepoPath("docs/x/b.md", "/README.md")).toBe("README.md");
    expect(resolveRepoPath("docs/x/b.md", "../../../fuera.md")).toBeNull();
  });

  it("a otro .md copiado se queda en cac, con su ancla", () => {
    expect(resolveRepoHref(DOC, "../a.md#pasos", IDS)).toEqual({ kind: "repoDoc", id: "rd-a", hash: "pasos" });
    expect(resolveRepoHref(DOC, "/README.md", IDS)).toEqual({ kind: "repoDoc", id: "rd-readme", hash: "" });
  });

  it("lo que no está copiado va a su página en GitHub; un ancla, al mismo fichero", () => {
    expect(resolveRepoHref(DOC, "../../src/main.go", IDS)).toEqual({
      kind: "external",
      url: "https://github.com/dwit/web/blob/main/src/main.go",
    });
    expect(resolveRepoHref(DOC, "#arriba", IDS)).toEqual({ kind: "anchor", hash: "arriba" });
    expect(resolveRepoHref(DOC, "https://example.com/a.md", IDS)).toEqual({
      kind: "external",
      url: "https://example.com/a.md",
    });
  });

  it("una imagen relativa se pide a cac; una insignia de fuera, no", () => {
    expect(repoImageSrc(DOC, "../img/arq.png")).toBe("/api/v1/repo-docs/raw/200?path=docs%2Fimg%2Farq.png");
    expect(repoImageSrc(DOC, "https://img.shields.io/badge/x.svg")).toBe("https://img.shields.io/badge/x.svg");
    expect(repoImageSrc(DOC, "../../../x.png")).toBeNull();
  });
});

describe("una URL de GitHub de un .md", () => {
  it("da su repo y su ruta", () => {
    expect(matchRepoBlobUrl("https://github.com/dwit/web/blob/main/docs/guia%20uno.md")).toEqual({
      repo: "dwit/web",
      path: "docs/guia uno.md",
    });
  });

  it("sólo de github.com, sólo un blob y sólo markdown", () => {
    expect(matchRepoBlobUrl("https://gitlab.com/dwit/web/blob/main/a.md")).toBeNull();
    expect(matchRepoBlobUrl("https://github.com/dwit/web/tree/main/docs")).toBeNull();
    expect(matchRepoBlobUrl("https://github.com/dwit/web/blob/main/src/main.go")).toBeNull();
    expect(matchRepoBlobUrl("no es una url")).toBeNull();
  });
});
