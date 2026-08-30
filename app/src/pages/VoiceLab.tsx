import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardCopy, Loader2, Mic, MonitorUp, PhoneOff, RefreshCw, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Room } from "livekit-client";

/**
 * El laboratorio de **webview**, que ya no es por donde va la voz.
 *
 * **Esto no prueba los canales de voz.** Los canales usan un motor nativo, en
 * el proceso de Rust, precisamente porque esta pantalla demostró que el webview
 * de Linux viene compilado sin WebRTC. Un «RTCPeerConnection: fail» aquí es el
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
 *
 * **Fuera del catálogo de idiomas, a conciencia.** Todo el texto de aquí va en
 * inglés y a secas, sin `t()`. No es producto: es un instrumento de medida que
 * usa quien mantiene el motor de voz, y lo que se copia de aquí acaba pegado en
 * un reporte que lee el mismo equipo. Traducirlo metería treinta claves de
 * jerga —«addTransceiver», «unified plan»— en un catálogo que hay que mantener
 * a la par en dos idiomas, a cambio de nada.
 */

type Check = { name: string; state: "pending" | "ok" | "fail"; detail: string };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Un token de LiveKit (JWT HS256), acuñado en el cliente.
 *
 * Sólo para este laboratorio: firmar requiere el secreto, y un secreto en el
 * cliente es exactamente lo que el diseño real evita. Con el par `devkey` /
 * `secret` del modo --dev no hay nada que proteger.
 */
async function labToken(
  apiKey: string,
  secret: string,
  roomName: string,
  identity: string,
): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        iss: apiKey,
        sub: identity,
        name: identity,
        nbf: now - 10,
        exp: now + 3600,
        video: { room: roomName, roomJoin: true },
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(signature)}`;
}

export default function VoiceLab() {
  const [url, setUrl] = useState("ws://localhost:7880");
  const [apiKey, setApiKey] = useState("devkey");
  const [secret, setSecret] = useState("secret");
  const [roomName, setRoomName] = useState("lab");
  const [identity, setIdentity] = useState(`tester-${Math.floor(Math.random() * 1000)}`);
  const [checks, setChecks] = useState<Check[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inside, setInside] = useState<string[]>([]);
  const room = useRef<Room | null>(null);
  const audios = useRef<HTMLDivElement>(null);

  const note = (name: string, state: Check["state"], detail: string) =>
    setChecks((p) => [...p.filter((x) => x.name !== name), { name, state, detail }]);

  /** Las capacidades del webview, sin red de por medio. */
  const probe = async () => {
    setChecks([]);
    const md = navigator.mediaDevices as MediaDevices | undefined;
    note("mediaDevices", md ? "ok" : "fail",
      md ? "present" : "missing — this webview exposes no WebRTC (not enabled?)");
    if (!md) return;

    note("getDisplayMedia (API)", typeof md.getDisplayMedia === "function" ? "ok" : "fail",
      typeof md.getDisplayMedia === "function"
        ? "the function is there (actually asking for it is the screen button)"
        : "missing — screen sharing is not possible in this webview");

    // Lo que livekit-client comprueba antes de intentar nada: sin
    // RTCPeerConnection —o sin addTransceiver, que a GstWebRTC le faltó
    // durante años— dice «not supported» sin dar más pistas. Sondearlo por
    // separado convierte ese error opaco en una fila concreta del acta.
    const RPC = (window as unknown as { RTCPeerConnection?: { prototype: Record<string, unknown> } })
      .RTCPeerConnection;
    note("RTCPeerConnection", RPC ? "ok" : "fail",
      RPC ? "present" : "missing — WebRTC off or compiled out");
    if (RPC) {
      note("addTransceiver", typeof RPC.prototype.addTransceiver === "function" ? "ok" : "fail",
        typeof RPC.prototype.addTransceiver === "function"
          ? "present"
          : "missing — livekit-client needs unified plan");
    }

    try {
      const s = await md.getUserMedia({ audio: true });
      const track = s.getAudioTracks()[0];
      note("microphone", "ok", track ? `"${track.label || "unnamed"}"` : "stream with no track");
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      note("microphone", "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }

    try {
      const s = await md.getUserMedia({ video: true });
      const track = s.getVideoTracks()[0];
      note("camera", "ok", track ? `"${track.label || "unnamed"}"` : "stream with no track");
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      // Sin cámara física también cae aquí; el detalle distingue los casos.
      note("camera", "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  /** Pedir la pantalla de verdad: en Linux esto debe abrir el portal del escritorio. */
  const probeScreen = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      note("screen share", "ok", `track "${s.getVideoTracks()[0]?.label ?? "?"}"`);
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      note("screen share", "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  /** La prueba completa: conectar al SFU, publicar el micro, oír a los demás. */
  const connect = async () => {
    setBusy(true);
    try {
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const token = await labToken(apiKey, secret, roomName, identity);
      const r = new Room();
      const who = () =>
        setInside([r.localParticipant.identity, ...[...r.remoteParticipants.values()].map((p) => p.identity)]);

      r.on(RoomEvent.ParticipantConnected, who)
        .on(RoomEvent.ParticipantDisconnected, who)
        .on(RoomEvent.TrackSubscribed, (track) => {
          // El audio remoto necesita un elemento donde sonar; LiveKit lo crea.
          if (track.kind === Track.Kind.Audio && audios.current) {
            audios.current.appendChild(track.attach());
          }
          who();
        })
        .on(RoomEvent.Disconnected, () => {
          setConnected(false);
          setInside([]);
        });

      await r.connect(url, token);
      await r.localParticipant.setMicrophoneEnabled(true);
      room.current = r;
      setConnected(true);
      who();
      note("SFU connection", "ok", `room "${roomName}" as "${identity}", mic published`);
    } catch (e) {
      note("SFU connection", "fail", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hangUp = async () => {
    await room.current?.disconnect();
    room.current = null;
    audios.current?.replaceChildren();
  };

  const copyReport = () => {
    const ua = navigator.userAgent;
    const rows = checks.map((c) => `| ${c.name} | ${c.state} | ${c.detail} |`).join("\n");
    void navigator.clipboard.writeText(
      `### Webview report\n\nUA: \`${ua}\`\n\n| check | state | detail |\n|---|---|---|\n${rows}\n`,
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      {/* El diario va **primero**. Es lo único de esta pantalla que sirve para
          diagnosticar los canales de voz de verdad, y estaba al final, debajo
          de un formulario con URL, clave y secreto que parecen obligatorios —
          alguien vino a copiar el diario y lo primero que preguntó fue qué
          poner en esos campos. Lo que se usa a diario va antes que lo que se
          usa una vez. */}
      <EngineLog />

      <div className="space-y-2 border-t pt-4">
        <h1 className="text-lg font-semibold">Webview lab</h1>
        {/* El aviso va arriba y en rojo porque esta pantalla se confunde con
            los canales de voz con una facilidad pasmosa — y su resultado normal
            en Linux es un fallo, que parece una avería y no lo es. */}
        <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs">
          <strong>This does not test the voice channels.</strong> Voice runs on a native
          engine inside the app process, not the webview. On Linux it is <em>normal</em>{" "}
          for "RTCPeerConnection" to fail here: that is precisely why voice does not go
          through the window.
        </p>
        <p className="text-xs text-muted-foreground">
          What it does measure: what this system's webview can do. And optionally, whether
          it connects to a development LiveKit
          (<code>docker run --rm -p7880:7880 -p7882:7882/udp livekit/livekit-server --dev</code>).
          The secret is typed here only because it is the development one; the real product
          mints the token on the server.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void probe()}>
          <Mic className="mr-1 size-3.5" /> Probe capabilities
        </Button>
        <Button size="sm" variant="outline" onClick={() => void probeScreen()}>
          <MonitorUp className="mr-1 size-3.5" /> Ask for the screen
        </Button>
        {checks.length > 0 && (
          <Button size="sm" variant="ghost" onClick={copyReport}>
            Copy report
          </Button>
        )}
      </div>

      {checks.length > 0 && (
        <ul className="divide-y rounded-md border text-xs">
          {checks.map((c) => (
            <li key={c.name} className="flex items-baseline gap-2 px-3 py-1.5">
              <span className={c.state === "ok" ? "text-success" : "text-destructive"}>
                {c.state === "ok" ? "✓" : "✗"}
              </span>
              <span className="w-40 shrink-0 font-medium">{c.name}</span>
              <span className="min-w-0 break-all text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <div className="grid grid-cols-2 gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://localhost:7880" aria-label="LiveKit URL" />
          <Input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="room" aria-label="Room" />
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="api key" aria-label="API key" />
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="secret" type="password" aria-label="API secret" />
          <Input value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="identity" aria-label="Identity" />
          {!connected ? (
            <Button size="sm" onClick={() => void connect()} disabled={busy}>
              {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Video className="mr-1 size-3.5" />}
              Connect and publish mic
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => void hangUp()}>
              <PhoneOff className="mr-1 size-3.5" /> Hang up
            </Button>
          )}
        </div>
        {connected && (
          <p className="text-xs text-muted-foreground">
            Inside: {inside.join(", ") || "only you"} — open{" "}
            <code>https://meet.livekit.io/?tab=custom</code> in a normal browser as a second
            participant to hear yourself.
          </p>
        )}
      </div>

      {/* Los <audio> remotos aterrizan aquí; invisibles, sólo suenan. */}
      <div ref={audios} className="hidden" />
    </div>
  );
}

/**
 * Lo que el motor de voz ha ido apuntando.
 *
 * Existe porque los fallos de abajo no llegan arriba y las versiones se
 * probaban a ciegas: «no se ve nada» podía ser la cámara sin abrir, el portal
 * sin conceder, o una pista que nunca llegó, y no había forma de distinguirlo.
 * Aquí sale en una lista y con un botón para copiarla, para poder pegarla tal
 * cual en un reporte.
 *
 * No se refresca solo: leerlo es un acto deliberado, y un panel que se mueve
 * mientras lo lees es peor que uno quieto con un botón.
 */
function EngineLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);

  const read = () =>
    invoke<string[]>("voice_diagnostics")
      .then(setLines)
      .catch((e) => setLines([`could not read the log: ${e}`]));

  useEffect(() => {
    void read();
  }, []);

  return (
    <div className="space-y-2 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Voice engine log</h2>
        <span className="text-xs text-muted-foreground">{lines.length} lines</span>
        <span className="ml-auto flex gap-2">
          {/* Abrir la cámara aquí mismo y contar tramas. Es el spike metido
              dentro del proceso de la app: si aquí también se cuelga, el
              problema es del entorno; si aquí va, es de nuestro camino de
              captura. Sin eso, las dos explicaciones son igual de creíbles. */}
          <Button
            size="sm"
            variant="outline"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              invoke<string[]>("voice_test_camera")
                .then((r) => setLines((l) => [...l, "— camera test —", ...r]))
                .catch((e) => setLines((l) => [...l, `the test failed: ${e}`]))
                .finally(() => setTesting(false));
            }}
          >
            {testing ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Video className="mr-1 size-3.5" />
            )}
            Test camera
          </Button>
          <Button size="sm" variant="outline" onClick={() => void read()}>
            <RefreshCw className="mr-1 size-3.5" /> Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={lines.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(lines.join("\n"));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <ClipboardCopy className="mr-1 size-3.5" /> {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        What the engine has been noting down: which camera it opened and in what format,
        whether the system granted the screen, who comes and goes. There is nothing to fill
        in — the fields below belong to a different test.
      </p>
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing yet. Join a voice channel, turn the camera on or share your screen and come back.
        </p>
      ) : (
        <ol className="max-h-72 overflow-y-auto rounded-lg border bg-muted/20 p-2 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <li key={i} className="whitespace-pre-wrap">
              {l}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
