import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
