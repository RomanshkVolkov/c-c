import { beforeEach, describe, expect, it, vi } from "vitest";

// En `vi.hoisted` porque `vi.mock` se iza por encima de cualquier `const`.
const { invoke, post, get } = vi.hoisted(() => ({ invoke: vi.fn(), post: vi.fn(), get: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  // El canal real es de Tauri; aquí sólo hace falta que se pueda construir y
  // que el store le cuelgue su `onmessage`.
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({ api: { post, get } }));

import { useVoice } from "./voice.store";

const inicial = useVoice.getState();

beforeEach(() => {
  invoke.mockResolvedValue("u-ana");
  post.mockResolvedValue({
    success: true,
    data: { url: "wss://rtc.example", token: "jwt", room: "voice:esp-1" },
  });
  useVoice.setState({
    ...inicial,
    spaceId: null, estado: "fuera", gente: [], hablando: [], yo: null, mic: true, error: null,
  });
});

describe("la sala de voz", () => {
  it("entrar pide el token del espacio y arranca el motor", async () => {
    await useVoice.getState().entrar("esp-1");
    expect(post).toHaveBeenCalledWith("/api/v1/task-spaces/esp-1/voice/token", {}, true);
    // La url y el token salen de la respuesta: la app no los conoce de antes,
    // y así el SFU puede mudarse sin publicar una versión.
    expect(invoke).toHaveBeenCalledWith(
      "voice_join",
      expect.objectContaining({ url: "wss://rtc.example", token: "jwt" }),
    );
    expect(useVoice.getState().estado).toBe("dentro");
  });

  it("entrar dos veces a la misma sala no reconecta", async () => {
    await useVoice.getState().entrar("esp-1");
    invoke.mockClear();
    await useVoice.getState().entrar("esp-1");
    // Reconectar cortaría la conversación en curso para dejarla igual.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cambiar de sala sale de la anterior primero", async () => {
    await useVoice.getState().entrar("esp-1");
    invoke.mockClear();
    await useVoice.getState().entrar("esp-2");
    // Dos micrófonos abiertos a la vez sólo se nota cuando alguien te oye
    // desde donde ya no estabas.
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["voice_leave", "voice_join"]);
  });

  it("si el token se niega, no queda a medias", async () => {
    post.mockResolvedValue({ success: false, error: "not found" });
    await useVoice.getState().entrar("esp-ajeno");
    const s = useVoice.getState();
    expect(s.estado).toBe("fuera");
    expect(s.spaceId).toBeNull();
    expect(s.error).toContain("not found");
  });

  it("salir libera el motor", async () => {
    await useVoice.getState().entrar("esp-1");
    invoke.mockClear();
    await useVoice.getState().salir();
    expect(invoke).toHaveBeenCalledWith("voice_leave");
    expect(useVoice.getState().spaceId).toBeNull();
  });
});

describe("lo que reporta el motor", () => {
  const ev = useVoice.getState().alRecibir;

  it("quien entra aparece una sola vez", () => {
    ev({ kind: "joined", identity: "u-bea", name: "bea" });
    ev({ kind: "joined", identity: "u-bea", name: "bea" });
    expect(useVoice.getState().gente).toHaveLength(1);
  });

  it("quien se va deja de estar y deja de hablar", () => {
    ev({ kind: "joined", identity: "u-bea", name: "bea" });
    ev({ kind: "speaking", identities: ["u-bea"] });
    ev({ kind: "left", identity: "u-bea" });
    const s = useVoice.getState();
    expect(s.gente).toHaveLength(0);
    // Sin esto, quien se va mientras habla deja su punto encendido para siempre.
    expect(s.hablando).toEqual([]);
  });

  it("hablando se reemplaza entero, no se acumula", () => {
    ev({ kind: "speaking", identities: ["u-ana", "u-bea"] });
    ev({ kind: "speaking", identities: ["u-ana"] });
    expect(useVoice.getState().hablando).toEqual(["u-ana"]);
  });

  it("una desconexión deja la sala limpia", () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro", gente: [{ identity: "u-bea", name: "bea" }] });
    ev({ kind: "disconnected", reason: "ClientInitiated" });
    const s = useVoice.getState();
    expect(s.spaceId).toBeNull();
    expect(s.gente).toEqual([]);
  });
});

describe("quién anda por los canales sin entrar", () => {
  it("pregunta por la organización en pantalla y guarda lo que venga", async () => {
    get.mockResolvedValue({
      success: true,
      data: { "esp-1": [{ identity: "u-bea", name: "bea" }] },
    });
    await useVoice.getState().refrescarOcupacion("org-1");
    expect(get).toHaveBeenCalledWith("/api/v1/chat/voice-presence?orgId=org-1", true);
    expect(useVoice.getState().ocupacion["esp-1"]).toHaveLength(1);
  });

  it("si el servidor falla, se calla y conserva lo último", async () => {
    useVoice.setState({ ocupacion: { "esp-1": [{ identity: "u-bea", name: "bea" }] } });
    get.mockRejectedValue(new Error("502"));
    await useVoice.getState().refrescarOcupacion("org-1");
    // Es informativo y se reintenta solo: vaciarlo o gritar sería peor que
    // enseñar durante quince segundos algo que quizá ya cambió.
    expect(useVoice.getState().ocupacion["esp-1"]).toHaveLength(1);
  });

  it("salir de una sala no borra quién hay en las demás", async () => {
    get.mockResolvedValue({ success: true, data: { "esp-2": [{ identity: "u-caro", name: "caro" }] } });
    await useVoice.getState().refrescarOcupacion("org-1");
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().salir();
    expect(useVoice.getState().ocupacion["esp-2"]).toHaveLength(1);
  });
});
