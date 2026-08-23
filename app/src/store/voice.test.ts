import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// En `vi.hoisted` porque `vi.mock` se iza por encima de cualquier `const`.
const { invoke, post, get, del } = vi.hoisted(() => ({
  invoke: vi.fn(), post: vi.fn(), get: vi.fn(), del: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  // El canal real es de Tauri; aquí sólo hace falta que se pueda construir y
  // que el store le cuelgue su `onmessage`.
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({ api: { post, get, delete: del } }));

import { useVoice } from "./voice.store";

const inicial = useVoice.getState();

beforeEach(() => {
  invoke.mockResolvedValue("u-ana");
  del.mockResolvedValue({ success: true });
  post.mockResolvedValue({
    success: true,
    data: { url: "wss://rtc.example", token: "jwt", room: "voice:esp-1" },
  });
  useVoice.setState({
    ...inicial,
    spaceId: null, estado: "fuera", escenario: false, gente: [], hablando: [],
    mudos: {}, latencia: null, llamando: null, entrante: null, video: {},
    pantalla: null, compartiendo: false,
    yo: null, mic: true, sordo: false, cam: false, error: null,
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

/**
 * El timbre.
 *
 * Un canal de voz al que hay que mirar para enterarte de que alguien te espera
 * no es una llamada, es un sitio. El timbre es lo que convierte «estoy en el
 * canal» en «te estoy llamando» — y con eso llega su problema: un teléfono que
 * suena y nadie para. El servidor **no guarda el timbre**, así que el tope de
 * los veinte segundos vive en los dos clientes, y estos tests son lo único que
 * lo vigila de este lado.
 */
const timbre = (extra: Partial<Record<string, unknown>> = {}) => ({
  ringId: "r-1",
  spaceId: "esp-9",
  spaceName: "general",
  from: { id: "u-bea", name: "bea" },
  expiresAt: new Date(Date.now() + 20_000).toISOString(),
  ...extra,
});

describe("llamar a alguien", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockResolvedValue({ success: true, data: { ringId: "r-1" } });
  });
  afterEach(() => vi.useRealTimers());

  it("no se puede llamar desde fuera de una sala", async () => {
    await useVoice.getState().timbrar("u-bea", "bea");
    // A qué sala la invitarías. La llamada es «vente aquí», y sin aquí no hay
    // nada que ofrecer.
    expect(useVoice.getState().llamando).toBeNull();
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/ring"), expect.anything(), true);
  });

  it("se rinde a los veinte segundos, en vez de sonar para siempre", async () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro" });
    await useVoice.getState().timbrar("u-bea", "bea");
    expect(useVoice.getState().llamando?.sinRespuesta).toBe(false);

    vi.advanceTimersByTime(20_000);
    // No desaparece: se queda como «no contestó». Una fila que se esfuma sola
    // no dice si te rechazaron o si el botón nunca hizo nada.
    expect(useVoice.getState().llamando?.sinRespuesta).toBe(true);
    expect(useVoice.getState().llamando?.name).toBe("bea");
  });

  it("si el servidor lo rechaza, no se queda una llamada de mentira sonando", async () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro" });
    post.mockResolvedValue({ success: false, error: "ring-outsider" });
    await useVoice.getState().timbrar("u-carla", "carla");
    expect(useVoice.getState().llamando).toBeNull();
    expect(useVoice.getState().error).toContain("ring-outsider");
  });

  it("colgar avisa al otro lado y para el reloj", async () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro" });
    await useVoice.getState().timbrar("u-bea", "bea");
    await useVoice.getState().cancelarTimbre();

    expect(del).toHaveBeenCalledWith("/api/v1/task-spaces/esp-1/voice/ring/u-bea", true);
    vi.advanceTimersByTime(30_000);
    // Sin parar el reloj, el «no contestó» resucitaría la fila que ya cerraste.
    expect(useVoice.getState().llamando).toBeNull();
  });

  it("salirse de la sala le calla el teléfono a quien llamabas", async () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro" });
    await useVoice.getState().timbrar("u-bea", "bea");
    await useVoice.getState().salir();
    // Si no, le sigue sonando veinte segundos una invitación a una sala vacía.
    expect(del).toHaveBeenCalledWith("/api/v1/task-spaces/esp-1/voice/ring/u-bea", true);
  });

  it("que te digan que no se ve como que te dijeron que no", async () => {
    useVoice.setState({ spaceId: "esp-1", estado: "dentro" });
    await useVoice.getState().timbrar("u-bea", "bea");
    useVoice.getState().alColgarTimbre("u-bea");
    expect(useVoice.getState().llamando?.sinRespuesta).toBe(true);
  });
});

describe("que te llamen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enseña quién llama y a qué canal", () => {
    useVoice.getState().alTimbrar(timbre() as never);
    expect(useVoice.getState().entrante?.from.name).toBe("bea");
    expect(useVoice.getState().entrante?.spaceName).toBe("general");
  });

  it("se apaga sola a la hora que dijo el servidor", () => {
    useVoice.getState().alTimbrar(timbre() as never);
    vi.advanceTimersByTime(20_000);
    // Es lo que hace que un timbre sobreviva a que la app de quien llamaba
    // muera de golpe: nadie mandará la cancelación y aun así deja de sonar.
    expect(useVoice.getState().entrante).toBeNull();
  });

  it("no te invita a la sala en la que ya estás", () => {
    useVoice.setState({ spaceId: "esp-9", estado: "dentro" });
    useVoice.getState().alTimbrar(timbre() as never);
    expect(useVoice.getState().entrante).toBeNull();
  });

  it("si el que llama cuelga, la tarjeta se va", () => {
    useVoice.getState().alTimbrar(timbre() as never);
    useVoice.getState().alColgarTimbre("u-bea");
    expect(useVoice.getState().entrante).toBeNull();
  });

  it("y la de otra persona no", () => {
    useVoice.getState().alTimbrar(timbre() as never);
    useVoice.getState().alColgarTimbre("u-quien-sea");
    expect(useVoice.getState().entrante).not.toBeNull();
  });

  it("aceptar entra a la sala del que llamaba, no a la que tuvieras delante", async () => {
    post.mockResolvedValue({
      success: true,
      data: { url: "wss://rtc.example", token: "jwt", room: "voice:esp-9" },
    });
    useVoice.getState().alTimbrar(timbre() as never);
    await useVoice.getState().aceptarEntrante();
    expect(post).toHaveBeenCalledWith("/api/v1/task-spaces/esp-9/voice/token", {}, true);
    expect(useVoice.getState().entrante).toBeNull();
  });

  it("rechazar se lo dice a quien llamaba, en vez de dejarle esperando", async () => {
    useVoice.getState().alTimbrar(timbre() as never);
    await useVoice.getState().rechazarEntrante();
    // Veinte segundos mirando un «llamando» que ya nadie va a coger.
    expect(del).toHaveBeenCalledWith("/api/v1/task-spaces/esp-9/voice/ring/u-bea", true);
    expect(useVoice.getState().entrante).toBeNull();
  });
});

/**
 * La cámara.
 *
 * Su diferencia con el micrófono es que **puede fallar**: puede no haber
 * ninguna, puede estar cogida por otro programa, y en macOS puede faltar el
 * permiso. Silenciarse no puede fallar, y por eso el micro se pinta al pulsar y
 * la cámara espera al motor.
 */
describe("encender la cámara", () => {
  it("no se enciende hasta que el motor dice que sí", async () => {
    await useVoice.getState().entrar("esp-1");
    let resolver: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "voice_set_camera" ? new Promise((r) => (resolver = r)) : Promise.resolve("u-ana"),
    );

    const enCurso = useVoice.getState().alternarCam();
    // Todavía no: pintar el botón encendido y que no salga imagen deja a
    // alguien saludando a nadie.
    expect(useVoice.getState().cam).toBe(false);
    resolver(undefined);
    await enCurso;
    expect(useVoice.getState().cam).toBe(true);
  });

  it("si no hay cámara, el botón se queda apagado y se dice por qué", async () => {
    await useVoice.getState().entrar("esp-1");
    invoke.mockRejectedValue(new Error("no se pudo abrir la cámara"));
    await useVoice.getState().alternarCam();
    expect(useVoice.getState().cam).toBe(false);
    expect(useVoice.getState().error).toContain("no se pudo abrir la cámara");
  });

  it("y si falla al apagarla, no te dice que estás apagado", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarCam();
    expect(useVoice.getState().cam).toBe(true);

    invoke.mockRejectedValue(new Error("el motor no contesta"));
    await useVoice.getState().alternarCam();
    // Sigue publicando, probablemente. Decirte que nadie te ve mientras te ven
    // es el peor de los dos errores posibles — el mismo criterio que el micro.
    expect(useVoice.getState().cam).toBe(true);
  });

  it("no se hereda de una llamada a la siguiente", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarCam();
    await useVoice.getState().entrar("esp-2");
    // Entrar a otra sala con la cámara pintada como encendida, sin estarlo, es
    // el peor de los dos errores posibles aquí.
    expect(useVoice.getState().cam).toBe(false);
  });
});

/**
 * Compartir pantalla.
 *
 * Lo que tiene decisión aquí no es encenderla sino **quién ocupa el escenario**
 * cuando hay más de una: sólo cabe una grande, y cambiar de foco solo —porque
 * alguien más empezó a compartir— es quitarle de delante a la gente lo que
 * estaba leyendo.
 */
describe("la pantalla compartida", () => {
  it("la cámara y la pantalla de la misma persona son cosas distintas", () => {
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "camera", enabled: true });
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: true });
    // Su cara sigue en el mosaico y su pantalla va al escenario. Con una sola
    // entrada por persona, la segunda pisaba a la primera.
    expect(useVoice.getState().video["u-bea"]).toBe(true);
    expect(useVoice.getState().pantalla).toBe("u-bea");
  });

  it("el segundo que comparte no le quita el sitio al primero", () => {
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: true });
    useVoice.getState().alRecibir({ kind: "video", identity: "u-caro", source: "screen", enabled: true });
    expect(useVoice.getState().pantalla).toBe("u-bea");
  });

  it("y al soltarla, el escenario vuelve a los mosaicos", () => {
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: true });
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: false });
    expect(useVoice.getState().pantalla).toBeNull();
  });

  it("pero soltarla otro no se lo quita a quien la tiene", () => {
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: true });
    useVoice.getState().alRecibir({ kind: "video", identity: "u-caro", source: "screen", enabled: false });
    expect(useVoice.getState().pantalla).toBe("u-bea");
  });

  it("si el que comparte se va, el escenario se libera", () => {
    useVoice.setState({ gente: [{ identity: "u-bea", name: "bea" }] });
    useVoice.getState().alRecibir({ kind: "video", identity: "u-bea", source: "screen", enabled: true });
    useVoice.getState().alRecibir({ kind: "left", identity: "u-bea" });
    // Si no, queda un rectángulo negro con el nombre de alguien que ya no está.
    expect(useVoice.getState().pantalla).toBeNull();
  });

  it("no se pinta compartiendo hasta que el sistema conceda la pantalla", async () => {
    await useVoice.getState().entrar("esp-1");
    let resolver: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "voice_share_screen" ? new Promise((r) => (resolver = r)) : Promise.resolve("u-ana"),
    );
    const enCurso = useVoice.getState().alternarCompartir();
    // Entre pulsar y que salga imagen hay un diálogo del sistema pidiendo
    // permiso. Pintarlo encendido mientras alguien decide es prometer algo que
    // todavía no ha pasado, y que puede acabar en «no».
    expect(useVoice.getState().compartiendo).toBe(false);
    resolver(undefined);
    await enCurso;
    expect(useVoice.getState().compartiendo).toBe(true);
  });

  it("y si falla al parar, no te dice que dejaste de compartir", async () => {
    await useVoice.getState().entrar("esp-1");
    await useVoice.getState().alternarCompartir();
    invoke.mockRejectedValue(new Error("el motor no contesta"));
    await useVoice.getState().alternarCompartir();
    // Tu pantalla probablemente se sigue viendo. Decir que no es el peor de
    // los dos errores posibles — el mismo criterio que el micro y la cámara.
    expect(useVoice.getState().compartiendo).toBe(true);
  });
});

describe("el aviso de error", () => {
  // Nada limpiaba este campo salvo salir de la llamada, así que un fallo
  // pasajero de la cámara dejaba el cartel puesto el resto de la sesión — y
  // reintentar no servía, porque el segundo intento contesta que el dispositivo
  // sigue ocupado.
  it("se puede descartar", async () => {
    useVoice.setState({ error: "la cámara dejó de dar imagen: 0xC00D3704", errorSpaceId: "esp-1" });
    useVoice.getState().limpiarError();
    expect(useVoice.getState().error).toBeNull();
    expect(useVoice.getState().errorSpaceId).toBeNull();
  });

  // Una acción que sí funciona borra el aviso de la que no: si el micrófono
  // responde, seguir enseñando el fallo de la cámara es mentir sobre el estado
  // actual del motor.
  it("una acción que funciona lo borra", async () => {
    useVoice.setState({
      error: "la cámara dejó de dar imagen",
      errorSpaceId: "esp-1",
      mic: true,
      yo: "u-1",
    });
    invoke.mockResolvedValue(undefined);
    await useVoice.getState().alternarMic();
    expect(useVoice.getState().error).toBeNull();
  });

  // El error es uno para toda la sala y el botón de entrar de cada canal lo
  // leía: media lista en rojo por un fallo de cámara de otra llamada.
  it("sabe de qué canal es", async () => {
    post.mockResolvedValue({ success: false, error: "space not found" });
    await useVoice.getState().entrar("esp-9");
    expect(useVoice.getState().errorSpaceId).toBe("esp-9");
  });
});
