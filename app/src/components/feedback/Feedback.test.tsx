import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El muro en pantalla. Lo que se fija:
 * 1. Al abrirlo se pide y se marca visto (después de pedirlo, o el «nuevo» se
 *    perdería en esta misma visita).
 * 2. Publicar: un member manda feedback de su org con la audiencia que elige;
 *    un viewer no ve el botón; un superadmin puede publicar comunicados, y si
 *    no es de la org sólo eso.
 * 3. En el modal: comentar manda el cuerpo; «Borrar» sólo si se puede, y
 *    preguntando.
 * 4. `?post=<id>` (el enlace de un aviso) abre esa publicación.
 */
const { get, post, del, confirm } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get, post, delete: del, postForm: vi.fn() },
  codigoDe: (e: unknown) => (e as { code?: string })?.code ?? "",
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirm }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/markdown/Markdown", () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: forwardRef(function Editor(
    { value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string },
    _ref,
  ) {
    return (
      <textarea
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit?.()}
      />
    );
  }),
}));

const { default: Feedback } = await import("@/pages/Feedback");
const { usePostsStore } = await import("@/store/posts.store");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const card = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: "feedback", audience: "platform", orgId: "org-1", orgName: "Uno", authorId: "u-x", authorName: "Ana",
  title: `t-${id}`, body: "cuerpo", createdAt: "2026-10-19T10:00:00Z", comments: 0, reactions: [],
  unseen: false, canDelete: false, ...over,
});

function setup({ role = "member", superadmin = false, orgId = "org-1" as string | null } = {}) {
  useAuthStore.setState({ session: { id: "u-me", username: "yo", superadmin } } as never);
  useOrgsStore.setState({
    orgs: orgId ? [{ id: orgId, name: "Uno", slug: "uno", role }] : [],
    currentOrgId: orgId,
  } as never);
}

const last = <T,>(xs: T[]) => xs[xs.length - 1];

const montar = (path = "/feedback") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Feedback />
    </MemoryRouter>,
  );

beforeEach(() => {
  get.mockReset();
  // Lo que contesta el servidor al publicar o comentar: la publicación, con
  // permiso de borrarla (la de la URL, si es un comentario).
  post.mockReset().mockImplementation(async (url: string) => {
    const id = url.match(/^\/api\/v1\/posts\/([^/]+)\/comments$/)?.[1] ?? "n";
    return { success: true, data: { ...card(id, { canDelete: true }), commentList: [] } };
  });
  del.mockReset();
  confirm.mockReset();
  usePostsStore.getState().reset();
  get.mockImplementation(async (url: string) =>
    url.startsWith("/api/v1/posts/")
      ? { success: true, data: { ...card(url.split("/").pop()!, { canDelete: true }), commentList: [] } }
      : { success: true, data: { posts: [card("a", { kind: "announcement" }), card("b")] } },
  );
});
afterEach(cleanup);

describe("el muro", () => {
  it("se pide y se marca visto al abrirlo", async () => {
    setup();
    montar();
    expect(await screen.findByText("t-a")).toBeTruthy();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/posts/seen", {}, true));
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  });

  it("un member publica feedback de su org con la audiencia que elige", async () => {
    setup();
    montar();
    fireEvent.click(await screen.findByRole("button", { name: /^Post$/ }));
    expect(screen.queryByText("Post as an announcement")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Share your idea/), { target: { value: "que el muro tenga encuestas" } });
    fireEvent.click(screen.getByRole("radio", { name: /Everyone/ }));
    fireEvent.click(last(screen.getAllByRole("button", { name: /^Post$/ })));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/posts",
        { kind: "feedback", orgId: "org-1", audience: "everyone", title: "", body: "que el muro tenga encuestas" },
        true,
      ),
    );
  });

  it("un viewer no ve «Publicar»", async () => {
    setup({ role: "viewer" });
    montar();
    await screen.findByText("t-a");
    expect(screen.queryByRole("button", { name: /^Post$/ })).toBeNull();
    expect(screen.getByText(/As a viewer/)).toBeTruthy();
  });

  it("un superadmin publica comunicados; si no es de la org, sólo eso", async () => {
    setup({ superadmin: true, orgId: null });
    montar();
    fireEvent.click(await screen.findByRole("button", { name: /^Post$/ }));
    expect(screen.queryByRole("radio", { name: /Everyone/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Share your idea/), { target: { value: "mantenimiento el sábado" } });
    fireEvent.click(last(screen.getAllByRole("button", { name: /^Post$/ })));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/posts", { kind: "announcement", title: "", body: "mantenimiento el sábado" }, true),
    );
  });

  // El formulario sigue montado al cambiar de org: un superadmin que pasa a
  // una donde no publica feedback sigue pudiendo publicar comunicados.
  it("un superadmin que cambia a una org sin feedback sigue publicando comunicados", async () => {
    setup({ superadmin: true });
    montar();
    await screen.findByText("t-a");
    act(() => useOrgsStore.setState({ orgs: [{ id: "org-1", name: "Uno", slug: "uno", role: "viewer" }] } as never));
    fireEvent.click(screen.getByRole("button", { name: /^Post$/ }));
    fireEvent.change(screen.getByLabelText(/Share your idea/), { target: { value: "aviso" } });
    fireEvent.click(last(screen.getAllByRole("button", { name: /^Post$/ })));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/posts", { kind: "announcement", title: "", body: "aviso" }, true),
    );
  });

  it("en el modal se comenta, y borrar pregunta antes", async () => {
    setup();
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "t-b" }));
    fireEvent.change(await screen.findByLabelText("Write a comment…"), { target: { value: "+1" } });
    fireEvent.keyDown(screen.getByLabelText("Write a comment…"), { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/posts/b/comments", { body: "+1" }, true));

    confirm.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    del.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/posts/b"));
  });

  it("sin poder borrar, no hay «Borrar»; y ?post= la abre", async () => {
    setup();
    get.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/posts/")
        ? { success: true, data: { ...card("z"), commentList: [] } }
        : { success: true, data: { posts: [] } },
    );
    montar("/feedback?post=z");
    expect(await screen.findByLabelText("Write a comment…")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("/api/v1/posts/z", true);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
