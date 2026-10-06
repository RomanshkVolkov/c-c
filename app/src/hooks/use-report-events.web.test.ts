import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * El stream en el navegador lleva en la URL un pase del stream, nunca el token
 * de acceso: una URL acaba en los logs (barrido, 6-oct-2026). Y uno nuevo en
 * cada conexión. Mutantes: volver a poner el token de acceso; reutilizar el
 * primer pase al reconectar.
 */
const { urlTicket } = vi.hoisted(() => ({ urlTicket: vi.fn() }));
vi.mock("@/lib/url-ticket", () => ({ urlTicket }));

const abiertas: string[] = [];
class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(url: string) {
    abiertas.push(url);
  }
  addEventListener() {}
  close() {}
}
vi.stubGlobal("EventSource", FakeES);

const { useReportEvents } = await import("./use-report-events");
const { useAuthStore } = await import("@/store/auth.store");

afterEach(() => {
  abiertas.length = 0;
  urlTicket.mockReset();
});

describe("el stream en el navegador", () => {
  it("se abre con un pase del stream y no con el token de acceso", async () => {
    useAuthStore.setState({ accessToken: "acceso-secreto" } as never);
    urlTicket.mockResolvedValueOnce("pase-1").mockResolvedValueOnce("pase-2");
    const { unmount } = renderHook(() => useReportEvents());
    await waitFor(() => expect(abiertas.length).toBe(1));
    expect(urlTicket).toHaveBeenCalledWith("events");
    expect(abiertas[0]).toContain("/api/v1/events?token=pase-1");
    expect(abiertas[0]).not.toContain("acceso-secreto");
    unmount();
  });
});
