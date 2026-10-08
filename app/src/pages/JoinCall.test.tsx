import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: (e: unknown) => (e as { code?: string })?.code ?? "",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
// El medidor abriría el micrófono de verdad.
vi.mock("@/components/voice/MicLevel", () => ({ default: () => null }));

import errorsEn from "@/locales/en/errors.json";
import JoinCall from "@/pages/JoinCall";
import { useVoice } from "@/store/voice.store";

const info = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    title: "Con el cliente", orgName: "Portento", hostName: "Ana Pérez",
    expiresAt: "2026-10-09T00:00:00Z", recordingActive: false, recordingPossible: true, ...over,
  },
});

beforeEach(() => {
  post.mockReset();
  window.location.hash = "#inv-1.firma";
  useVoice.setState({ estado: "fuera", error: null, visitor: false });
});
afterEach(cleanup);

const espera = { success: true, data: { status: "waiting", name: "Carla", pass: "g1.9.x", title: "Con el cliente" } };

describe("la sala de espera", () => {
  // **Pedir entrar no es entrar.** Mientras nadie de dentro decide, la página
  // espera y no toca la sala. El mutante que mata: entrar con la respuesta de
  // `join` sin mirar el estado.
  it("pedir entrar deja esperando, sin entrar a la sala", async () => {
    const entrar = vi.fn(async () => {});
    useVoice.setState({ entrarComoInvitado: entrar });
    post.mockImplementation(async (path: string) => (path.endsWith("/inspect") ? info() : espera));
    render(<JoinCall />);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: /Join the call/ }));
    expect(await screen.findByText("Waiting for someone to let you in")).toBeTruthy();
    expect(entrar).not.toHaveBeenCalled();
  });

  // Y entra sola cuando le dejan, con la entrada que da el servidor.
  it("entra cuando un miembro le deja pasar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const entrar = vi.fn(async () => {});
      useVoice.setState({ entrarComoInvitado: entrar });
      post.mockImplementation(async (path: string) =>
        path.endsWith("/inspect")
          ? info()
          : path.endsWith("/status")
            ? { success: true, data: { ...espera.data, status: "admitted", url: "wss://rtc", token: "jwt" } }
            : espera,
      );
      render(<JoinCall />);
      fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Carla" } });
      fireEvent.click(screen.getByRole("button", { name: /Join the call/ }));
      await screen.findByText("Waiting for someone to let you in");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500);
      });
      expect(entrar).toHaveBeenCalledWith(expect.objectContaining({ token: "jwt", url: "wss://rtc" }));
      // Preguntó con su pase, sin sesión.
      expect(post).toHaveBeenCalledWith("/api/v1/public/calls/status", { token: "inv-1.firma", pass: "g1.9.x" }, false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A quien se rechaza no se le ofrece volver a pedir: su pase ya no sirve.
  it("si le dicen que no, lo dice y no ofrece volver", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/inspect")) return info();
      throw Object.assign(new Error("x"), { code: "guest-rejected" });
    });
    render(<JoinCall />);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: /Join the call/ }));
    expect(await screen.findByText("You weren't let in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Join again/ })).toBeNull();
  });
});

describe("la puerta del invitado", () => {
  // El aviso va antes del botón, siempre que se pueda grabar. El mutante que
  // mata: esconderlo, o enseñarlo sólo cuando ya se graba.
  it("avisa de que se puede grabar antes de entrar", async () => {
    post.mockResolvedValue(info());
    render(<JoinCall />);
    const aviso = await screen.findByRole("note");
    expect(aviso.textContent).toContain("Portento may record this call");
    const boton = screen.getByRole("button", { name: /Join the call/ });
    // Antes en el documento: se lee primero.
    expect(aviso.compareDocumentPosition(boton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("si ya se está grabando, lo dice así", async () => {
    post.mockResolvedValue(info({ recordingActive: true }));
    render(<JoinCall />);
    expect((await screen.findByRole("note")).textContent).toContain("being recorded right now");
  });

  it("sin nombre no se entra", async () => {
    post.mockResolvedValue(info());
    localStorage.removeItem("cac.guestName");
    render(<JoinCall />);
    const boton = await screen.findByRole("button", { name: /Join the call/ });
    expect((boton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Carla " } });
    expect((boton as HTMLButtonElement).disabled).toBe(false);
  });

  it("un enlace caducado lo dice con palabras", async () => {
    post.mockRejectedValue(Object.assign(new Error("x"), { code: "invite-expired" }));
    render(<JoinCall />);
    expect((await screen.findByRole("alert")).textContent).toBe(errorsEn["invite-expired"]);
  });

  // **Sin sesión.** Una sesión guardada de otra visita colaría una identidad
  // que no es la del enlace. El mutante que mata: `auth` a true.
  it("pregunta a la puerta pública sin autenticar, con el token del #", async () => {
    post.mockResolvedValue(info());
    render(<JoinCall />);
    await screen.findByRole("note");
    expect(post).toHaveBeenCalledWith("/api/v1/public/calls/inspect", { token: "inv-1.firma" }, false);
  });
});
