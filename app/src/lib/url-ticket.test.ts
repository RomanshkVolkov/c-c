import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * Los pases de URL. El de adjuntos se guarda y se renueva antes de caducar,
 * porque `mediaSrc` es síncrono; el del stream es nuevo cada vez. Y mientras
 * no hay pase de adjuntos la web no pinta (una imagen pintada sin él no se
 * vuelve a pedir), salvo si pedirlo falla. Mutantes: no guardar; no renovar;
 * guardar el del stream; no esperar; quedarse en blanco si falla.
 */
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post } }));

const t = await import("./url-ticket");

const respuesta = (ticket: string, minutos: number) => ({
  success: true,
  data: { ticket, expiresAt: new Date(Date.now() + minutos * 60_000).toISOString() },
});

beforeEach(() => {
  post.mockReset();
  vi.resetModules();
});

describe("los pases de URL", () => {
  it("el de adjuntos se reutiliza mientras vale", async () => {
    const { urlTicket, currentMediaTicket } = await import("./url-ticket");
    post.mockResolvedValueOnce(respuesta("m-1", 30)).mockResolvedValueOnce(respuesta("m-2", 30));
    expect(await urlTicket("media")).toBe("m-1");
    expect(await urlTicket("media")).toBe("m-1");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/auth/url-ticket?scope=media", {}, true);
    expect(currentMediaTicket()).toBe("m-1");
  });

  it("un pase que caduca pronto se cambia", async () => {
    const { urlTicket } = await import("./url-ticket");
    post.mockResolvedValueOnce(respuesta("corto", 5)).mockResolvedValueOnce(respuesta("largo", 30));
    expect(await urlTicket("media")).toBe("corto");
    expect(await urlTicket("media")).toBe("largo");
  });

  it("el del stream es nuevo en cada conexión", async () => {
    const { urlTicket, currentMediaTicket } = await import("./url-ticket");
    post.mockResolvedValueOnce(respuesta("e-1", 30)).mockResolvedValueOnce(respuesta("e-2", 30));
    expect(await urlTicket("events")).toBe("e-1");
    expect(await urlTicket("events")).toBe("e-2");
    expect(currentMediaTicket()).toBeNull();
  });

  it("la web espera al pase de adjuntos", async () => {
    const { useMediaTicket } = await import("./url-ticket");
    let soltar: (v: unknown) => void = () => {};
    post.mockReturnValueOnce(new Promise((r) => (soltar = r)));
    const { result } = renderHook(() => useMediaTicket(true));
    expect(result.current).toBe(false);
    await act(async () => soltar(respuesta("m", 30)));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("si pedirlo falla, pinta igual en vez de quedarse en blanco", async () => {
    vi.resetModules();
    const { useMediaTicket, currentMediaTicket } = await import("./url-ticket");
    post.mockRejectedValue(new Error("sin red"));
    const { result } = renderHook(() => useMediaTicket(true));
    await waitFor(() => expect(result.current).toBe(true));
    expect(currentMediaTicket()).toBeNull();
  });

  it("en el escritorio no hace falta esperar", () => {
    const { result } = renderHook(() => t.useMediaTicket(false));
    expect(result.current).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});
