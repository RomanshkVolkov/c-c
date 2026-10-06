import { describe, expect, it, vi } from "vitest";

/**
 * Un adjunto en el navegador lleva en la URL el pase de adjuntos, no el token
 * de acceso. Mutante: volver a poner el token de acceso.
 */
vi.mock("@/lib/url-ticket", () => ({ currentMediaTicket: () => "pase-media" }));
const { mediaSrc } = await import("./media");
const { useAuthStore } = await import("@/store/auth.store");

describe("un adjunto en el navegador", () => {
  it("lleva el pase, nunca el token de acceso", () => {
    useAuthStore.setState({ accessToken: "acceso-secreto" } as never);
    const url = mediaSrc("/api/v1/tasks/attachments/a/file")!;
    expect(url).toContain("token=pase-media");
    expect(url).not.toContain("acceso-secreto");
  });
});
