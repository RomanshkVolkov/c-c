import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, post, get, del } = vi.hoisted(() => ({
  invoke: vi.fn(), post: vi.fn(), get: vi.fn(), del: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({ api: { post, get, delete: del } }));

import errorsEn from "@/locales/en/errors.json";
import { useVoice } from "./voice.store";

const inicial = useVoice.getState();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue("u-ana");
  post.mockReset();
  post.mockResolvedValue({
    success: true,
    data: {
      url: "wss://rtc.example", token: "jwt", room: "meet:inv-1",
      orgId: "org-1", spaceId: "esp-1", inviteId: "inv-1", title: "Con el cliente",
    },
  });
  useVoice.setState({ ...inicial });
});

describe("una reunión con invitados", () => {
  // El mutante que mata: pedir el token del canal. Entonces el miembro entraría
  // a la voz del canal mientras los invitados le esperan en la reunión.
  it("pide el token de la reunión, no el del canal", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    expect(post).toHaveBeenCalledWith("/api/v1/call-invites/inv-1/voice/token", {}, true);
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/task-spaces/"), expect.anything(), true);
    const s = useVoice.getState();
    expect(s.estado).toBe("dentro");
    expect(s.meetId).toBe("inv-1");
    expect(s.title).toBe("Con el cliente");
    expect(s.meetSpaceId).toBe("esp-1");
  });

  // Y no se presenta como el canal: el botón de entrar de ese canal, y su
  // escenario, miran `spaceId`, y tienen que ver que no estás en él.
  it("no ocupa la sala del canal del que cuelga", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    expect(useVoice.getState().spaceId).toBeNull();
  });

  // Pulsar «salir» mientras se pide el token: la conexión que llega después
  // no puede dejar un micrófono abierto donde nadie lo ve.
  it("una entrada que llega tarde, después de salir, no conecta", async () => {
    let soltar: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise((r) => (soltar = r)));
    const entrando = useVoice.getState().entrarEnReunion("inv-1");
    await useVoice.getState().salir();
    soltar({
      success: true,
      data: { url: "wss://x", token: "jwt", room: "meet:inv-1", orgId: "org-1", inviteId: "inv-1", title: "x" },
    });
    await entrando;
    expect(invoke).not.toHaveBeenCalledWith("voice_join", expect.anything());
    expect(useVoice.getState().estado).toBe("fuera");
  });
});

describe("salir de una llamada se dice con palabras", () => {
  // El mutante que mata: volver a enseñar el motivo crudo. A un invitado al
  // que se saca le quedaba «ParticipantRemoved» en pantalla.
  it("a quien se saca se le dice que lo sacaron", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    useVoice.getState().alRecibir({ kind: "disconnected", reason: "ParticipantRemoved" });
    expect(useVoice.getState().error).toBe(errorsEn["voice-removed"]);
  });

  it("una sala cerrada se dice como cerrada", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    useVoice.getState().alRecibir({ kind: "disconnected", reason: "RoomDeleted" });
    expect(useVoice.getState().error).toBe(errorsEn["voice-room-closed"]);
  });

  it("salir tú no es un error", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    for (const reason of ["Unknown", "ClientInitiated"]) {
      useVoice.getState().alRecibir({ kind: "disconnected", reason });
      expect(useVoice.getState().error).toBeNull();
    }
  });

  it("un motivo que no se conoce se enseña como llegó", async () => {
    useVoice.getState().alRecibir({ kind: "disconnected", reason: "SomethingNew" });
    expect(useVoice.getState().error).toBe("SomethingNew");
  });
});

describe("un invitado", () => {
  const entrada = {
    url: "wss://rtc.example", token: "jwt", room: "meet:inv-1",
    identity: "guest:g1", name: "Ana", pass: "g1.1.x", title: "Con el cliente",
  };

  it("entra sin pedir nada con sesión", async () => {
    await useVoice.getState().entrarComoInvitado(entrada);
    expect(post).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("voice_join", expect.objectContaining({ token: "jwt" }));
    const s = useVoice.getState();
    expect(s.visitor).toBe(true);
    expect(s.spaceId).toBeNull();
  });

  // La pantalla de después necesita saber que estuvo en una reunión, para
  // decir «te sacaron» y no «elige un canal».
  it("al caerse sigue sabiendo que era un invitado", async () => {
    await useVoice.getState().entrarComoInvitado(entrada);
    useVoice.getState().alRecibir({ kind: "disconnected", reason: "ParticipantRemoved" });
    const s = useVoice.getState();
    expect(s.estado).toBe("fuera");
    expect(s.visitor).toBe(true);
    expect(s.title).toBe("Con el cliente");
  });
});

// Dejar de compartir desde el botón del navegador tiene que apagar el de la
// app; si no, se queda encendido diciendo que compartes lo que ya no.
it("tu pantalla, retirada desde fuera, apaga el botón", () => {
  useVoice.setState({ ...inicial, estado: "dentro", yo: "u-ana", compartiendo: true });
  useVoice.getState().alRecibir({ kind: "video", identity: "u-ana", source: "screen", enabled: false });
  expect(useVoice.getState().compartiendo).toBe(false);
});

describe("el timbre en una reunión", () => {
  // El mutante que mata: llamar por la ruta del canal. El compañero entraría
  // a la voz del canal, no a la reunión donde le esperan.
  it("llamar a alguien desde una reunión le llama a la reunión", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    post.mockClear();
    post.mockResolvedValue({ success: true, data: { ringId: "r1" } });
    await useVoice.getState().timbrar("u-bea", "Bea");
    expect(post).toHaveBeenCalledWith("/api/v1/call-invites/inv-1/ring", { userId: "u-bea" }, true);
  });

  it("aceptar un timbre de reunión entra a la reunión", async () => {
    useVoice.getState().alTimbrar({
      ringId: "r1", spaceId: "esp-1", spaceName: "diseño", from: { id: "u-bea", name: "Bea" },
      expiresAt: new Date(Date.now() + 20_000).toISOString(), inviteId: "inv-1", title: "Con el cliente",
    });
    await useVoice.getState().aceptarEntrante();
    expect(post).toHaveBeenCalledWith("/api/v1/call-invites/inv-1/voice/token", {}, true);
    expect(useVoice.getState().meetId).toBe("inv-1");
  });

  // Ya dentro de esa reunión, una tarjeta que te invita a donde estás sólo tapa.
  it("un timbre a la reunión en la que ya estás no suena", async () => {
    await useVoice.getState().entrarEnReunion("inv-1");
    useVoice.getState().alTimbrar({
      ringId: "r2", spaceId: "esp-1", spaceName: "diseño", from: { id: "u-bea", name: "Bea" },
      expiresAt: new Date(Date.now() + 20_000).toISOString(), inviteId: "inv-1", title: "x",
    });
    expect(useVoice.getState().entrante).toBeNull();
  });

  // Un invitado no llama a nadie: no tiene sesión con la que hacerlo.
  it("un invitado no tiene timbre", async () => {
    useVoice.setState({ ...inicial, visitor: true, estado: "dentro" });
    post.mockClear();
    await useVoice.getState().timbrar("u-bea", "Bea");
    expect(post).not.toHaveBeenCalled();
  });
});
