import { useRef, useState } from "react";
import { Loader2, Mic, MonitorUp, PhoneOff, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Room } from "livekit-client";

/**
 * El laboratorio de **webview**, que ya no es por donde va la voz.
 *
 * **Esto no prueba los canales de voz.** Los canales usan un motor nativo, en
 * el proceso de Rust, precisamente porque esta pantalla demostró que el webview
 * de Linux viene compilado sin WebRTC. Un «RTCPeerConnection: fallo» aquí es el
 * resultado esperado en Linux y no dice nada sobre si la voz funciona.
 *
 * Sigue siendo útil para lo que sí mide: qué sabe hacer el webview de cada
 * sistema. Hará falta el día que algo de la interfaz quiera cámara o pantalla
 * desde la ventana en vez de desde el proceso — y para volver a medir cuando
 * cambie una versión de WebKitGTK.
 *
 * Deliberadamente autocontenida y sin tocar el backend de cac: el token se
 * acuña aquí mismo con la llave que se le dé. Eso está bien **sólo** porque es
 * una herramienta de diagnóstico contra un LiveKit de desarrollo — en el
 * producto real el token lo acuña el servidor, jamás el cliente.
 *
 * `livekit-client` se importa dinámicamente: así ni el bundle común ni jsdom
 * cargan un SDK de WebRTC que sólo usa esta pantalla.
 */

type Prueba = { nombre: string; estado: "pendiente" | "ok" | "fallo"; detalle: string };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Un token de LiveKit (JWT HS256), acuñado en el cliente.
 *
 * Sólo para este laboratorio: firmar requiere el secreto, y un secreto en el
 * cliente es exactamente lo que el diseño real evita. Con el par `devkey` /
 * `secret` del modo --dev no hay nada que proteger.
 */
async function tokenDeLaboratorio(
  apiKey: string,
  secreto: string,
  sala: string,
  identidad: string,
): Promise<string> {
  const enc = new TextEncoder();
  const cabecera = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = b64url(
    enc.encode(
      JSON.stringify({
        iss: apiKey,
        sub: identidad,
        name: identidad,
        nbf: ahora - 10,
        exp: ahora + 3600,
        video: { room: sala, roomJoin: true },
      }),
    ),
  );
  const llave = await crypto.subtle.importKey(
    "raw", enc.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", llave, enc.encode(`${cabecera}.${cuerpo}`)));
  return `${cabecera}.${cuerpo}.${b64url(firma)}`;
}

export default function VoiceLab() {
  const [url, setUrl] = useState("ws://localhost:7880");
  const [apiKey, setApiKey] = useState("devkey");
  const [secreto, setSecreto] = useState("secret");
  const [sala, setSala] = useState("laboratorio");
  const [identidad, setIdentidad] = useState(`probador-${Math.floor(Math.random() * 1000)}`);
  const [pruebas, setPruebas] = useState<Prueba[]>([]);
  const [conectado, setConectado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [dentro, setDentro] = useState<string[]>([]);
  const room = useRef<Room | null>(null);
  const audios = useRef<HTMLDivElement>(null);

  const anota = (nombre: string, estado: Prueba["estado"], detalle: string) =>
    setPruebas((p) => [...p.filter((x) => x.nombre !== nombre), { nombre, estado, detalle }]);

  /** Las capacidades del webview, sin red de por medio. */
  const sondear = async () => {
    setPruebas([]);
    const md = navigator.mediaDevices as MediaDevices | undefined;
    anota("mediaDevices", md ? "ok" : "fallo",
      md ? "existe" : "no existe — el webview no expone WebRTC (¿falta encenderlo?)");
    if (!md) return;

    anota("getDisplayMedia (API)", typeof md.getDisplayMedia === "function" ? "ok" : "fallo",
      typeof md.getDisplayMedia === "function"
        ? "la función existe (pedirla de verdad es el botón de pantalla)"
        : "no existe — compartir pantalla no es posible en este webview");

    // Lo que livekit-client comprueba antes de intentar nada: sin
    // RTCPeerConnection —o sin addTransceiver, que a GstWebRTC le faltó
    // durante años— dice «not supported» sin dar más pistas. Sondearlo por
    // separado convierte ese error opaco en una fila concreta del acta.
    const RPC = (window as unknown as { RTCPeerConnection?: { prototype: Record<string, unknown> } })
      .RTCPeerConnection;
    anota("RTCPeerConnection", RPC ? "ok" : "fallo",
      RPC ? "existe" : "no existe — WebRTC apagado o compilado fuera");
    if (RPC) {
      anota("addTransceiver", typeof RPC.prototype.addTransceiver === "function" ? "ok" : "fallo",
        typeof RPC.prototype.addTransceiver === "function"
          ? "existe"
          : "falta — livekit-client no funciona sin unified plan");
    }

    try {
      const s = await md.getUserMedia({ audio: true });
      const pista = s.getAudioTracks()[0];
      anota("micrófono", "ok", pista ? `"${pista.label || "sin nombre"}"` : "stream sin pista");
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      anota("micrófono", "fallo", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }

    try {
      const s = await md.getUserMedia({ video: true });
      const pista = s.getVideoTracks()[0];
      anota("cámara", "ok", pista ? `"${pista.label || "sin nombre"}"` : "stream sin pista");
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      // Sin cámara física también cae aquí; el detalle distingue los casos.
      anota("cámara", "fallo", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  /** Pedir la pantalla de verdad: en Linux esto debe abrir el portal del escritorio. */
  const probarPantalla = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      anota("compartir pantalla", "ok", `pista "${s.getVideoTracks()[0]?.label ?? "?"}"`);
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      anota("compartir pantalla", "fallo", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  /** La prueba completa: conectar al SFU, publicar el micro, oír a los demás. */
  const conectar = async () => {
    setOcupado(true);
    try {
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const token = await tokenDeLaboratorio(apiKey, secreto, sala, identidad);
      const r = new Room();
      const quienes = () =>
        setDentro([r.localParticipant.identity, ...[...r.remoteParticipants.values()].map((p) => p.identity)]);

      r.on(RoomEvent.ParticipantConnected, quienes)
        .on(RoomEvent.ParticipantDisconnected, quienes)
        .on(RoomEvent.TrackSubscribed, (track) => {
          // El audio remoto necesita un elemento donde sonar; LiveKit lo crea.
          if (track.kind === Track.Kind.Audio && audios.current) {
            audios.current.appendChild(track.attach());
          }
          quienes();
        })
        .on(RoomEvent.Disconnected, () => {
          setConectado(false);
          setDentro([]);
        });

      await r.connect(url, token);
      await r.localParticipant.setMicrophoneEnabled(true);
      room.current = r;
      setConectado(true);
      quienes();
      anota("conexión al SFU", "ok", `sala "${sala}" como "${identidad}", micro publicado`);
    } catch (e) {
      anota("conexión al SFU", "fallo", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setOcupado(false);
    }
  };

  const colgar = async () => {
    await room.current?.disconnect();
    room.current = null;
    audios.current?.replaceChildren();
  };

  const acta = () => {
    const ua = navigator.userAgent;
    const filas = pruebas.map((p) => `| ${p.nombre} | ${p.estado} | ${p.detalle} |`).join("\n");
    void navigator.clipboard.writeText(
      `### Acta de webview\n\nUA: \`${ua}\`\n\n| prueba | estado | detalle |\n|---|---|---|\n${filas}\n`,
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Webview lab</h1>
        {/* El aviso va arriba y en rojo porque esta pantalla se confunde con
            los canales de voz con una facilidad pasmosa — y su resultado normal
            en Linux es un fallo, que parece una avería y no lo es. */}
        <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs">
          <strong>Esto no prueba los canales de voz.</strong> La voz usa un motor nativo
          en el proceso de la app, no el webview. En Linux es <em>normal</em> que
          «RTCPeerConnection» falle aquí: es justamente el motivo de que la voz no
          pase por la ventana.
        </p>
        <p className="text-xs text-muted-foreground">
          Lo que sí mide: qué sabe hacer el webview de este sistema. Y opcionalmente,
          si conecta con un LiveKit de desarrollo
          (<code>docker run --rm -p7880:7880 -p7882:7882/udp livekit/livekit-server --dev</code>).
          El secreto se escribe aquí sólo porque es el de desarrollo; el producto real acuña
          el token en el servidor.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void sondear()}>
          <Mic className="mr-1 size-3.5" /> Sondear capacidades
        </Button>
        <Button size="sm" variant="outline" onClick={() => void probarPantalla()}>
          <MonitorUp className="mr-1 size-3.5" /> Pedir pantalla
        </Button>
        {pruebas.length > 0 && (
          <Button size="sm" variant="ghost" onClick={acta}>
            Copiar acta
          </Button>
        )}
      </div>

      {pruebas.length > 0 && (
        <ul className="divide-y rounded-md border text-xs">
          {pruebas.map((p) => (
            <li key={p.nombre} className="flex items-baseline gap-2 px-3 py-1.5">
              <span className={p.estado === "ok" ? "text-success" : "text-destructive"}>
                {p.estado === "ok" ? "✓" : "✗"}
              </span>
              <span className="w-40 shrink-0 font-medium">{p.nombre}</span>
              <span className="min-w-0 break-all text-muted-foreground">{p.detalle}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <div className="grid grid-cols-2 gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://localhost:7880" aria-label="LiveKit URL" />
          <Input value={sala} onChange={(e) => setSala(e.target.value)} placeholder="sala" aria-label="Room" />
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="api key" aria-label="API key" />
          <Input value={secreto} onChange={(e) => setSecreto(e.target.value)} placeholder="secreto" type="password" aria-label="API secret" />
          <Input value={identidad} onChange={(e) => setIdentidad(e.target.value)} placeholder="identidad" aria-label="Identity" />
          {!conectado ? (
            <Button size="sm" onClick={() => void conectar()} disabled={ocupado}>
              {ocupado ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Video className="mr-1 size-3.5" />}
              Conectar y publicar micro
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => void colgar()}>
              <PhoneOff className="mr-1 size-3.5" /> Colgar
            </Button>
          )}
        </div>
        {conectado && (
          <p className="text-xs text-muted-foreground">
            Dentro: {dentro.join(", ") || "sólo tú"} — abre{" "}
            <code>https://meet.livekit.io/?tab=custom</code> en un navegador normal como segundo
            participante para oírte.
          </p>
        )}
      </div>

      {/* Los <audio> remotos aterrizan aquí; invisibles, sólo suenan. */}
      <div ref={audios} className="hidden" />
    </div>
  );
}
