import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Lo que escribe un agente con el token de una persona lleva su nombre, pero
 * dice «vía agente» (22-oct-2026). Y no se pega debajo de un mensaje de esa
 * persona sin cabecera: la cabecera es donde va la marca.
 *
 * Roturas que detecta: no pintar la marca; pintarla en un mensaje tecleado; o
 * agrupar por autor solo, que esconde la cabecera del mensaje del agente.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { items: [] } }), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: ME } }),
    // `subscribe` porque `doc-pages.store` (que llega por `lib/open-ref`) se
    // suscribe a la sesión al cargarse, para vaciar su caché al salir.
    { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
  ),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      messages: [
        // Mía, tecleada; y justo debajo, mía también pero escrita por un agente
        // con mi token. Seguidas y del mismo autor: es el caso que se agrupaba.
        {
          id: "m1", authorUserId: OTHER, authorName: "ana", kind: "user",
          body: "lo escribió ana", createdAt: new Date().toISOString(), updatedAt: "",
        },
        {
          id: "m2", authorUserId: OTHER, authorName: "ana", kind: "user", via: "mcp",
          body: "lo escribió el agente de ana", createdAt: new Date().toISOString(), updatedAt: "",
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

const rowOf = (texto: string) =>
  screen.getByText(texto, { exact: false }).closest("div.group") as HTMLElement;

describe("un mensaje de agente en un canal", () => {
  it("dice vía agente, con su cabecera aunque siga a uno de la misma persona", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const agente = rowOf("lo escribió el agente de ana");
    expect(agente.querySelector('[data-testid="via-agent"]')).toBeTruthy();
    expect(agente.textContent).toContain("ana");
    const persona = rowOf("lo escribió ana");
    expect(persona.querySelector('[data-testid="via-agent"]')).toBeNull();
  });
});
