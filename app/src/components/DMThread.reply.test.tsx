import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * Responder en un directo. Lo que cambia respecto a un canal: la flecha antes
 * sólo salía en lo mío —no había nada que hacer con lo del otro—, y contestar
 * es justo lo que se hace con lo del otro.
 *
 * Mutantes: volver a esconder la flecha en lo ajeno; ofrecer Editar en lo
 * ajeno; no mandar el id.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const BEA = "22222222-2222-4222-8222-222222222222";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post, postForm: vi.fn() }, apiUrl: (p: string) => p }));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ session: { id: ME } }),
    { getState: () => ({ session: { id: ME }, accessToken: "t" }), subscribe: () => () => {} },
  ),
}));
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
vi.mock("@/components/markdown/Markdown", () => ({ default: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

const { default: DMThread } = await import("./DMThread");
const { useDMStore } = await import("@/store/dm.store");

const now = new Date().toISOString();
beforeEach(() => {
  post.mockReset().mockResolvedValue({ data: { id: "nuevo" } });
  useDMStore.setState({
    conversationId: "c-1",
    conversations: [],
    loading: false,
    // El refresco tras mandar no importa aquí.
    fetch: vi.fn().mockResolvedValue(undefined),
    messages: [
      { id: "m-bea", conversationId: "c-1", authorUserId: BEA, authorName: "bea", body: "¿vienes?", createdAt: now, updatedAt: "" },
      {
        id: "m-yo", conversationId: "c-1", authorUserId: ME, authorName: "yo", body: "voy", createdAt: now, updatedAt: "",
        replyTo: { id: "m-bea", authorName: "bea", body: "¿vienes?", gone: false },
      },
    ],
  } as never);
});
afterEach(cleanup);

const rowOf = (id: string) => document.querySelector(`[data-msg-id="${id}"]`) as HTMLElement;

describe("responder en un directo", () => {
  it("a lo del otro se le contesta, pero no se edita", async () => {
    render(<DMThread onBack={() => {}} />);
    const flecha = rowOf("m-bea").querySelector('[aria-label="Message actions"]');
    expect(flecha).toBeTruthy();
    fireEvent.click(flecha as HTMLElement);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(screen.queryByText("Edit")).toBeNull();
    fireEvent.click(screen.getByText("Reply"));

    const caja = screen.getByLabelText("composer");
    fireEvent.change(caja, { target: { value: "sí" } });
    fireEvent.keyDown(caja, { key: "Enter" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/dm/c-1/messages", { body: "sí", replyToId: "m-bea" }, true),
    );
  });

  it("la respuesta enseña lo que cita", () => {
    render(<DMThread onBack={() => {}} />);
    expect(within(rowOf("m-yo")).getByText("¿vienes?")).toBeTruthy();
  });
});
