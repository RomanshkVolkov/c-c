import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, get, del } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get, delete: del },
  apiUrl: (p: string) => `https://cac.example${p}`,
  codigoDe: (e: unknown) => (e as { detalle?: string }).detalle ?? "",
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "el-token" }) },
}));

import { mediaUrl, useRecordings, type Recording } from "./recordings.store";

const inicial = useRecordings.getState();

function rec(over: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    orgId: "org-1",
    spaceId: "esp-1",
    startedBy: "u-ana",
    status: "recording",
    startedAt: "2026-09-18T00:00:00Z",
    hasScreen: true,
    ...over,
  };
}

function failure(detalle: string) {
  return Object.assign(new Error(detalle), { detalle });
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  del.mockReset();
  useRecordings.setState({ ...inicial, policy: {}, bySpace: {}, inFlight: null, error: null });
});

describe("el botón de grabar", () => {
  /**
   * El chip REC **no lo enciende el botón**.
   *
   * Lo enciende el motor de voz cuando el SFU dice que el metadata de la sala
   * cambió. Pintarlo al pulsar parece más ágil y miente: si el servidor
   * rechaza, o si otro empezó primero, la pantalla de quien pulsó diría que se
   * está recording y las demás dirían que no. Un aviso de grabación en el que no
   * se puede confiar es peor que ninguno.
   */
  it("start no pinta nada por su cuenta", async () => {
    post.mockResolvedValue({ success: true, data: rec() });
    get.mockResolvedValue({ success: true, data: { enabled: true, active: null } });

    await useRecordings.getState().start("esp-1");

    // Lo único que cambia es lo que el servidor contestó, no una suposición.
    expect(useRecordings.getState().policy["esp-1"]?.active).toBeNull();
    expect(useRecordings.getState().inFlight).toBeNull();
  });

  it("mientras está en vuelo, el botón sabe que está girando", async () => {
    let resolver: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise((r) => (resolver = r)));
    get.mockResolvedValue({ success: true, data: { enabled: true, active: null } });

    const p = useRecordings.getState().start("esp-1");
    expect(useRecordings.getState().inFlight).toBe("esp-1");
    resolver({ success: true, data: rec() });
    await p;
    expect(useRecordings.getState().inFlight).toBeNull();
  });

  /**
   * «Ya se está recording» no es una pantalla roja: alguien pulsó primero.
   *
   * Se relee la política y el chip aparece solo, que es lo que de verdad quería
   * quien pulsó.
   */
  it("si otro empezó primero, se relee la política en vez de protestar", async () => {
    post.mockRejectedValue(failure("already-recording"));
    get.mockResolvedValue({ success: true, data: { enabled: true, active: rec() } });

    const ok = await useRecordings.getState().start("esp-1");

    expect(ok).toBe(false);
    expect(get).toHaveBeenCalledWith(
      "/api/v1/task-spaces/esp-1/recordings/policy",
      true,
    );
    expect(useRecordings.getState().policy["esp-1"]?.active?.id).toBe("rec-1");
  });

  /** Y un failure de verdad sí se dice, sin releer nada. */
  it("una sala vacía se cuenta y no se relee la política", async () => {
    post.mockRejectedValue(failure("room-empty"));
    const ok = await useRecordings.getState().start("esp-1");
    expect(ok).toBe(false);
    expect(useRecordings.getState().error).toBe("room-empty");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("la política", () => {
  /**
   * Si no se puede preguntar, el botón se esconde.
   *
   * Es lo mismo que hace `enabled: false`, y a propósito: la pantalla no tiene
   * que saber distinguir «no está montado» de «no contestó». Lo que **no** debe
   * pasar es que el botón se quede pintado y falle a cada pulsación.
   */
  it("un failure al preguntarla esconde el botón", async () => {
    get.mockRejectedValue(failure("boom"));
    await useRecordings.getState().loadPolicy("esp-1");
    expect(useRecordings.getState().policy["esp-1"]).toEqual({ enabled: false, active: null });
  });
});

describe("la bySpace", () => {
  it("se carga por espacio", async () => {
    get.mockResolvedValue({ success: true, data: [rec({ status: "ready" })] });
    await useRecordings.getState().load("esp-1");
    expect(useRecordings.getState().bySpace["esp-1"]).toHaveLength(1);
    expect(useRecordings.getState().loading["esp-1"]).toBe(false);
  });

  /**
   * Borrar que falla **no quita la fila**.
   *
   * El servidor no borra la grabación si no consigue remove sus ficheros —para
   * poder reintentarlo—, así que quitarla de la pantalla diría que ya no está
   * cuando sigue ahí, ocupando bucket.
   */
  it("si el borrado falla, la fila se queda", async () => {
    get.mockResolvedValue({ success: true, data: [rec({ status: "ready" })] });
    await useRecordings.getState().load("esp-1");
    del.mockRejectedValue(failure("bad-gateway"));

    const ok = await useRecordings.getState().remove("rec-1", "esp-1");

    expect(ok).toBe(false);
    expect(useRecordings.getState().bySpace["esp-1"]).toHaveLength(1);
  });

  it("y si sale bien, se va", async () => {
    get.mockResolvedValue({ success: true, data: [rec({ status: "ready" })] });
    await useRecordings.getState().load("esp-1");
    del.mockResolvedValue({ success: true });

    expect(await useRecordings.getState().remove("rec-1", "esp-1")).toBe(true);
    expect(useRecordings.getState().bySpace["esp-1"]).toHaveLength(0);
  });
});

describe("el aviso del servidor", () => {
  /**
   * Una grabación que pasa a `ready` se ve **sin recargar**.
   *
   * Es lo que separa «procesando…» de un panel que hay que refrescar a mano
   * para enterarse de que ya está.
   */
  it("actualiza la fila que ya estaba", async () => {
    get.mockResolvedValue({ success: true, data: [rec({ status: "finalizing" })] });
    await useRecordings.getState().load("esp-1");

    useRecordings.getState().onStatus("esp-1", rec({ status: "ready", durationMs: 1000 }));

    const [fila] = useRecordings.getState().bySpace["esp-1"];
    expect(fila.status).toBe("ready");
    expect(fila.durationMs).toBe(1000);
    expect(useRecordings.getState().bySpace["esp-1"]).toHaveLength(1);
  });

  it("y mete la que no estaba, arriba", async () => {
    get.mockResolvedValue({ success: true, data: [rec({ id: "vieja", status: "ready" })] });
    await useRecordings.getState().load("esp-1");

    useRecordings.getState().onStatus("esp-1", rec({ id: "nueva" }));

    expect(useRecordings.getState().bySpace["esp-1"].map((r) => r.id)).toEqual(["nueva", "vieja"]);
  });

  it("al stop, la política deja de tener una activa", () => {
    useRecordings.setState({ policy: { "esp-1": { enabled: true, active: rec() } } });
    useRecordings.getState().onStatus("esp-1", null);
    expect(useRecordings.getState().policy["esp-1"].active).toBeNull();
  });
});

describe("la url del fichero", () => {
  /**
   * **Nunca una URL del bucket.**
   *
   * Una URL firmada de S3 que se escapa de una pantalla sigue valiendo hasta
   * que caduca, y esto es una reunión entera. El proxy de cac pide credencial en
   * cada petición y se puede cortar.
   */
  it("va por el proxy de cac y no por amazonaws", () => {
    const url = mediaUrl("rec-1");
    expect(url).toContain("/api/v1/recordings/rec-1/media");
    expect(url).not.toContain("amazonaws");
    expect(url).not.toContain("s3");
  });

  /** Y con el token en la consulta: un `<video src>` no manda cabeceras. */
  it("lleva el token, porque un <video> no puede mandar cabeceras", () => {
    expect(mediaUrl("rec-1")).toContain("token=el-token");
  });
});
