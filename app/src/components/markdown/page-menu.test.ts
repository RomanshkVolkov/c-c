import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";

import { PAGE_MENU_KEY, PageMenu, type DocLinkRef } from "@/components/markdown/page-menu";

/**
 * `[[`: escribir `[[Ner`, elegir «Nereus», y que quede un enlace de markdown
 * corriente — el que abre la página dentro de la app y el que la página cuenta
 * en «Referenciado desde». Con un editor de verdad: lo que se prueba es la
 * extensión de tiptap, y un editor de mentira diría que sí a todo.
 */

const PAGINAS: DocLinkRef[] = [
  { href: "/tasks?doc=list:l1&page=p1", title: "Nereus", where: "Apps" },
  { href: "/tasks?doc=list:l1&page=p2", title: "Owner View", where: "Apps" },
];

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const montar = (links: (q: string) => DocLinkRef[] | Promise<DocLinkRef[]>) => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [StarterKit, Link, Markdown, PageMenu.configure({ links })],
    content: "",
  });
  return editor;
};

const filtrar = (q: string) => PAGINAS.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
const esperar = () => new Promise((r) => setTimeout(r, 0));
const tecla = (e: Editor, key: string) =>
  e.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

describe("[[ enlaza una página", () => {
  it("elegir una deja un enlace de markdown a esa página", async () => {
    const e = montar(filtrar);
    e.commands.insertContent("ver [[Ner");
    await esperar();
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Nereus");
    tecla(e, "Enter");
    const md = (e.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
    // El `[[Ner` escrito se va entero; queda el enlace (y el espacio de después
    // para seguir escribiendo).
    expect(md.trim()).toBe("ver [Nereus](/tasks?doc=list:l1&page=p1)");
  });

  // Los títulos llevan espacios; la búsqueda no se corta en el primero.
  it("sigue buscando después de un espacio", async () => {
    const vistas: string[] = [];
    const e = montar((q) => {
      vistas.push(q);
      return filtrar(q);
    });
    e.commands.insertContent("[[Owner Vi");
    await esperar();
    expect(vistas[vistas.length - 1]).toBe("Owner Vi");
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Owner View");
  });

  it("con las flechas se elige otra", async () => {
    const e = montar(() => PAGINAS);
    e.commands.insertContent("[[");
    await esperar();
    tecla(e, "ArrowDown");
    tecla(e, "Enter");
    const md = (e.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
    expect(md).toContain("[Owner View](/tasks?doc=list:l1&page=p2)");
  });

  it("fuera de un bloque de código, el mismo texto sí lo abre", async () => {
    const e = montar(() => PAGINAS);
    e.commands.insertContent("x = [[0");
    await esperar();
    expect(PAGE_MENU_KEY.getState(e.state)?.active).toBe(true);
  });

  it("un solo [ no abre nada", async () => {
    const e = montar(() => PAGINAS);
    e.commands.insertContent("lista [1]");
    await esperar();
    expect(PAGE_MENU_KEY.getState(e.state)?.active).toBeFalsy();
  });

  it("dentro de un bloque de código, [[ es texto", async () => {
    const e = montar(() => PAGINAS);
    e.commands.setCodeBlock();
    // Tras un espacio, que es donde el menú sí se abriría fuera de un bloque
    // de código: `a[[0]]` no lo abre en ningún sitio y no probaría nada.
    e.commands.insertContent("x = [[0");
    await esperar();
    expect(PAGE_MENU_KEY.getState(e.state)?.active).toBeFalsy();
  });
});
