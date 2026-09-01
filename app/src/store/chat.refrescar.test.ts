import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Refrescar un canal **no** es abrirlo.
 *
 * `fetch` vacía la lista, y eso es correcto al cambiar de canal: las líneas del
 * anterior no pueden quedarse bajo el nombre del nuevo. El problema era que lo
 * llamaba todo lo demás —enviar, editar, borrar, un mensaje que llega, volver a
 * la ventana— y ahí vaciar es destructivo.
 *
 * Lo que se perdía en cada mensaje ajeno: todas las páginas viejas que alguien
 * había cargado subiendo, y el sitio donde estaba leyendo. En un canal con
 * movimiento, leer historia era imposible.
 */

type Msg = {
  id: string;
  createdAt: string;
  body: string;
  spaceId: string;
  authorUserId: string;
  authorName: string;
  updatedAt: string;
};

let page: Msg[] = [];
const get = vi.fn(async () => ({ success: true, data: page }));

vi.mock("@/lib/api", () => ({
  api: {
    get: () => get(),
    post: vi.fn(async () => ({ success: true, data: {} })),
    patch: vi.fn(async () => ({ success: true, data: {} })),
    delete: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ session: { id: "yo" } }), subscribe: vi.fn() },
}));

const msg = (id: string, createdAt: string): Msg => ({
  id,
  createdAt,
  body: id,
  spaceId: "sp-1",
  authorUserId: "otro",
  authorName: "Otro",
  updatedAt: createdAt,
});

const { useChatStore } = await import("@/store/chat.store");

describe("refrescar un canal abierto", () => {
  beforeEach(() => {
    page = [];
    get.mockClear();
    useChatStore.setState({ spaceId: "sp-1", messages: [], hasMore: true });
  });

  /** Cinco páginas cargadas subiendo, y llega un mensaje. */
  it("conserva las páginas viejas que ya estaban cargadas", async () => {
    useChatStore.setState({
      messages: [msg("viejo-1", "2026-01-01"), msg("viejo-2", "2026-01-02")],
      hasMore: false,
    });
    page = [msg("viejo-2", "2026-01-02"), msg("nuevo", "2026-01-03")];

    await useChatStore.getState().refrescar();

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
      "viejo-1",
      "viejo-2",
      "nuevo",
    ]);
  });

  // `hasMore` en falso significa «ya no hay más hacia atrás». Reiniciarlo a
  // verdadero hacía que el scroll hacia arriba volviera a pedir páginas que no
  // existen, una y otra vez.
  it("y no reinicia si queda historia por cargar", async () => {
    useChatStore.setState({ messages: [msg("a", "2026-01-01")], hasMore: false });
    page = [msg("a", "2026-01-01")];
    await useChatStore.getState().refrescar();
    expect(useChatStore.getState().hasMore).toBe(false);
  });

  // Lo que hacía visible el fallo: la lista se quedaba en blanco durante toda la
  // ida y vuelta a la red, y al volver el scroll ya no sabía dónde estaba.
  it("nunca deja la lista vacía por el camino", async () => {
    useChatStore.setState({ messages: [msg("a", "2026-01-01")] });
    const vistos: number[] = [];
    const off = useChatStore.subscribe((s) => vistos.push(s.messages.length));
    page = [msg("a", "2026-01-01"), msg("b", "2026-01-02")];
    await useChatStore.getState().refrescar();
    off();
    expect(vistos).not.toContain(0);
  });

  // Un mensaje retirado por su autor tiene que desaparecer, que es la mitad del
  // motivo por el que esto se repide en vez de sólo añadir lo nuevo.
  it("pero un mensaje borrado sí se va", async () => {
    useChatStore.setState({ messages: [msg("a", "2026-01-01"), msg("b", "2026-01-02")] });
    page = [msg("a", "2026-01-01")];
    await useChatStore.getState().refrescar();
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["a"]);
  });

  /**
   * Y abrir sigue vaciando, que es lo que `refrescar` viene a **no** hacer.
   *
   * Lo que hay que afirmar es el estado **intermedio**, no el final: mirar el
   * resultado no distingue nada, porque `fetch` acaba reemplazando la lista de
   * todas formas. Lo que el vaciado protege es el rato de la ida y vuelta a la
   * red, donde si no se vacía quedan las líneas del canal anterior bajo el
   * nombre del nuevo. Lo cazó una mutación: quitarle el vaciado a `fetch` dejaba
   * pasar la primera versión de esta prueba.
   */
  it("abrir un canal vacía antes de traer nada", async () => {
    useChatStore.setState({ messages: [msg("de-otro", "2026-01-01")] });
    page = [msg("nuevo-canal", "2026-02-01")];

    const mezclado: string[][] = [];
    const off = useChatStore.subscribe((s) => {
      if (s.spaceId === "sp-2") mezclado.push(s.messages.map((m) => m.id));
    });
    await useChatStore.getState().fetch("sp-2");
    off();

    // En ningún momento con el canal nuevo puesto se vio la línea del viejo.
    expect(mezclado.some((ids) => ids.includes("de-otro"))).toBe(false);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["nuevo-canal"]);
  });
});
