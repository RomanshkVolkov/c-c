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
    spaceId: null, estado: "fuera", escenario: false, gente: [], hablando: [],
    mudos: {}, latencia: null, yo: null, mic: true, sordo: false, error: null,
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

/**
 * Minimizar no es colgar.
 *
 * Con un solo booleano —«estás dentro»— la pantalla de la sala y la conexión
 * son la misma cosa, y cerrar la primera corta la segunda: pulsas «minimizar»
 * para seguir escuchando mientras miras un tablero, y te quedas fuera de la
 * conversación sin enterarte. De ahí que haya dos.
 */
describe("estar en la llamada y estar mirándola", () => {
  it("entrar abre la pantalla de la sala", async () => {
    await useVoice.getState().entrar("esp-1");
    expect(useVoice.getState().escenario).toBe(true);
  });

  it("minimizar cierra la pantalla y deja la llamada en pie", async () => {
    await useVoice.getState().entrar("esp-1");
    invoke.mockClear();
    useVoice.getState().cerrarEscenario();
    expect(useVoice.getState().escenario).toBe(false);
    expect(useVoice.getState().estado).toBe("dentro");
    // Lo que de verdad se comprueba: nadie le dijo al motor que colgara.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("volver a la llamada no reconecta, sólo vuelve a enseñarla", async () => {
    await useVoice.getState().entrar("esp-1");
    useVoice.getState().cerrarEscenario();
    invoke.mockClear();
    useVoice.getState().abrirEscenario();
    expect(useVoice.getState().escenario).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sin llamada no hay escenario que abrir", () => {
    useVoice.getState().abrirEscenario();
    // Si no, quedaría una barra de controles sobre una sala vacía, con botones
    // que no van a ninguna parte y un «Leave» que no deja nada.
    expect(useVoice.getState().escenario).toBe(false);
  });

  it("salir apaga las dos cosas", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().salir();
    expect(useVoice.getState().escenario).toBe(false);
    expect(useVoice.getState().estado).toBe("fuera");
  });
});

describe("la sordera", () => {
  it("silencia el micrófono además de los altavoces", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarSordera();
    expect(useVoice.getState().sordo).toBe(true);
    // Ponerse sordo y seguir emitiendo es la trampa: dejas de oír que te están
    // hablando y sigues mandando la habitación entera.
    expect(useVoice.getState().mic).toBe(false);
    expect(invoke).toHaveBeenCalledWith("voice_set_deaf", { enabled: true });
    expect(invoke).toHaveBeenCalledWith("voice_set_mic", { enabled: false });
  });

  it("quitarla no reabre el micrófono por su cuenta", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarSordera();
    invoke.mockClear();
    await useVoice.getState().alternarSordera();
    expect(useVoice.getState().sordo).toBe(false);
    // Volver hablando sin querer es el accidente que este botón evita.
    expect(useVoice.getState().mic).toBe(false);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["voice_set_deaf"]);
  });

  it("no se hereda de una llamada a la siguiente", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarSordera();
    await useVoice.getState().entrar("esp-2");
    expect(useVoice.getState().sordo).toBe(false);
  });
});

/**
 * Quién tiene el micrófono cerrado, y cuánto tarda la voz en llegar.
 *
 * Los dos los reporta el motor —el primero porque `voice_set_mic` silencia la
 * **pista** y eso viaja al resto de la sala; el segundo del par ICE nominado—
 * y los dos tienen la misma trampa: un valor por defecto miente. Por eso
 * `mudos` es un mapa y no una lista, y `latencia` empieza en `null`.
 */
describe("lo que el motor cuenta de los demás", () => {
  it("apunta quién está mudo cuando lo dice el motor", () => {
    useVoice.getState().alRecibir({ kind: "muted", identity: "u-bea", muted: true });
    expect(useVoice.getState().mudos["u-bea"]).toBe(true);
  });

  it("de quien no ha dicho nada, no afirma nada", () => {
    useVoice.getState().alRecibir({ kind: "muted", identity: "u-bea", muted: true });
    // Ni abierto ni cerrado: `undefined`. Con una lista de mudos, «no sé» y
    // «está abierto» serían el mismo valor y la pantalla tendría que elegir.
    expect(useVoice.getState().mudos["u-caro"]).toBeUndefined();
  });

  it("al irse alguien se olvida su micrófono", () => {
    useVoice.setState({ gente: [{ identity: "u-bea", name: "bea" }] });
    useVoice.getState().alRecibir({ kind: "muted", identity: "u-bea", muted: true });
    useVoice.getState().alRecibir({ kind: "left", identity: "u-bea" });
    // Si se quedara, quien se fue mudo y vuelve abierto saldría silenciado
    // hasta que se le ocurriera tocar el botón.
    expect(useVoice.getState().mudos["u-bea"]).toBeUndefined();
  });

  it("silenciarte se pinta ya, sin esperar al servidor", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarMic();
    // Tu mosaico y el de los demás salen del mismo mapa; esperar la
    // confirmación son doscientos milisegundos de botón que no hace nada.
    expect(useVoice.getState().mudos["u-ana"]).toBe(true);
  });

  it("guarda la latencia que mide el motor", () => {
    useVoice.getState().alRecibir({ kind: "latency", ms: 38 });
    expect(useVoice.getState().latencia).toBe(38);
  });

  it("y no la arrastra de una llamada a la siguiente", async () => {
    useVoice.getState().alRecibir({ kind: "latency", ms: 38 });
    await useVoice.getState().entrar("esp-1");
    // 38 ms de la sala anterior en la cabecera de la nueva es un número que
    // parece medido y no lo es.
    expect(useVoice.getState().latencia).toBeNull();
  });
});
