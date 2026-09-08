import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Un aviso del sistema sale aunque la app tenga el foco.
 *
 * Había una puerta que decía «si la ventana está enfocada, no mandes nada al
 * escritorio». Suena razonable y no lo es: **tener el foco no es estar mirando
 * eso**. Con cac delante en la pantalla de servidores, un directo que llega es
 * justo lo que hay que anunciar.
 *
 * Y era peor de lo que parece. En un gestor de ventanas donde la app pasa mucho
 * tiempo enfocada, no salía **ni un aviso del sistema en todo el día** — se
 * comprobó en el historial de dunst: veintiún avisos del navegador y cero de
 * cac. Quien lo sufre no ve una regla, ve que la app no avisa.
 *
 * Quién decide sigue estando, y con más precisión: cada rama se salta el aviso
 * si estás mirando **ese** canal o **esa** conversación, y las menciones se
 * saltan incluso eso.
 */

const enviados: { title: string; body: string }[] = [];
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: (n: { title: string; body: string }) => {
    enviados.push(n);
  },
}));

/** La ventana enfocada: antes, esto bastaba para tragarse el aviso. */
const isFocused = vi.fn(async () => true);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused }),
}));

const fuente = () =>
  readFileSync(resolve(process.cwd(), "src/hooks/use-report-events.ts"), "utf8");

beforeEach(() => {
  enviados.length = 0;
});

describe("la puerta del foco", () => {
  /**
   * Se comprueba sobre el fuente porque el conmutador de eventos vive dentro de
   * un `useEffect` con un stream detrás, y montarlo entero para preguntar por
   * una línea traería media aplicación. Lo que hay que fijar es que la decisión
   * **no vuelva**: es una línea que suena sensata y que alguien reintroduciría.
   */
  it("no se le pregunta al foco antes de avisar", async () => {
    const s = fuente();
    expect(s).not.toMatch(/windowIsFocused/);
    expect(s).not.toMatch(/delivery:\s*"focused"/);
  });

  // Lo que sí decide, y es lo que hay que conservar: cada superficie se salta el
  // aviso si ya estás mirando esa cosa.
  it("pero sí a si estás mirando esa conversación", async () => {
    const s = fuente();
    expect(s).toMatch(/chat\.panelOpen && chat\.spaceId === p\.spaceId/);
    expect(s).toMatch(/dm\.conversationId === p\.conversationId/);
  });
});
