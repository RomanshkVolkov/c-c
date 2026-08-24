import { describe, expect, it } from "vitest";
import type { SpaceTree } from "@/types/task";
import { listasDelArbol, rutaDeLista } from "@/lib/bandeja";

/**
 * Traducir el uuid de una bandeja a algo que se pueda leer.
 *
 * La rama que importa es la segunda: una lista puede colgar del espacio o de una
 * carpeta, y quedarse en la primera hace que media organización parezca no
 * existir — que es exactamente lo que hay que evitar cuando lo que se está
 * enseñando es «dónde caen los reportes de este cliente».
 */

const ARBOL = [
  {
    id: "esp-1",
    orgId: "org-1",
    name: "Boaty",
    color: "#0ff",
    lists: [{ id: "li-suelta", name: "Backlog" }],
    folders: [{ id: "car-1", name: "web", lists: [{ id: "li-honda", name: "Tasks" }] }],
    people: [],
  },
  {
    id: "esp-2",
    orgId: "org-1",
    name: "Reportes",
    color: "#f0f",
    lists: [{ id: "li-otra", name: "boaty" }],
    folders: [],
    people: [],
  },
] as unknown as SpaceTree[];

describe("la ruta de una lista", () => {
  it("encuentra la que cuelga del espacio", () => {
    expect(rutaDeLista(ARBOL, "li-suelta")).toBe("Boaty · Backlog");
  });

  // La que se olvidaba: una lista dentro de una carpeta.
  it("encuentra la que cuelga de una carpeta, y dice la carpeta", () => {
    expect(rutaDeLista(ARBOL, "li-honda")).toBe("Boaty · web · Tasks");
  });

  // Dos clientes con una lista «boaty» son indistinguibles sin el espacio, y
  // elegir la del cliente equivocado es enseñarle su trabajo a otro.
  it("lleva el espacio delante, que es lo que las distingue", () => {
    expect(rutaDeLista(ARBOL, "li-otra")).toBe("Reportes · boaty");
  });

  // `null` no es «no hay bandeja»: es «hay una y no es de aquí». Quien llame
  // decide cómo contarlo; lo que no puede es pintar el uuid.
  it("no se inventa nada para una que no está en el árbol", () => {
    expect(rutaDeLista(ARBOL, "li-ajena")).toBeNull();
    expect(rutaDeLista(ARBOL, undefined)).toBeNull();
  });
});

describe("acotar a una organización", () => {
  // Un árbol con dos organizaciones dentro es el estado normal de esta pantalla:
  // el que quedó cargado puede no ser el de la organización que se está mirando.
  const MEZCLADO = [
    ...ARBOL,
    {
      id: "esp-9",
      orgId: "org-2",
      name: "Otro cliente",
      color: "#000",
      lists: [{ id: "li-ajena", name: "Bugs" }],
      folders: [],
      people: [],
    },
  ] as unknown as SpaceTree[];

  it("sin organización, salen todas", () => {
    expect(listasDelArbol(MEZCLADO)).toHaveLength(4);
  });

  // Ofrecer la lista de otra organización como bandeja es enseñarle el trabajo
  // de un cliente a quien no tiene nada que ver. El servidor lo rechaza, pero
  // llegar a que lo rechace ya es un fallo de la pantalla.
  it("con organización, la de fuera no está", () => {
    const ids = listasDelArbol(MEZCLADO, "org-1").map((l) => l.id);
    expect(ids).not.toContain("li-ajena");
    expect(ids).toHaveLength(3);
  });

  it("y si el árbol entero es de otra, no queda ninguna", () => {
    expect(listasDelArbol(MEZCLADO, "org-3")).toEqual([]);
  });
});

describe("las listas del árbol", () => {
  it("están todas, las anidadas también", () => {
    expect(listasDelArbol(ARBOL).map((l) => l.id)).toEqual([
      "li-suelta",
      "li-honda",
      "li-otra",
    ]);
  });

  it("cada una con su ruta, no con su nombre suelto", () => {
    expect(listasDelArbol(ARBOL).find((l) => l.id === "li-honda")?.ruta).toBe(
      "Boaty · web · Tasks",
    );
  });
});
