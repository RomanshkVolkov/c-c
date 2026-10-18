import { describe, expect, it } from "vitest";
import { statusTone } from "@/lib/status-color";

describe("el color de un estado", () => {
  it("cada uno de los cuatro tiene el suyo", () => {
    const dots = ["open", "in_progress", "done", "closed"].map((s) => statusTone(s).dot);
    expect(dots).toEqual(["bg-status-open", "bg-status-progress", "bg-status-done", "bg-status-closed"]);
  });

  /** Las columnas del servidor dicen `pending` y `resolved`, no `open` y `done`. */
  it("con los nombres viejos, el mismo color", () => {
    expect(statusTone("pending")).toEqual(statusTone("open"));
    expect(statusTone("resolved")).toEqual(statusTone("done"));
  });

  it("uno desconocido, o ninguno, sale gris y no con el color de otro", () => {
    expect(statusTone("archivada").dot).toBe("bg-muted-foreground");
    expect(statusTone(undefined).dot).toBe("bg-muted-foreground");
  });

  it("el chip y el filo son del mismo tono que el punto", () => {
    for (const s of ["open", "in_progress", "done", "closed"]) {
      const tone = statusTone(s);
      const name = tone.dot.replace("bg-", "");
      expect(tone.chip).toBe(`bg-${name}/15 text-${name}`);
      expect(tone.edge).toBe(`border-t-${name}`);
      expect(tone.text).toBe(`text-${name}`);
    }
  });
});
