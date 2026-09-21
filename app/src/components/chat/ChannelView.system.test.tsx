import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un mensaje del sistema no tiene dueño.
 *
 * Es la mitad de cliente de la misma regla que el servidor guarda con
 * `ErrNotAUserMessage`, y la razón por la que hace falta en los dos sitios:
 * **la fila lleva de autor a quien provocó la línea**. Quien grabó *es* el
 * `authorUserId` del aviso de su propia grabación, así que `mine` dice que sí y
 * el desplegable le ofrecería Editar y Retirar sobre un mensaje automático.
 *
 * El mutante que mata: devolver el desplegable a estar gobernado sólo por
 * `mine`. El servidor seguiría rechazándolo, así que nada se rompe — lo único
 * que pasa es que la app enseña dos botones que dan 403.
 */

const MIO = "11111111-1111-4111-8111-111111111111";
const GRABACION = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { items: [] } }), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
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
        // La línea del sistema **firmada por mí**: es el caso que importa.
        {
          id: "m1", authorUserId: MIO, authorName: "yo", kind: "system",
          body: `The recording of this call is ready — [watch it](cac:recording/${GRABACION}).`,
          createdAt: new Date().toISOString(), updatedAt: "",
        },
        {
          id: "m2", authorUserId: MIO, authorName: "yo", kind: "user",
          body: "lo mio de verdad", createdAt: new Date().toISOString(), updatedAt: "",
        },
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
// Con la grabación encendida, que es cuando la pestaña existe.
vi.mock("@/store/recordings.store", () => ({
  useRecordings: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        policy: { "sp-1": { enabled: true, active: null } },
        loadPolicy: vi.fn().mockResolvedValue(undefined),
        bySpace: {}, loading: {}, load: vi.fn().mockResolvedValue(undefined),
      }),
    { getState: () => ({}) },
  ),
  mediaUrl: (id: string) => `http://localhost/media/${id}`,
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => <div /> }));

const { default: ChannelView } = await import("@/components/chat/ChannelView");

afterEach(cleanup);

const filaDe = (texto: string) =>
  screen.getByText(texto, { exact: false }).closest("div.group") as HTMLElement;

describe("un mensaje del sistema", () => {
  it("no ofrece editarlo ni retirarlo, aunque lleve mi id de autor", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const fila = filaDe("The recording of this call is ready");
    // Ni siquiera hay diana que pulsar: volverlo tarea o documento tampoco
    // tiene sentido sobre un aviso automático.
    expect(fila.querySelector('[aria-label="Message actions"]')).toBeNull();

    // Y la línea de al lado, que sí es mía, conserva las suyas.
    const mia = filaDe("lo mio de verdad");
    fireEvent.click(mia.querySelector('[aria-label="Message actions"]') as HTMLElement);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(screen.getByText("Edit")).toBeTruthy();
  });

  it("no se firma con el nombre de quien la provocó", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const fila = filaDe("The recording of this call is ready");
    // «You» es lo que saldría tratándola por el autor, y diría que este aviso
    // automático lo escribí yo.
    expect(fila.textContent).not.toContain("You");
    expect(fila.textContent).toContain("cac");
  });

  it("no se va al lado propio ni se encoge como un globo mío", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const fila = filaDe("The recording of this call is ready");
    expect(fila.className).not.toContain("items-end");
    const globo = fila.querySelector("div.relative") as HTMLElement;
    expect(globo.className).toContain("w-full");
  });
});

describe("las pestañas del canal", () => {
  it("empiezan por la conversación, y Grabaciones sustituye a la alternancia", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const hilo = screen.getByRole("tab", { name: /Conversation/ });
    expect(hilo.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /Recordings/ }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Recordings/ }).getAttribute("aria-selected")).toBe("true"),
    );
    // Y el hilo deja de estar: es una pestaña, no un panel encima.
    expect(screen.queryByText("lo mio de verdad")).toBeNull();
  });

  it("pulsar la grabación citada salta a su pestaña", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    fireEvent.click(screen.getByText("watch it"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Recordings/ }).getAttribute("aria-selected")).toBe("true"),
    );
  });
});
