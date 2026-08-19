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

const MIO = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: MIO } }),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      messages: [
        { id: "m1", authorUserId: MIO, authorName: "yo", body: "lo mio", createdAt: new Date().toISOString(), updatedAt: "" },
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
const filaDe = (texto: string) =>
  screen.getByText(texto).closest("div.group") as HTMLElement;

describe("de qué lado cae cada mensaje", () => {
  it("lo mío se va a la derecha y lo de los demás se queda a la izquierda", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    expect(filaDe("lo mio").className).toContain("items-end");
    expect(filaDe("lo de ana").className).not.toContain("items-end");
  });

  it("y quien habla se dice sin leer el nombre", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
  });

  it("el mensaje ajeno no se queda a media anchura", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const ajeno = screen.getByText("lo de ana").closest("div.relative") as HTMLElement;
    expect(ajeno.className).toContain("w-full");
    expect(ajeno.className).not.toContain("max-w-");
  });

  it("el globo reserva el hueco de la flecha, para que no tape el texto", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    for (const texto of ["lo mio", "lo de ana"]) {
      const globo = screen.getByText(texto).closest("div.relative") as HTMLElement;
      // Sin este relleno la flecha cae encima de las primeras letras de la
      // línea, que es justo lo que se venía a leer.
      expect(globo.className).toContain("pr-7");
    }
  });
});

/**
 * Las acciones de un mensaje, tras una flecha.
 *
 * Antes eran tres iconos de 12px flotando sobre el texto: tres blancos
 * diminutos que además tapaban lo escrito. Una sola diana que abre una lista
 * con los nombres de las cosas se acierta a la primera y se lee sin adivinar.
 */
describe("las acciones de un mensaje", () => {
  const abrirMenuDe = async (texto: string) => {
    const fila = filaDe(texto);
    const flecha = fila.querySelector('[aria-label="Message actions"]') as HTMLElement;
    expect(flecha).toBeTruthy();
    fireEvent.click(flecha);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  };

  it("lo mío ofrece editar y retirar", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await abrirMenuDe("lo mio");
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
  });

  it("lo de otro no ofrece editarlo ni retirarlo, pero sí volverlo tarea", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await abrirMenuDe("lo de ana");
    expect(screen.getByText("Create a task")).toBeTruthy();
    // Estar en la conversación no es permiso para reescribir lo que dijo otro.
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Withdraw")).toBeNull();
  });
});
