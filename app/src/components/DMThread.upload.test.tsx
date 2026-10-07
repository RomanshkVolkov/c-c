import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * Pegar una captura en un directo (jose, 6-oct-2026): el compositor no sabía
 * subir, y la imagen se perdía al enviar. Ahora sube a la conversación abierta,
 * por su ruta propia (sólo la ven las dos personas). Mutantes: compositor sin
 * `onUpload`; subir a otra ruta o a otra conversación.
 */
const { postForm } = vi.hoisted(() => ({
  postForm: vi.fn(async () => ({ data: { url: "/api/v1/dm/c-1/attachments/a-1/raw", fileName: "captura.png" } })),
}));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), postForm }, apiUrl: (p: string) => p }));
const editores: { onUpload?: (f: File) => Promise<unknown>; maxHeight?: string }[] = [];
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: (props: { onUpload?: (f: File) => Promise<unknown>; maxHeight?: string }) => {
    editores.push(props);
    return null;
  },
}));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

const { default: DMThread } = await import("./DMThread");
const { useDMStore } = await import("@/store/dm.store");

afterEach(() => {
  cleanup();
  editores.length = 0;
});

describe("pegar una captura en un directo", () => {
  it("se sube a la conversación abierta", async () => {
    useDMStore.setState({ conversationId: "c-1", messages: [], conversations: [], loading: false } as never);
    render(<DMThread onBack={() => {}} />);
    const compositor = editores[editores.length - 1];
    expect(compositor.onUpload).toBeTypeOf("function");
    // Y con tope de alto: una captura pegada no echa fuera la conversación.
    expect(compositor.maxHeight).toBeTruthy();
    const res = await compositor.onUpload!(new File(["x"], "captura.png", { type: "image/png" }));
    expect(postForm).toHaveBeenCalledWith("/api/v1/dm/c-1/attachments", expect.any(FormData));
    expect(res).toEqual({ url: "/api/v1/dm/c-1/attachments/a-1/raw", fileName: "captura.png" });
  });
});
