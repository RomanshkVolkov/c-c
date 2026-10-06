import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La CSP de la app de escritorio (barrido de seguridad, 6-oct-2026). Hasta la
 * v1.6.89 no tenía ninguna (`"csp": null`): un HTML que se colara en el webview
 * podía ejecutar lo que quisiera, leer la sesión y llamar a los comandos de
 * Rust (terminal, SSH, Ansible). Ahora sólo corre el código de la propia app.
 *
 * Esta prueba ata cada fuente permitida a lo que la usa: quitar una rompe esa
 * pantalla en silencio (la CSP no da error, sólo no carga), y añadir
 * `'unsafe-inline'` o `'unsafe-eval'` a los scripts la deja sin efecto.
 * Mutantes: cada una de las líneas de abajo.
 */
// Por `process.cwd()` y no `import.meta.url`: bajo jsdom no es una URL file:.
const conf = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));

function directivas(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, v]),
  );
}

for (const [nombre, csp] of [
  ["producción", conf.app.security.csp as string],
  ["desarrollo", conf.app.security.devCsp as string],
] as const) {
  describe(`la CSP del escritorio (${nombre})`, () => {
    const d = directivas(csp ?? "");

    it("existe, y sólo corre el código de la app", () => {
      expect(csp).toBeTruthy();
      expect(d.get("script-src")).toEqual(["'self'"]);
      expect(d.get("object-src")).toEqual(["'none'"]);
      expect(d.get("frame-src")).toEqual(["'none'"]);
    });

    it("deja hablar con Rust y con lo que sirve Rust", () => {
      const c = d.get("connect-src") ?? [];
      // Los comandos (`invoke`).
      expect(c).toEqual(expect.arrayContaining(["ipc:", "http://ipc.localhost"]));
      // Los adjuntos (lib/media.ts) y las tramas de vídeo (VideoLienzo.tsx); la
      // forma `http://…localhost` es la de Windows.
      expect(c).toEqual(expect.arrayContaining(["cacmedia:", "http://cacmedia.localhost", "cacvideo:", "http://cacvideo.localhost"]));
      expect(d.get("img-src")).toEqual(expect.arrayContaining(["cacmedia:", "http://cacmedia.localhost", "cacvideo:", "http://cacvideo.localhost"]));
      expect(d.get("media-src")).toEqual(expect.arrayContaining(["cacmedia:", "http://cacmedia.localhost"]));
    });

    it("deja lo que la app pide por su cuenta", () => {
      const c = d.get("connect-src") ?? [];
      // Las subidas (sendForm en lib/api.ts) van por fetch, no por Rust.
      expect(c).toContain("https://cac.guz-studio.dev");
      // El agente de cada servidor, por http a su IP (lib/agent.ts y el stream
      // de logs). Es lo que obliga a abrir `http:`: ver docs del barrido.
      expect(c).toContain("http:");
      // Pegar una imagen la lee de su blob o data: (MarkdownEditor.tsx).
      expect(c).toEqual(expect.arrayContaining(["blob:", "data:"]));
      // El worker de pdf.js (PdfPreview.tsx) y las grabaciones por el proxy.
      expect(d.get("worker-src")).toEqual(expect.arrayContaining(["'self'", "blob:"]));
      expect(d.get("media-src")).toContain("https:");
    });
  });
}

describe("la CSP de desarrollo", () => {
  it("añade el servidor de Vite y su recarga, y nada más se relaja", () => {
    const prod = directivas(conf.app.security.csp);
    const dev = directivas(conf.app.security.devCsp);
    expect(dev.get("connect-src")).toEqual(expect.arrayContaining(["ws://localhost:1420"]));
    for (const [k, v] of prod) {
      if (k !== "connect-src") expect(dev.get(k)).toEqual(v);
    }
  });
});
