import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * De qué lado cae cada mensaje.
 *
 * Lo propio a la derecha y lo demás a la izquierda: la señal se lee antes que
 * cualquier nombre, que es lo que hace falta en una conversación rápida.
 *
 * Y sólo el globo propio se limita en ancho. Partir la columna por la mitad
 * dejaría los mensajes de terceros —que son los que más se leen— a media
 * anchura sin ganar nada a cambio.
 */

const ME = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  // `subscribe` porque `doc-pages.store` (que llega por `lib/open-ref`) se
  // suscribe a la sesión al cargarse, para vaciar su caché al salir.
  useAuthStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: ME } }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      messages: [
        { id: "m1", authorUserId: ME, authorName: "yo", body: "lo mio", createdAt: new Date().toISOString(), updatedAt: "" },
        { id: "m2", authorUserId: "otro", authorName: "Ana", body: "lo de ana", createdAt: new Date().toISOString(), updatedAt: "" },
      ],
      loading: false, hasMore: false, loadingOlder: false, spaceId: "sp-1",
      following: [], fetch: vi.fn().mockResolvedValue(undefined),
      fetchOlder: vi.fn(), markRead: vi.fn(), post: vi.fn(),
      fetchFollowing: vi.fn().mockResolvedValue(undefined), setFollowing: vi.fn(),
    }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ openTask: vi.fn(), activeListId: null, tree: [], createTask: vi.fn() }),
    { getState: () => ({ board: null, activeListId: null, tree: [] }) },
  ),
}));
vi.mock("@/store/people.store", () => ({
  usePeopleStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ fetchPeople: vi.fn().mockResolvedValue(undefined) }),
    { getState: () => ({ current: () => [] }) },
  ),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => <div /> }));

const { default: ChannelView } = await import("@/components/chat/ChannelView");

afterEach(cleanup);

/** La fila entera de un mensaje: el `div.group` que lo envuelve. */
const rowOf = (text: string) =>
  screen.getByText(text).closest("div.group") as HTMLElement;

describe("de qué lado cae cada mensaje", () => {
  it("lo mío se va a la derecha y lo de los demás se queda a la izquierda", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    expect(rowOf("lo mio").className).toContain("items-end");
    expect(rowOf("lo de ana").className).not.toContain("items-end");
  });

  it("y quien habla se dice sin leer el nombre", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
  });

  it("el mensaje ajeno no se queda a media anchura", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const theirs = screen.getByText("lo de ana").closest("div.relative") as HTMLElement;
    expect(theirs.className).toContain("w-full");
    expect(theirs.className).not.toContain("max-w-");
  });

  it("el globo reserva el hueco de la flecha y de la carita, para que no tapen el texto", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    for (const text of ["lo mio", "lo de ana"]) {
      const bubble = screen.getByText(text).closest("div.relative") as HTMLElement;
      // Sin este relleno la flecha y la carita de reaccionar caen encima de
      // las primeras letras de la línea, que es justo lo que se venía a leer.
      // Son dos iconos desde las reacciones (11-oct-2026): con el hueco de uno
      // solo, la carita tapaba el texto.
      expect(bubble.className).toContain("pr-12");
    }
  });
});

/**
 * Las acciones de un mensaje, tras una flecha.
 *
 * Antes eran tres iconos de 12px flotando sobre el texto: tres blancos
 * diminutos que además tapaban lo escrito. Una sola diana que abre una bySpace
 * con los nombres de las cosas se acierta a la primera y se lee sin adivinar.
 */
describe("las acciones de un mensaje", () => {
  const openMenuOf = async (text: string) => {
    const row = rowOf(text);
    const arrow = row.querySelector('[aria-label="Message actions"]') as HTMLElement;
    expect(arrow).toBeTruthy();
    fireEvent.click(arrow);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  };

  it("lo mío ofrece editar y retirar", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await openMenuOf("lo mio");
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
  });

  it("lo de otro no ofrece editarlo ni retirarlo, pero sí volverlo tarea", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await openMenuOf("lo de ana");
    expect(screen.getByText("Create a task")).toBeTruthy();
    // Estar en la conversación no es permiso para reescribir lo que dijo otro.
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Withdraw")).toBeNull();
  });
});
