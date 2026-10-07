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

const dt = (uriList: string) => ({ getData: (t: string) => (t === "text/uri-list" ? uriList : "") }) as unknown as DataTransfer;

describe("un fichero soltado como dirección", () => {
  it("sólo cuenta las direcciones file://", () => {
    expect(fileURIs(dt("# comentario\r\nfile:///home/rv/a.png\r\nhttps://x/y.png\nfile:///tmp/b.pdf"))).toEqual([
      "file:///home/rv/a.png",
      "file:///tmp/b.pdf",
    ]);
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
