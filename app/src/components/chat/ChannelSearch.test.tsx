import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Buscar dentro de un canal.
 *
 * La propiedad que se defiende aquí es una sola y es la razón de que esto no se
 * hiciera en el cliente: **la consulta va al servidor, con el canal puesto**.
 * Un filtro sobre lo que la pantalla tenga cargado sólo miraría la última
 * página, así que lo dicho hace tres pantallas no saldría — y una búsqueda que
 * no encuentra no dice «no está cargado», dice «no está».
 *
 * Los mutantes que matan: filtrar `items` en la app en vez de mandar `q`;
 * mandar la consulta sin `before`/sin el id del espacio; o arrastrar la
 * consulta al cambiar de pestaña, que da cero aciertos sin explicar por qué.
 */

const MIO = "11111111-1111-4111-8111-111111111111";

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: MIO } }),
    { getState: () => ({ accessToken: "t" }) },
  ),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      messages: [
        { id: "m1", authorUserId: MIO, authorName: "yo", kind: "user", body: "lo que hay cargado", createdAt: new Date().toISOString(), updatedAt: "" },
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
      sel({ openTask: vi.fn(), openDoc: vi.fn(), activeListId: null, tree: [], createTask: vi.fn() }),
    { getState: () => ({ board: null, activeListId: null, tree: [] }) },
  ),
}));
vi.mock("@/store/people.store", () => ({
  usePeopleStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ fetchPeople: vi.fn().mockResolvedValue(undefined) }),
    { getState: () => ({ current: () => [] }) },
  ),
}));
vi.mock("@/store/recordings.store", () => ({
  useRecordings: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ policy: {}, loadPolicy: vi.fn().mockResolvedValue(undefined), bySpace: {}, loading: {}, load: vi.fn() }),
    { getState: () => ({}) },
  ),
  mediaUrl: (id: string) => `http://localhost/media/${id}`,
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => <div /> }));

const { default: ChannelView } = await import("@/components/chat/ChannelView");

/** Las URLs que se le han pedido al servidor desde que empezó la prueba. */
const asked = () => get.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: [] });
});
afterEach(cleanup);

const typeInSearch = (text: string) => {
  const box = screen.getByPlaceholderText("Search in #portento");
  fireEvent.change(box, { target: { value: text } });
};

describe("buscar dentro de un canal", () => {
  it("le pregunta al servidor, con el canal en la ruta", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="portento" />);
    typeInSearch("despliegue");

    await waitFor(() =>
      expect(asked().some((u) => u.includes("/task-spaces/sp-1/chat?") && u.includes("q=despliegue"))).toBe(true),
    );
    // Y lo cargado deja de pintarse: lo que se ve son los aciertos, no el hilo
    // con unas líneas escondidas.
    expect(screen.queryByText("lo que hay cargado")).toBeNull();
  });

  it("la pestaña de multimedia busca en la suya, no en el hilo", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="portento" />);
    get.mockResolvedValue({ data: { items: [] } });
    fireEvent.click(screen.getByRole("tab", { name: /Media/ }));
    typeInSearch("factura");

    await waitFor(() =>
      expect(asked().some((u) => u.includes("/chat/media") && u.includes("q=factura"))).toBe(true),
    );
    expect(asked().some((u) => u.includes("/chat?") && u.includes("q=factura"))).toBe(false);
  });

  it("cambiar de pestaña no arrastra la consulta", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="portento" />);
    typeInSearch("despliegue");
    await waitFor(() => expect(asked().some((u) => u.includes("q=despliegue"))).toBe(true));

    get.mockResolvedValue({ data: { items: [] } });
    fireEvent.click(screen.getByRole("tab", { name: /Links/ }));

    // «despliegue» quiere decir otra cosa en Enlaces que en la conversación;
    // arrastrarla daría cero aciertos sin explicar por qué.
    expect(screen.getByPlaceholderText("Search in #portento")).toHaveProperty("value", "");
    await waitFor(() => expect(asked().some((u) => u.includes("/chat/links"))).toBe(true));
    expect(asked().some((u) => u.includes("/chat/links") && u.includes("q="))).toBe(false);
  });

  it("vaciarla devuelve el hilo", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="portento" />);
    typeInSearch("despliegue");
    await waitFor(() => expect(screen.queryByText("lo que hay cargado")).toBeNull());
    typeInSearch("");
    await waitFor(() => expect(screen.getByText("lo que hay cargado")).toBeTruthy());
  });
});
