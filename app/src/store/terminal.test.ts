import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useTerminals, claveDe } from "./terminal.store";

const SERVIDOR = {
  id: "s1",
  name: "chido",
  host: "1.2.3.4",
  sshPort: 22,
  sshUser: "root",
};

const inicial = useTerminals.getState();

beforeEach(() => {
  // restoreMocks: true desarma la implementación entre tests, así que se rearma.
  invoke.mockResolvedValue(undefined);
  useTerminals.setState({
    sesiones: [],
    activa: null,
    abierto: false,
    maximizado: false,
    alto: inicial.alto,
  });
});

/** Abre y le pone el id que habría devuelto pty_open, como hace TerminalView. */
function abrirViva(name?: string) {
  const t = name ? ({ kind: "service", name } as const) : ({ kind: "host" } as const);
  useTerminals.getState().abrir(SERVIDOR, t);
  const key = claveDe(SERVIDOR.id, t);
  useTerminals.getState().marcarViva(key, `pty-${key}`);
  return key;
}

describe("pestañas del terminal", () => {
  it("abrir dos veces el mismo objetivo deja una pestaña, no dos", () => {
    abrirViva();
    useTerminals.getState().abrir(SERVIDOR, { kind: "service", name: "api" });
    useTerminals.getState().abrir(SERVIDOR, { kind: "host" });

    const { sesiones, activa } = useTerminals.getState();
    expect(sesiones.map((s) => s.label)).toEqual(["chido", "api"]);
    // Y la trae al frente en vez de no hacer nada.
    expect(activa).toBe(claveDe(SERVIDOR.id, { kind: "host" }));
  });

  it("el mismo servicio en dos servidores son dos pestañas", () => {
    useTerminals.getState().abrir(SERVIDOR, { kind: "service", name: "api" });
    useTerminals
      .getState()
      .abrir({ ...SERVIDOR, id: "s2", name: "otro" }, { kind: "service", name: "api" });
    expect(useTerminals.getState().sesiones).toHaveLength(2);
  });

  it("cerrar la activa deja mirando a la vecina", () => {
    abrirViva();
    const api = abrirViva("api");
    const web = abrirViva("web");

    useTerminals.getState().activar(api);
    useTerminals.getState().cerrar(api);

    // La de su derecha, no la primera: cerrar la del medio debe dejarte donde
    // estabas, no mandarte al principio de la fila.
    expect(useTerminals.getState().activa).toBe(web);
  });

  it("cerrar la última cierra el cajón", () => {
    const host = abrirViva();
    expect(useTerminals.getState().abierto).toBe(true);
    useTerminals.getState().cerrar(host);
    const st = useTerminals.getState();
    expect(st.abierto).toBe(false);
    expect(st.activa).toBeNull();
    expect(st.maximizado).toBe(false);
  });

  it("cerrar mata la sesión en la máquina", () => {
    const host = abrirViva();
    useTerminals.getState().cerrar(host);
    expect(invoke).toHaveBeenCalledWith("pty_close", { id: `pty-${host}` });
  });

  it("una sesión ya terminada no pide matar nada", () => {
    const host = abrirViva();
    useTerminals.getState().marcarTerminada(host, 0);
    invoke.mockClear();
    useTerminals.getState().cerrar(host);
    // El hilo lector ya la sacó del mapa del backend; volver a pedirlo sólo
    // provoca un error de "esa sesión ya no está".
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cerrarTodas mata todas las que siguen vivas", () => {
    abrirViva();
    abrirViva("api");
    invoke.mockClear();
    useTerminals.getState().cerrarTodas();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useTerminals.getState().sesiones).toEqual([]);
  });

  it("marcar rota conserva la pestaña con el motivo", () => {
    useTerminals.getState().abrir(SERVIDOR, { kind: "host" });
    const key = claveDe(SERVIDOR.id, { kind: "host" });
    useTerminals.getState().marcarRota(key, "Permission denied (publickey)");
    const s = useTerminals.getState().sesiones[0];
    // No se borra sola: el motivo del fallo es lo único que hay que leer.
    expect(s.estado).toBe("rota");
    expect(s.detalle).toContain("publickey");
  });

  it("el alto no baja de lo que cabe una línea", () => {
    useTerminals.getState().setAlto(10);
    expect(useTerminals.getState().alto).toBeGreaterThan(100);
  });
});
