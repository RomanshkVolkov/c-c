import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Volver a una llamada después de recargar la página.
 *
 * La sala vive en el proceso de Rust y una recarga no la cuelga: antes de esto
 * el micrófono seguía abierto y la página nueva decía «fuera», sin nada en
 * pantalla que avisara. Lo que se fija aquí:
 *
 * 1. Si el motor tiene una llamada viva, la página se pone dentro, con el
 *    canal, la org y los botones como estaban.
 * 2. La instantánea que manda el motor **mientras** contesta no se pierde —
 *    llega antes que la respuesta, y el `set` arranca de vacío—.
 * 3. Una llamada viva de la que no se sabe el canal se cuelga: una sala que
 *    no se puede enseñar es un micrófono abierto a escondidas.
 * 4. Al entrar, el motor recibe de qué es la llamada, para poder devolverlo.
 */

type Canal = { onmessage: ((ev: unknown) => void) | null };

const { invoke, post } = vi.hoisted(() => ({ invoke: vi.fn(), post: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({ api: { post, get: vi.fn(), delete: vi.fn() } }));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "org-b" }) },
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: { getState: () => ({ tree: [{ id: "esp-1", name: "general" }] }) },
}));

const { useVoice } = await import("./voice.store");
const inicial = useVoice.getState();

/** Un motor con llamada viva: manda la instantánea y luego contesta. */
function motorConLlamada(meta: unknown, extra: Partial<Record<string, unknown>> = {}) {
  let canal: Canal | null = null;
  invoke.mockImplementation(async (cmd: string, args: { onEvent?: Canal }) => {
    if (cmd !== "voice_attach") return undefined;
    canal = args.onEvent!;
    canal.onmessage!({ kind: "connected", identity: "u-yo" });
    canal.onmessage!({ kind: "joined", identity: "u-ana", name: "Ana" });
    canal.onmessage!({ kind: "muted", identity: "u-ana", muted: true });
    canal.onmessage!({ kind: "recording", active: true, id: "rec-1", by: "u-ana", since: "" });
    return {
      meta,
      yo: "u-yo",
      silenciado: true,
      sordo: false,
      camara: false,
      compartiendo: true,
      ...extra,
    };
  });
  return () => canal!;
}

beforeEach(() => {
  invoke.mockReset();
  post.mockReset();
  useVoice.setState({ ...inicial });
});

describe("volver a la llamada tras recargar", () => {
  it("con una llamada viva, la página se pone dentro y la instantánea no se pierde", async () => {
    motorConLlamada({ spaceId: "esp-9", orgId: "org-a", spaceName: "diseño" });
    await useVoice.getState().reanudar();

    const s = useVoice.getState();
    expect(s.estado).toBe("dentro");
    expect(s.spaceId).toBe("esp-9");
    // La org y el nombre salen del motor, no de la org en pantalla (org-b):
    // la llamada puede ser de otra.
    expect(s.orgId).toBe("org-a");
    expect(s.spaceName).toBe("diseño");
    // Los botones como estaban: silenciado en el motor es micro apagado aquí.
    expect(s.mic).toBe(false);
    expect(s.compartiendo).toBe(true);
    // Minimizada: recargar no es pedir la sala a pantalla completa.
    expect(s.escenario).toBe(false);
    // Lo que llegó antes de la respuesta.
    expect(s.gente).toEqual([{ identity: "u-ana", name: "Ana" }]);
    expect(s.mudos["u-ana"]).toBe(true);
    expect(s.recording?.id).toBe("rec-1");
  });

  it("lo que pasa después sigue llegando por el canal nuevo", async () => {
    const canal = motorConLlamada({ spaceId: "esp-9", orgId: "org-a", spaceName: "diseño" });
    await useVoice.getState().reanudar();
    canal().onmessage!({ kind: "left", identity: "u-ana" });
    expect(useVoice.getState().gente).toEqual([]);
  });

  it("sin llamada viva no pasa nada", async () => {
    invoke.mockResolvedValue(null);
    await useVoice.getState().reanudar();
    expect(useVoice.getState().estado).toBe("fuera");
    expect(invoke).not.toHaveBeenCalledWith("voice_leave");
  });

  it("una llamada viva sin canal conocido se cuelga en vez de quedar escondida", async () => {
    motorConLlamada(null);
    await useVoice.getState().reanudar();
    expect(useVoice.getState().estado).toBe("fuera");
    expect(invoke).toHaveBeenCalledWith("voice_leave");
  });

  it("estando ya en una llamada no se toca nada", async () => {
    useVoice.setState({ estado: "dentro", spaceId: "esp-1" });
    await useVoice.getState().reanudar();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("entrar le dice al motor de qué es la llamada", () => {
  beforeEach(() => {
    post.mockResolvedValue({ success: true, data: { url: "wss://x", token: "t", room: "r" } });
    invoke.mockResolvedValue("u-yo");
  });

  it("sin pista, la org en pantalla y el nombre del árbol", async () => {
    await useVoice.getState().entrar("esp-1");
    expect(invoke).toHaveBeenCalledWith(
      "voice_join",
      expect.objectContaining({ meta: { spaceId: "esp-1", orgId: "org-b", spaceName: "general" } }),
    );
    expect(useVoice.getState().spaceName).toBe("general");
  });

  it("aceptar un timbre de otra org lleva su org", async () => {
    useVoice.setState({
      entrante: {
        ringId: "r-1", spaceId: "esp-7", orgId: "org-a", spaceName: "ventas",
        from: { id: "u-ana", name: "Ana" }, expiresAt: new Date(Date.now() + 20_000).toISOString(),
      },
    });
    await useVoice.getState().aceptarEntrante();
    expect(invoke).toHaveBeenCalledWith(
      "voice_join",
      expect.objectContaining({ meta: { spaceId: "esp-7", orgId: "org-a", spaceName: "ventas" } }),
    );
  });

  it("con pista, la que se le da (un timbre de otra org)", async () => {
    await useVoice.getState().entrar("esp-7", { orgId: "org-a", spaceName: "ventas" });
    expect(invoke).toHaveBeenCalledWith(
      "voice_join",
      expect.objectContaining({ meta: { spaceId: "esp-7", orgId: "org-a", spaceName: "ventas" } }),
    );
  });
});
