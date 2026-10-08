import { describe, expect, it, vi } from "vitest";

// La build web: el motor es el del navegador, y aquí se cambia por uno de
// mentira que apunta lo que le piden.
const { post, join, invoke } = vi.hoisted(() => ({
  post: vi.fn(), join: vi.fn(), invoke: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ isWebBuild: true, isTauri: false, isWeb: true, openExternal: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post, get: vi.fn(), delete: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@/lib/voice-engine/browser", () => ({
  browserEngine: {
    join, attach: vi.fn(async () => null), leave: vi.fn(async () => {}),
    setMic: vi.fn(), setDeaf: vi.fn(), setCamera: vi.fn(), screenSources: vi.fn(async () => []),
    shareScreen: vi.fn(), stopShare: vi.fn(), canShareScreen: () => true,
    listDevices: vi.fn(), setDevice: vi.fn(), micLevel: vi.fn(),
  },
}));

import { useVoice } from "./voice.store";

// Hasta W3 la web contestaba «todavía no» y no llamaba a nadie. El mutante
// que mata: volver a poner la puerta (o elegir el motor de Rust en la web, que
// no existe y dejaría la llamada «entrando» para siempre).
describe("en la versión web", () => {
  it("se entra a la voz de un canal, con el motor del navegador", async () => {
    post.mockResolvedValue({ success: true, data: { url: "wss://rtc.example", token: "jwt", room: "voice:esp-1" } });
    join.mockResolvedValue("u-ana");

    await useVoice.getState().entrar("esp-1");

    expect(join).toHaveBeenCalledWith(expect.objectContaining({ url: "wss://rtc.example", token: "jwt" }));
    expect(invoke).not.toHaveBeenCalled();
    const s = useVoice.getState();
    expect(s.error).toBeNull();
    expect(s.estado).toBe("dentro");
  });
});
