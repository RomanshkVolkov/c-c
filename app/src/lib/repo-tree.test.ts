import { describe, expect, it } from "vitest";

import { buildRepoTree, repoDirKey, repoDocPath, repoKey } from "@/lib/repo-tree";

const f = (path: string, title = path) => ({ id: path, path, title });

/**
 * Los .md de un repo, por carpetas.
 * Mutantes: ordenar los ficheros sólo por título (el README deja de ir
 * primero); no aplanar; aplanar también la raíz.
 */
describe("el árbol de un repo", () => {
  it("en cada carpeta, primero las carpetas y el README antes que el resto", () => {
    const root = buildRepoTree([f("CHANGELOG.md", "Cambios"), f("README.md", "Web"), f("api/a.md", "A")]);
    expect(root.dirs.map((d) => d.name)).toEqual(["api"]);
    expect(root.files.map((x) => x.path)).toEqual(["README.md", "CHANGELOG.md"]);
  });

  it("una carpeta que sólo tiene otra se aplana; la raíz no", () => {
    const root = buildRepoTree([f("docs/guias/uno.md"), f("docs/guias/dos/tres.md")]);
    expect(root.path).toBe("");
    expect(root.dirs).toHaveLength(1);
    const guias = root.dirs[0];
    expect(guias.name).toBe("docs/guias");
    expect(guias.path).toBe("docs/guias");
    expect(guias.files.map((x) => x.path)).toEqual(["docs/guias/uno.md"]);
    // `dos` tiene un fichero: no se aplana con nada.
    expect(guias.dirs.map((d) => d.name)).toEqual(["dos"]);
  });

  it("lo abierto para leer un fichero: su repo y cada carpeta por encima", () => {
    expect(repoDocPath({ repoId: 7, path: "docs/guias/uno.md" })).toEqual([
      repoKey(7),
      repoDirKey(7, "docs"),
      repoDirKey(7, "docs/guias"),
    ]);
    expect(repoDocPath({ repoId: 7, path: "README.md" })).toEqual([repoKey(7)]);
  });
});
