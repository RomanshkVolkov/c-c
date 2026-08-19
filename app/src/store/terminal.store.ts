import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Las pestañas del panel de terminal, y nada más.
 *
 * Aquí no vive ningún xterm: xterm mide texto de verdad contra el DOM y una
 * instancia guardada en estado se recrearía en cada render, tirando la pantalla
 * y el scrollback. La instancia vive en un `ref` dentro de `TerminalView`; lo
 * que se guarda aquí es qué pestañas hay, cuál se está mirando y con qué
 * sesión del backend habla cada una — que es justo la parte que se puede
 * probar sin un navegador de verdad.
 */

export type TermTarget = { kind: "host" } | { kind: "service"; name: string };

/** "abriendo" → "viva" → "terminada"; "rota" si ni siquiera llegó a abrir. */
export type TermEstado = "abriendo" | "viva" | "terminada" | "rota";

export interface TermSession {
  /** Identidad de la pestaña: es lo que evita abrir dos veces lo mismo. */
  key: string;
  label: string;
  target: TermTarget;
  serverId: string;
  host: string;
  sshPort: number;
  sshUser: string;
  /** El id que devolvió `pty_open`; null mientras la sesión está abriendo. */
  ptyId: string | null;
  estado: TermEstado;
  /** Por qué se rompió, o con qué código salió. */
  detalle?: string;
}

export interface ServidorSSH {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
}

interface TerminalUI {
  sesiones: TermSession[];
  activa: string | null;
  abierto: boolean;
  maximizado: boolean;
  /** Alto del cajón en píxeles cuando no está maximizado. */
  alto: number;

  abrir: (servidor: ServidorSSH, target: TermTarget) => void;
  activar: (key: string) => void;
  cerrar: (key: string) => void;
  cerrarTodas: () => void;
  setMaximizado: (v: boolean) => void;
  setAlto: (px: number) => void;

  // Lo que reporta TerminalView cuando habla con el backend.
  marcarViva: (key: string, ptyId: string) => void;
  marcarRota: (key: string, detalle: string) => void;
  marcarTerminada: (key: string, code: number) => void;
}

export function claveDe(serverId: string, t: TermTarget): string {
  return t.kind === "host" ? `${serverId}:host` : `${serverId}:svc:${t.name}`;
}

const ALTO_MINIMO = 140;
const ALTO_POR_DEFECTO = 320;

export const useTerminals = create<TerminalUI>((set, get) => ({
  sesiones: [],
  activa: null,
  abierto: false,
  maximizado: false,
  alto: ALTO_POR_DEFECTO,

  abrir: (servidor, target) => {
    const key = claveDe(servidor.id, target);
    // Ya abierta: se trae al frente. Duplicar la pestaña abriría una segunda
    // conexión ssh a lo mismo y dejaría dos pestañas con el mismo nombre.
    if (get().sesiones.some((s) => s.key === key)) {
      set({ activa: key, abierto: true });
      return;
    }
    const sesion: TermSession = {
      key,
      label: target.kind === "host" ? servidor.name : target.name,
      target,
      serverId: servidor.id,
      host: servidor.host,
      sshPort: servidor.sshPort,
      sshUser: servidor.sshUser,
      ptyId: null,
      estado: "abriendo",
    };
    set((s) => ({
      sesiones: [...s.sesiones, sesion],
      activa: key,
      abierto: true,
    }));
  },

  activar: (key) => set({ activa: key }),

  cerrar: (key) => {
    const { sesiones, activa } = get();
    const i = sesiones.findIndex((s) => s.key === key);
    if (i === -1) return;
    const ptyId = sesiones[i].ptyId;
    // Cerrar es matar: sin esto queda un `ssh` vivo en la máquina por cada
    // pestaña que se cerró.
    if (ptyId) void invoke("pty_close", { id: ptyId }).catch(() => {});
    const quedan = sesiones.filter((s) => s.key !== key);
    set({
      sesiones: quedan,
      // La vecina, no siempre la primera: cerrar la del medio debe dejarte al
      // lado de donde estabas.
      activa:
        activa === key ? (quedan[i]?.key ?? quedan[i - 1]?.key ?? null) : activa,
      // El cajón vacío no se queda ocupando media pantalla.
      abierto: quedan.length > 0,
      maximizado: quedan.length > 0 && get().maximizado,
    });
  },

  cerrarTodas: () => {
    for (const s of get().sesiones) {
      if (s.ptyId) void invoke("pty_close", { id: s.ptyId }).catch(() => {});
    }
    set({ sesiones: [], activa: null, abierto: false, maximizado: false });
  },

  setMaximizado: (v) => set({ maximizado: v }),
  setAlto: (px) => set({ alto: Math.max(ALTO_MINIMO, px) }),

  marcarViva: (key, ptyId) =>
    set((s) => ({
      sesiones: s.sesiones.map((x) =>
        x.key === key ? { ...x, ptyId, estado: "viva" as const } : x,
      ),
    })),

  marcarRota: (key, detalle) =>
    set((s) => ({
      sesiones: s.sesiones.map((x) =>
        x.key === key ? { ...x, estado: "rota" as const, detalle } : x,
      ),
    })),

  marcarTerminada: (key, code) =>
    set((s) => ({
      sesiones: s.sesiones.map((x) =>
        x.key === key
          ? {
              ...x,
              estado: "terminada" as const,
              ptyId: null,
              detalle: code === 0 ? "exit 0" : `exit ${code}`,
            }
          : x,
      ),
    })),
}));
