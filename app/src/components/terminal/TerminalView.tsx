import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTerminals, type TermSession } from "@/store/terminal.store";

/**
 * Un xterm atado a una sesión de `pty.rs`.
 *
 * Deliberadamente tonto: aquí no hay decisiones, sólo el cableado entre el
 * emulador y el backend. Lo que sí importa está en dos sitios:
 *
 * - La instancia vive en un `ref` y nunca en estado. Guardarla en estado la
 *   recrearía en cada render y con ella se iría el scrollback.
 * - `fit()` sólo se llama cuando la pestaña se ve. Un contenedor con
 *   `display:none` mide cero, y xterm calcularía una geometría absurda que
 *   luego le manda al servidor como tamaño de ventana real.
 */

type PtyEvent = { kind: "data"; b64: string } | { kind: "exit"; code: number };

/** base64 → bytes. Los bytes llegan así porque una lectura del pty puede
 *  partir un carácter UTF-8 por la mitad; xterm sabe juntar los trozos. */
function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function TerminalView({
  sesion,
  visible,
}: {
  sesion: TermSession;
  visible: boolean;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ptyId = useRef<string | null>(null);

  const marcarViva = useTerminals((s) => s.marcarViva);
  const marcarRota = useTerminals((s) => s.marcarRota);
  const marcarTerminada = useTerminals((s) => s.marcarTerminada);

  useEffect(() => {
    if (!caja.current) return;
    let cancelado = false;

    const t = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      // El scrollback es la mitad de la utilidad de un terminal: sin él, un
      // `docker logs` largo se pierde en cuanto termina de escribirse.
      scrollback: 5000,
      theme: { background: "#0b0d10" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(caja.current);
    f.fit();
    term.current = t;
    fit.current = f;

    const canal = new Channel<PtyEvent>();
    canal.onmessage = (msg) => {
      if (msg.kind === "data") t.write(bytes(msg.b64));
      else {
        ptyId.current = null;
        t.write(`\r\n\x1b[2m— session ended (exit ${msg.code}) —\x1b[0m\r\n`);
        marcarTerminada(sesion.key, msg.code);
      }
    };

    invoke<string>("pty_open", {
      serverId: sesion.serverId,
      host: sesion.host,
      sshPort: sesion.sshPort,
      sshUser: sesion.sshUser,
      target: sesion.target,
      rows: t.rows,
      cols: t.cols,
      onOutput: canal,
    })
      .then((id) => {
        // StrictMode monta, desmonta y vuelve a montar: si la limpieza pasó
        // mientras ssh arrancaba, esta sesión ya no tiene dueño y hay que
        // matarla o queda un `ssh` suelto en la máquina.
        if (cancelado) {
          void invoke("pty_close", { id }).catch(() => {});
          return;
        }
        ptyId.current = id;
        marcarViva(sesion.key, id);
      })
      .catch((e) => {
        if (cancelado) return;
        const motivo = e instanceof Error ? e.message : String(e);
        t.write(`\x1b[31m${motivo}\x1b[0m\r\n`);
        marcarRota(sesion.key, motivo);
      });

    const teclas = t.onData((d) => {
      if (ptyId.current) {
        void invoke("pty_write", { id: ptyId.current, data: d }).catch(() => {});
      }
    });

    return () => {
      cancelado = true;
      teclas.dispose();
      if (ptyId.current) void invoke("pty_close", { id: ptyId.current }).catch(() => {});
      ptyId.current = null;
      t.dispose();
      term.current = null;
      fit.current = null;
    };
    // Una sola vez por pestaña: la sesión es la pestaña, y volver a montarla
    // sería reconectar por la espalda.
     
  }, [sesion.key]);

  // Redimensionar de verdad: `fit` recalcula filas y columnas, y el backend se
  // lo dice a ssh, que manda SIGWINCH al otro lado. Sin esta ida y vuelta,
  // `htop` se queda dibujando 80×24 dentro de un panel enorme.
  useEffect(() => {
    if (!visible || !caja.current) return;
    const ajustar = () => {
      const t = term.current;
      if (!t || !fit.current) return;
      try {
        fit.current.fit();
      } catch {
        return; // el contenedor todavía no mide nada
      }
      if (ptyId.current) {
        void invoke("pty_resize", {
          id: ptyId.current,
          rows: t.rows,
          cols: t.cols,
        }).catch(() => {});
      }
    };
    ajustar();
    const obs = new ResizeObserver(ajustar);
    obs.observe(caja.current);
    return () => obs.disconnect();
  }, [visible]);

  useEffect(() => {
    if (visible) term.current?.focus();
  }, [visible]);

  return <div ref={caja} className="h-full w-full" />;
}
