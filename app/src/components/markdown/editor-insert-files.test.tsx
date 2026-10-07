import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * La zona para soltar de una conversación entrega los ficheros al compositor
 * por `insertFiles`: los sube como si se hubieran pegado. Mutante: no subirlos.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("./MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

describe("insertFiles", () => {
  it("sube los ficheros al compositor", async () => {
    const ref = createRef<import("./MarkdownEditor").MarkdownEditorHandle>();
    const onChange = vi.fn();
    const onUpload = vi.fn(async (f: File) => ({ url: `/api/v1/x/${f.name}`, fileName: f.name }));
    render(
      <PromptProvider>
        <MarkdownEditor ref={ref} value="" onChange={onChange} onUpload={onUpload} />
      </PromptProvider>,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    const a = new File(["x"], "a.png", { type: "image/png" });
    const b = new File(["y"], "b.pdf", { type: "application/pdf" });
    ref.current!.insertFiles([a, b]);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls.map((c) => c[0].name)).toEqual(["a.png", "b.pdf"]);
    // Y quedan en el texto: esperar a eso también deja al editor terminar
    // antes de desmontar.
    await waitFor(() => {
      const md = String(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] ?? "");
      expect(md).toContain("/api/v1/x/a.png");
      expect(md).toContain("/api/v1/x/b.pdf");
    });
    cleanup();
  });
});
