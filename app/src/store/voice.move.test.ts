import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La llamada del canal se muda a una reunión con gente de fuera, y quien está
 * en ella se va detrás sin que nadie le diga «muévete» (jose, 15-oct-2026).
 * El backend lo decide (ver `call_move_test.go`); esto es la mitad de la app.
 *
 * Mutantes: mudarse estando en otro canal; mudarse estando fuera; entrar al
 * canal vacío llegando tarde en vez de a la reunión; no avisar a la pantalla.
 */

const { invoke, post } = vi.hoisted(() => ({ invoke: vi.fn(), post: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({ api: { post, get: vi.fn(), delete: vi.fn() } }));

import { useVoice } from "./voice.store";

const inicial = useVoice.getState();

const meetToken = {
  success: true,
  data: { url: "wss://rtc.example", token: "jwt", room: "meet:inv-1", orgId: "org-1", spaceId: "esp-1", inviteId: "inv-1", title: "Con el cliente", sessionId: "cs-meet" },
};
const channelToken = (movedTo?: { inviteId: string; title: string }) => ({
  success: true,
  data: { url: "wss://rtc.example", token: "jwt", room: "voice:esp-1", orgId: "org-1", spaceName: "diseño", movedTo, sessionId: "cs-channel" },
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue("u-bea");
  post.mockReset();
  post.mockImplementation(async (ruta: string) => (ruta.includes("/call-invites/") ? meetToken : channelToken()));
  useVoice.setState({ ...inicial });
});

describe("cuando la llamada del canal se muda", () => {
  it("quien está en ella se va a la reunión, y la pantalla se entera", async () => {
    await useVoice.getState().entrar("esp-1", { orgId: "org-1", spaceName: "diseño" });
    expect(useVoice.getState().spaceId).toBe("esp-1");

    await useVoice.getState().seguirMudanza("esp-1", "inv-1", "Con el cliente");
    const s = useVoice.getState();
    expect(s.meetId).toBe("inv-1");
    expect(s.estado).toBe("dentro");
    expect(s.mudanza).toEqual({ inviteId: "inv-1", title: "Con el cliente" });
  });

  it("a quien está en otro canal no lo saca de ahí", async () => {
    await useVoice.getState().entrar("esp-2", { orgId: "org-1", spaceName: "otro" });
    await useVoice.getState().seguirMudanza("esp-1", "inv-1", "Con el cliente");
    expect(useVoice.getState().spaceId).toBe("esp-2");
    expect(useVoice.getState().meetId).toBeNull();
    expect(useVoice.getState().mudanza).toBeNull();
  });

  it("a quien no está en ninguna llamada no lo mete en una", async () => {
    // El canal que tenía abierto da igual: no estaba en la llamada.
    useVoice.setState({ spaceId: "esp-1", estado: "fuera" });
    await useVoice.getState().seguirMudanza("esp-1", "inv-1", "Con el cliente");
    expect(post).not.toHaveBeenCalled();
    expect(useVoice.getState().meetId).toBeNull();
  });

  // Pulsó «Unirse» justo después de la mudanza: el servidor contesta con la
  // entrada del canal **y** a dónde se fue todo el mundo.
  it("quien llega tarde acaba en la reunión, no solo en el canal", async () => {
    post.mockImplementation(async (ruta: string) =>
      ruta.includes("/call-invites/") ? meetToken : channelToken({ inviteId: "inv-1", title: "Con el cliente" }),
    );
    await useVoice.getState().entrar("esp-1", { orgId: "org-1", spaceName: "diseño" });
    const s = useVoice.getState();
    expect(s.meetId).toBe("inv-1");
    expect(s.spaceId).toBeNull();
    expect(s.mudanza?.inviteId).toBe("inv-1");
    expect(invoke).not.toHaveBeenCalledWith("voice_join", expect.objectContaining({ token: expect.anything(), room: "voice:esp-1" }));
  });
});

// La llamada guardada de la sala viaja con la entrada, y es de la que cuelga
// su chat. Mutante: no guardarla, o quedarse con la de la sala anterior.
describe("la llamada guardada de la sala", () => {
  it("la da la entrada al canal y la de la reunión, cada una la suya", async () => {
    await useVoice.getState().entrar("esp-1", { orgId: "org-1", spaceName: "diseño" });
    expect(useVoice.getState().sessionId).toBe("cs-channel");
    // Y se le da al motor, para que vuelva tras una recarga.
    expect(invoke).toHaveBeenCalledWith("voice_join", expect.objectContaining({
      meta: expect.objectContaining({ sessionId: "cs-channel" }),
    }));
    await useVoice.getState().entrarEnReunion("inv-1");
    expect(useVoice.getState().sessionId).toBe("cs-meet");
    await useVoice.getState().salir();
    expect(useVoice.getState().sessionId).toBeNull();
  });
});

// El invitado entra con su enlace: queda guardado para el chat de la llamada,
// y al salir se olvida. Mutante: no guardarlo.
describe("el chat del invitado", () => {
  it("guarda el enlace y el pase al entrar, y los suelta al salir", async () => {
    await useVoice.getState().entrarComoInvitado({
      url: "wss://rtc.example", token: "jwt", room: "meet:inv-1", identity: "guest:g1",
      name: "Cliente", pass: "pase-1", title: "Con el cliente", inviteToken: "inv.firma",
    });
    expect(useVoice.getState().guestChat).toEqual({ token: "inv.firma", pass: "pase-1" });
    await useVoice.getState().salir();
    expect(useVoice.getState().guestChat).toBeNull();
  });
});
