import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * Responder a un mensaje del canal, como en WhatsApp: se elige en la flecha,
 * se ve a qué se contesta encima del compositor, y lo mandado lleva el id.
 *
 * Mutantes: no mandar el id; no soltar la respuesta al mandar (la siguiente
 * línea contestaría a lo mismo sin que lo pidas); no pintar la cita; enseñar
 * el texto de un mensaje retirado.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const BEA = "22222222-2222-4222-8222-222222222222";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { items: [] } }), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: ME } }),
    { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
  ),
}));
const now = new Date().toISOString();
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      messages: [
        { id: "m-bea", authorUserId: BEA, authorName: "bea", kind: "user", body: "¿quién revisa el **PR**?", createdAt: now, updatedAt: "" },
        {
          id: "m-yo", authorUserId: ME, authorName: "yo", kind: "user", body: "yo lo reviso", createdAt: now, updatedAt: "",
          replyTo: { id: "m-bea", authorName: "bea", body: "¿quién revisa el **PR**?", gone: false },
        },
        {
          id: "m-ida", authorUserId: BEA, authorName: "bea", kind: "user", body: "contesto a algo que ya no está", createdAt: now, updatedAt: "",
          replyTo: { id: "m-x", authorName: "", body: "", gone: true },
        },
      ],
      loading: false, hasMore: false, loadingOlder: false, spaceId: "sp-1",
      following: [], fetch: vi.fn().mockResolvedValue(undefined),
      fetchOlder: vi.fn(), markRead: vi.fn(), post,
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
// El compositor, reducido a una caja: lo que se prueba es a dónde va lo escrito.
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: forwardRef(function Caja(
    p: { value: string; onChange: (v: string) => void; onSubmit?: () => void },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ focus: () => {}, insertLink: () => {}, insertFiles: () => {} }));
    return (
      <textarea
        aria-label="composer"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && p.onSubmit?.()}
      />
    );
  }),
}));

const { default: ChannelView } = await import("@/components/chat/ChannelView");

beforeEach(() => post.mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

// Por id: el texto de lo citado sale dos veces, en su línea y en la cita.
const rowOf = (id: string) => document.querySelector(`[data-msg-id="${id}"]`) as HTMLElement;

async function replyTo(id: string) {
  fireEvent.click(rowOf(id).querySelector('[aria-label="Message actions"]') as HTMLElement);
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  fireEvent.click(screen.getByText("Reply"));
}

function send(texto: string) {
  const caja = screen.getByLabelText("composer");
  fireEvent.change(caja, { target: { value: texto } });
  fireEvent.keyDown(caja, { key: "Enter" });
}

describe("responder en un canal", () => {
  it("lo mandado lleva a qué contesta, y después se suelta", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await replyTo("m-bea");
    // Encima del compositor, a quién y qué — sin el marcado.
    expect(screen.getByText("Replying to bea")).toBeTruthy();

    send("yo");
    await waitFor(() => expect(post).toHaveBeenCalledWith("sp-1", "yo", "m-bea"));
    await waitFor(() => expect(screen.queryByText("Replying to bea")).toBeNull());

    send("y otra cosa");
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("sp-1", "y otra cosa", undefined));
  });

  it("la X deja de contestar", async () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    await replyTo("m-bea");
    fireEvent.click(screen.getByLabelText("Cancel reply"));
    send("suelto");
    await waitFor(() => expect(post).toHaveBeenCalledWith("sp-1", "suelto", undefined));
  });

  it("la respuesta enseña lo que cita, sin marcado", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const row = rowOf("m-yo");
    const cita = within(row).getByText("¿quién revisa el PR?");
    expect(cita).toBeTruthy();
    expect(within(row).getByText("bea")).toBeTruthy();
  });

  it("si lo citado se retiró, lo dice y no lo enseña", () => {
    render(<ChannelView spaceId="sp-1" spaceName="uno" />);
    const row = rowOf("m-ida");
    expect(within(row).getByText("This message was withdrawn")).toBeTruthy();
  });
});
