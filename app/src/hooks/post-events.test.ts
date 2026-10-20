import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Los eventos del muro (#189) llegan a su store y se escuchan en la web. Sin
 * la rama, el muro abierto no vería lo que publican los demás hasta recargar;
 * sin el nombre en la lista del EventSource, la web no lo recibiría nunca. Se
 * lee el fuente, como las demás pruebas de este hook.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("los eventos del muro", () => {
  it("van al store del muro", () => {
    expect(fuente()).toMatch(
      /case "post:new":\s*case "post:updated":\s*case "post:comment":\s*case "post:reaction":\s*case "post:deleted":\s*void usePostsStore\.getState\(\)\.onEvent\(/,
    );
  });
  it("y se escuchan en la web", () => {
    expect(fuente()).toMatch(/"post:new",\s*"post:updated",\s*"post:comment",\s*"post:reaction",\s*"post:deleted",/);
  });
});
