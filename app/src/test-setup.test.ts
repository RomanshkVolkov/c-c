import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/**
 * Los huecos de jsdom que tapa `test-setup.ts`, comprobados.
 *
 * Éste en concreto tuvo la suite entera saliendo con código 1 durante días con
 * las 952 pruebas en verde: tiptap enfoca el editor dentro de un
 * `requestAnimationFrame`, mide dónde está el cursor con `Range.getClientRects`
 * —que jsdom no trae— y revienta **fuera de cualquier prueba**. vitest se lo
 * apunta al fichero que estuviera corriendo en ese momento, que pasa solo, y
 * por eso parecía de otro.
 *
 * Aquí se mide a propósito y de forma síncrona, así que sin el parche esto falla
 * con su nombre en vez de como un error huérfano.
 */

describe("el entorno de pruebas", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("deja que el editor mida una posición dentro del texto", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor = new Editor({ element: el, extensions: [StarterKit], content: "<p>hola</p>" });
    // 2 cae dentro de «hola», así que ProseMirror lo mide con un `Range` sobre
    // el nodo de texto: justo el camino que se rompía.
    expect(() => editor!.view.coordsAtPos(2)).not.toThrow();
  });
});
