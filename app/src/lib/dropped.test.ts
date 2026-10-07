import { describe, expect, it, vi } from "vitest";

/**
 * Soltar un fichero desde Thunar llegaba como texto (`file:///…`) y se
 * escribía en el mensaje (jose, 6-oct-2026). Ahora se leen esas direcciones
 * —sólo las `file://`— y los bytes los da Rust; lo que Rust no sirve se salta.
 * Mutantes: aceptar direcciones que no son `file://`; perder el tipo; romper
 * todo por un fichero que no se puede leer.
 */
vi.mock("@/lib/platform", () => ({ isTauri: true }));
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, args: { uri: string }) => {
    if (args.uri.endsWith(".env")) throw new Error("type-not-allowed");
    return new TextEncoder().encode("bytes").buffer;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { fileURIs, readDropped, nameOf } = await import("./dropped");

const dt = (uriList: string, plain = "", html = "") =>
  ({
    getData: (t: string) => (t === "text/uri-list" ? uriList : t === "text/plain" ? plain : t === "text/html" ? html : ""),
  }) as unknown as DataTransfer;

describe("un fichero soltado como dirección", () => {
  it("sólo cuenta las direcciones file://", () => {
    expect(fileURIs(dt("# comentario\r\nfile:///home/rv/a.png\r\nhttps://x/y.png\nfile:///tmp/b.pdf"))).toEqual([
      "file:///home/rv/a.png",
      "file:///tmp/b.pdf",
    ]);
  });

  // Lo que entrega de verdad WebKitGTK al soltar desde Thunar: anuncia la
  // lista pero la deja vacía, y la ruta va en el HTML. Mutantes: no mirar el
  // HTML; tomar cualquier enlace del HTML; repetir la misma ruta.
  // Lo que llegó de verdad (jose, 6-oct-2026): la ruta es el **texto** de un
  // <a> sin href. Mutantes: no mirar el texto; tomar un texto que sólo
  // menciona una ruta.
  it("también cuando la ruta es el texto de un enlace sin href", () => {
    const real =
      '<a style="caret-color: rgb(255, 255, 255); color: rgb(255, 255, 255); font-style: normal;">file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png</a>';
    expect(fileURIs(dt("", "", real))).toEqual(["file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png"]);
    expect(fileURIs(dt("", "", "<p>mira file:///home/rv/a.png</p>"))).toEqual([]);
  });

  it("con la lista vacía, la saca del HTML del arrastre", () => {
    const html = '<a href="file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png"><img src="file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png"></a><a href="https://x.com">x</a>';
    expect(fileURIs(dt("", "", html))).toEqual(["file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png"]);
    expect(fileURIs(dt("", "", '<a href="https://x.com">x</a>'))).toEqual([]);
  });

  // WebKitGTK no siempre entrega `text/uri-list`: la dirección llega como
  // texto plano. Pero un texto que sólo menciona una dirección no es un
  // fichero. Mutantes: no mirar el texto plano; tomar cualquier texto.
  it("sin lista, la saca del texto plano si todo son direcciones file://", () => {
    expect(fileURIs(dt("", "file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png\n"))).toEqual([
      "file:///home/rv/Pictures/dwit/marca/dwit-isotipo.png",
    ]);
    expect(fileURIs(dt("", "mira file:///home/rv/a.png"))).toEqual([]);
    expect(fileURIs(dt("", "file:///a.png\nhola"))).toEqual([]);
  });

  it("lee cada una con su nombre y su tipo, y salta la que no se sirve", async () => {
    const files = await readDropped(["file:///home/rv/mi%20logo.png", "file:///home/rv/.env", "file:///tmp/b.pdf"]);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["mi logo.png", "image/png"],
      ["b.pdf", "application/pdf"],
    ]);
    expect(invoke).toHaveBeenCalledWith("read_dropped_file", { uri: "file:///home/rv/mi%20logo.png" });
    expect(nameOf("file:///x/%E2%9C%93.pdf")).toBe("✓.pdf");
  });
});


// WebKit sólo entrega el `drop` si la página dice «copiar» durante el
// arrastre; si no, escribe la ruta. Con texto no se toca nada. Mutantes: no
// fijar dropEffect; aceptar también un texto; olvidar la lista de direcciones.
describe("aceptar un arrastre", () => {
  const arrastre = (...types: string[]) => {
    const dataTransfer = { types, dropEffect: "none" };
    const ev = { dataTransfer, preventDefault: vi.fn() } as unknown as DragEvent;
    return { ev, dataTransfer };
  };

  it("con ficheros o direcciones, lo acepta como copia", async () => {
    const { acceptFileDrag } = await import("./dropped");
    for (const types of [["Files"], ["text/uri-list", "text/plain"]]) {
      const { ev, dataTransfer } = arrastre(...types);
      expect(acceptFileDrag(ev)).toBe(true);
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(dataTransfer.dropEffect).toBe("copy");
    }
  });

  it("con texto, no toca nada", async () => {
    const { acceptFileDrag } = await import("./dropped");
    const { ev, dataTransfer } = arrastre("text/plain", "text/html");
    expect(acceptFileDrag(ev)).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("none");
  });
});

// Soltar un fichero donde nadie lo recoge abría la imagen en la ventana y
// había que volver atrás (jose, 7-oct-2026). Mutantes: no cancelar el drop;
// cancelar también lo que ya recogió una zona; tocar un arrastre de texto.
describe("un fichero soltado fuera de una zona", () => {
  const evento = (type: string, types: string[], prevented = false) => {
    const ev = new Event(type, { cancelable: true, bubbles: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: { types, dropEffect: "copy" } });
    if (prevented) ev.preventDefault();
    return ev;
  };

  it("no se abre en la ventana, y el cursor dice que ahí no", async () => {
    const { guardWindowAgainstFileDrops } = await import("./dropped");
    const quitar = guardWindowAgainstFileDrops(window);
    const drop = evento("drop", ["Files"]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    const over = evento("dragover", ["Files"]);
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe("none");
    quitar();
  });

  it("lo que recogió una zona, y un texto, no se tocan", async () => {
    const { guardWindowAgainstFileDrops } = await import("./dropped");
    const quitar = guardWindowAgainstFileDrops(window);
    const recogido = evento("dragover", ["Files"], true);
    window.dispatchEvent(recogido);
    expect(recogido.dataTransfer!.dropEffect).toBe("copy");
    const texto = evento("drop", ["text/plain"]);
    window.dispatchEvent(texto);
    expect(texto.defaultPrevented).toBe(false);
    quitar();
  });
});

// Y la app la pone al arrancar: sin esto, la guarda existe y no protege nada.
describe("la guarda está puesta", () => {
  it("main.tsx la instala", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const main = readFileSync(join(process.cwd(), "src/main.tsx"), "utf8");
    expect(main).toMatch(/^guardWindowAgainstFileDrops\(\);$/m);
  });
});

