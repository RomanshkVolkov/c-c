import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La AppImage lleva su propio GStreamer, plugins incluidos.
 *
 * Hasta la v1.6.96 llevaba sólo el núcleo (1.20, el de Ubuntu 22.04, donde se
 * compila) y buscaba los plugins en el sistema de quien la usa. En una distro
 * al día son de otra versión y no cargan; sin `autoaudiosink`, el proceso web
 * de WebKit aborta al darle play a un vídeo y la ventana entera se queda en
 * blanco (10-oct-2026). Las dos mitades hacen falta: la opción que los mete y
 * los paquetes de donde los copia.
 */
const raiz = join(process.cwd(), "..");
const conf = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
const release = readFileSync(join(raiz, ".github/workflows/app-release.yml"), "utf8");

describe("los vídeos en la AppImage", () => {
  it("la AppImage mete los plugins de GStreamer", () => {
    expect(conf.bundle.linux?.appimage?.bundleMediaFramework).toBe(true);
  });

  it("el build de Linux instala los plugins que la AppImage copia", () => {
    for (const paquete of [
      "gstreamer1.0-plugins-base", // reproducción básica
      "gstreamer1.0-plugins-good", // autoaudiosink, el mp4 (qtdemux)
      "gstreamer1.0-plugins-bad", // h264parse
      "gstreamer1.0-libav", // decodificar H.264 y AAC
      "gstreamer1.0-pulseaudio", // la salida de audio
    ]) {
      expect(release).toContain(paquete);
    }
  });
});
