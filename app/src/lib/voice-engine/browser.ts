import type * as LK from "livekit-client";

import { recordingFromMetadata } from "@/lib/recording-metadata";

import type { Device, DeviceList, MicReading, VoiceEngine, VoiceEvent } from "./types";

/**
 * El motor del build web (W3): `livekit-client`, en la propia página.
 *
 * Existe para quien no tiene la app —un invitado que llega con un enlace— y
 * para los miembros que abren cac en un navegador. El escritorio sigue con el
 * de Rust; ver `docs/voz.md` §2 y §9.
 *
 * **Habla el idioma de eventos del de Rust**, y es la regla de este fichero:
 * cada evento de LiveKit se traduce al `VoiceEvent` que el store ya entiende,
 * con los mismos nombres —`ParticipantRemoved`, no `PARTICIPANT_REMOVED`—. Si
 * aquí se inventara un dialecto, la pantalla tendría que saber con qué motor
 * habla, y eso es justo lo que se quiere evitar.
 *
 * `livekit-client` se carga **al entrar**, no al importar este fichero: el
 * escritorio lo importa también (ver `index.ts`) y no tiene por qué arrastrarlo.
 */

type LKModule = typeof LK;

/** Cada cuánto se reporta la latencia. La de Rust va al mismo ritmo. */
const LATENCIA_CADA_MS = 2000;

/** Cuánto vive el micrófono de prueba del medidor sin que nadie lo mire. */
const PRUEBA_HASTA_MS = 1500;

export interface BrowserEngine extends VoiceEngine {
  /**
   * Pinta la cámara o la pantalla de alguien en un `<video>`. Devuelve con qué
   * soltarlo. Si la pista todavía no ha llegado, no hace nada: quien lo pinta
   * vuelve a intentarlo cuando `onTracksChanged` avise.
   */
  attachVideo(identity: string, source: "camera" | "screen", el: HTMLVideoElement): (() => void) | null;
  /** Avisa cuando cambian las pistas de vídeo. Devuelve con qué darse de baja. */
  onTracksChanged(cb: () => void): () => void;
}

export function createBrowserEngine(load: () => Promise<LKModule> = () => import("livekit-client")): BrowserEngine {
  let lk: LKModule | null = null;
  let room: LK.Room | null = null;
  let emit: (e: VoiceEvent) => void = () => {};
  let sordo = false;
  // Salir es cosa nuestra: la desconexión que provoca no es un error que
  // enseñar.
  let saliendo = false;
  let reloj: ReturnType<typeof setInterval> | null = null;
  const preferido: { mic?: string; cam?: string } = {};
  const audios = new Map<string, HTMLMediaElement>();
  const oyentes = new Set<() => void>();
  const avisar = () => oyentes.forEach((cb) => cb());

  let medidor: {
    ctx: AudioContext;
    analyser: AnalyserNode;
    track: MediaStreamTrack;
    propia: boolean;
    ultima: number;
  } | null = null;

  const fuenteDe = (s: LK.Track.Source): "camera" | "screen" | "mic" | null => {
    if (!lk) return null;
    if (s === lk.Track.Source.Camera) return "camera";
    if (s === lk.Track.Source.ScreenShare) return "screen";
    if (s === lk.Track.Source.Microphone) return "mic";
    return null;
  };

  /**
   * El motivo de LiveKit con el nombre que le da el de Rust: `ROOM_DELETED` →
   * `RoomDeleted`. Lo que no es un fallo —salir tú, o no saber por qué— es
   * `Unknown`, que el store no enseña.
   */
  const motivo = (r: LK.DisconnectReason | undefined): string => {
    if (r === undefined || !lk) return "Unknown";
    const nombre = (lk.DisconnectReason as unknown as Record<number, string>)[r];
    if (!nombre || nombre === "UNKNOWN_REASON" || nombre === "CLIENT_INITIATED") return "Unknown";
    return nombre
      .toLowerCase()
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  };

  const volumen = (p: LK.RemoteParticipant) => {
    if (!lk) return;
    const v = sordo ? 0 : 1;
    p.setVolume(v, lk.Track.Source.Microphone);
    p.setVolume(v, lk.Track.Source.ScreenShareAudio);
  };

  const conectar = (r: LK.Room, L: LKModule) => {
    const E = L.RoomEvent;
    r.on(E.ParticipantConnected, (p) => {
      emit({ kind: "joined", identity: p.identity, name: p.name || p.identity });
      volumen(p);
    })
      .on(E.ParticipantDisconnected, (p) => {
        emit({ kind: "left", identity: p.identity });
        avisar();
      })
      .on(E.ActiveSpeakersChanged, (quienes) => {
        const yo = r.localParticipant.identity;
        emit({ kind: "speaking", identities: quienes.map((p) => p.identity).filter((id) => id !== yo) });
        emit({ kind: "selfSpeaking", speaking: quienes.some((p) => p.identity === yo) });
      })
      .on(E.TrackMuted, (pub, p) => {
        const f = fuenteDe(pub.source);
        if (f === "mic") emit({ kind: "muted", identity: p.identity, muted: true });
        else if (f === "camera" && p.identity !== r.localParticipant.identity)
          emit({ kind: "video", identity: p.identity, source: "camera", enabled: false });
      })
      .on(E.TrackUnmuted, (pub, p) => {
        const f = fuenteDe(pub.source);
        if (f === "mic") emit({ kind: "muted", identity: p.identity, muted: false });
        else if (f === "camera" && p.identity !== r.localParticipant.identity && pub.track)
          emit({ kind: "video", identity: p.identity, source: "camera", enabled: true });
      })
      .on(E.TrackSubscribed, (track, pub, p) => {
        if (track.kind === L.Track.Kind.Audio) {
          // Las pistas de audio **no suenan solas**: hay que darles un
          // elemento. Fuera de la vista y colgado del `body`, para que
          // cambiar de pantalla no corte a nadie.
          const el = track.attach();
          el.hidden = true;
          document.body.appendChild(el);
          audios.set(pub.trackSid, el);
          volumen(p);
          return;
        }
        const f = fuenteDe(pub.source);
        if (f === "camera" || f === "screen") {
          emit({ kind: "video", identity: p.identity, source: f, enabled: !pub.isMuted });
          avisar();
        }
      })
      .on(E.TrackUnsubscribed, (track, pub, p) => {
        const el = audios.get(pub.trackSid);
        if (el) {
          track.detach(el);
          el.remove();
          audios.delete(pub.trackSid);
          return;
        }
        const f = fuenteDe(pub.source);
        if (f === "camera" || f === "screen") {
          emit({ kind: "video", identity: p.identity, source: f, enabled: false });
          avisar();
        }
      })
      .on(E.LocalTrackPublished, () => avisar())
      .on(E.LocalTrackUnpublished, (pub) => {
        // La pantalla se deja de compartir también desde **el navegador** —su
        // botón de «dejar de compartir»—, y el store tiene que enterarse o el
        // botón de la app se queda encendido.
        const f = fuenteDe(pub.source);
        if (f === "screen" || f === "camera")
          emit({ kind: "video", identity: r.localParticipant.identity, source: f, enabled: false });
        avisar();
      })
      .on(E.RoomMetadataChanged, (md) => emit(recordingEvent(md)))
      .on(E.Disconnected, (r2) => {
        const era = saliendo;
        limpiar();
        if (!era) emit({ kind: "disconnected", reason: motivo(r2) });
      });
  };

  const limpiar = () => {
    if (reloj) clearInterval(reloj);
    reloj = null;
    for (const el of audios.values()) el.remove();
    audios.clear();
    room = null;
    avisar();
  };

  const nombreDe = (kind: MediaDeviceKind): "mic" | "cam" => (kind === "audioinput" ? "mic" : "cam");

  const engine: BrowserEngine = {
    async join({ url, token, onEvent }) {
      emit = onEvent;
      saliendo = false;
      const L = (lk ??= await load());
      const r = new L.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: preferido.mic ? { deviceId: preferido.mic } : undefined,
        videoCaptureDefaults: preferido.cam ? { deviceId: preferido.cam } : undefined,
      });
      room = r;
      conectar(r, L);
      await r.connect(url, token);
      // El clic de «entrar» es el gesto que el navegador exige para sonar.
      // Si aun así no deja, la siguiente interacción lo desbloquea.
      await r.startAudio().catch(() => {});
      try {
        await r.localParticipant.setMicrophoneEnabled(true);
      } catch (e) {
        throw new Error(errorDeMedios(e, "mic"));
      }

      const yo = r.localParticipant.identity;
      emit({ kind: "connected", identity: yo });
      for (const p of r.remoteParticipants.values()) {
        emit({ kind: "joined", identity: p.identity, name: p.name || p.identity });
        const mic = p.getTrackPublication(L.Track.Source.Microphone);
        if (mic) emit({ kind: "muted", identity: p.identity, muted: mic.isMuted });
      }
      // Quien entra con la grabación en marcha lo sabe por aquí, no por un
      // cambio: el metadata ya estaba puesto antes de que llegara.
      emit(recordingEvent(r.metadata));

      reloj = setInterval(() => {
        const rtt = (r as unknown as { engine?: { client?: { rtt?: number } } }).engine?.client?.rtt;
        if (typeof rtt === "number" && rtt > 0) emit({ kind: "latency", ms: Math.round(rtt) });
      }, LATENCIA_CADA_MS);
      return yo;
    },

    // Recargar la página **es** colgar: la sala vivía en ella.
    attach: async () => null,

    async leave() {
      saliendo = true;
      const r = room;
      limpiar();
      await r?.disconnect();
    },

    async setMic(enabled) {
      await room?.localParticipant.setMicrophoneEnabled(enabled);
    },

    async setDeaf(enabled) {
      sordo = enabled;
      for (const p of room?.remoteParticipants.values() ?? []) volumen(p);
      if (enabled) await room?.localParticipant.setMicrophoneEnabled(false);
    },

    async setCamera(enabled) {
      if (!room) throw new Error("voice-not-in-room");
      try {
        await room.localParticipant.setCameraEnabled(enabled, preferido.cam ? { deviceId: preferido.cam } : undefined);
      } catch (e) {
        throw new Error(errorDeMedios(e, "cam"));
      }
      avisar();
    },

    // Elige el diálogo del navegador.
    screenSources: async () => [],

    async shareScreen() {
      if (!room) throw new Error("voice-not-in-room");
      try {
        await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      } catch (e) {
        throw new Error(errorDeMedios(e, "screen"));
      }
      avisar();
    },

    async stopShare() {
      await room?.localParticipant.setScreenShareEnabled(false);
      avisar();
    },

    canShareScreen: () =>
      typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function",

    async listDevices(): Promise<DeviceList> {
      const todos = await navigator.mediaDevices.enumerateDevices();
      const de = (kind: MediaDeviceKind): Device[] => {
        const activo = room?.getActiveDevice(kind) ?? preferido[nombreDe(kind)];
        const lista = todos.filter((d) => d.kind === kind);
        return lista.map((d, i) => ({
          id: d.deviceId,
          // Sin permiso el navegador no da nombres; un número es mejor que
          // una fila vacía.
          name: d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`,
          current: activo ? d.deviceId === activo : d.deviceId === "default" || i === 0,
        }));
      };
      return { mics: de("audioinput"), cams: de("videoinput") };
    },

    async setDevice(kind, deviceId) {
      preferido[kind] = deviceId;
      if (room) await room.switchActiveDevice(kind === "mic" ? "audioinput" : "videoinput", deviceId);
      // El medidor escucha el micrófono viejo; se rehace con el nuevo.
      if (kind === "mic") soltarMedidor();
    },

    async micLevel(): Promise<MicReading> {
      try {
        const m = await abrirMedidor();
        m.ultima = Date.now();
        const datos = new Float32Array(m.analyser.fftSize);
        m.analyser.getFloatTimeDomainData(datos);
        let pico = 0;
        for (const v of datos) pico = Math.max(pico, Math.abs(v));
        const ajustes = m.track.getSettings();
        const ritmo = m.ctx.sampleRate;
        return {
          enLlamada: !!room,
          picoMilesimas: Math.round(Math.min(1, pico) * 1000),
          formatoEntrada: {
            dispositivo: m.track.label,
            ritmo,
            canales: ajustes.channelCount ?? 1,
            formato: "f32",
            ritmoDeLaFuente: ajustes.sampleRate ?? ritmo,
            coincide: true,
          },
          error: null,
        };
      } catch (e) {
        return { enLlamada: !!room, picoMilesimas: 0, formatoEntrada: null, error: errorDeMedios(e, "mic") };
      }
    },

    attachVideo(identity, source, el) {
      if (!room || !lk) return null;
      const p =
        identity === room.localParticipant.identity
          ? room.localParticipant
          : room.remoteParticipants.get(identity);
      const pub = p?.getTrackPublication(source === "camera" ? lk.Track.Source.Camera : lk.Track.Source.ScreenShare);
      const track = pub?.track;
      if (!track) return null;
      track.attach(el);
      return () => {
        track.detach(el);
      };
    },

    onTracksChanged(cb) {
      oyentes.add(cb);
      return () => {
        oyentes.delete(cb);
      };
    },
  };

  /**
   * El medidor escucha la pista que se publica, si hay llamada; si no, abre un
   * micrófono de prueba que se cierra solo cuando nadie lo mira. Es lo que hace
   * el de Rust (`PRUEBA_HASTA`) y por lo mismo: no hay comando de parar.
   */
  async function abrirMedidor() {
    const enSala =
      room && lk
        ? room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack
        : undefined;
    if (medidor && (medidor.track === enSala || (!enSala && medidor.propia)) && medidor.track.readyState === "live")
      return medidor;
    soltarMedidor();
    const track =
      enSala ??
      (
        await navigator.mediaDevices.getUserMedia({
          audio: preferido.mic ? { deviceId: { exact: preferido.mic } } : true,
        })
      ).getAudioTracks()[0];
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    medidor = { ctx, analyser, track, propia: !enSala, ultima: Date.now() };
    const m = medidor;
    const vigilar = setInterval(() => {
      if (medidor !== m) return clearInterval(vigilar);
      if (Date.now() - m.ultima > PRUEBA_HASTA_MS) {
        clearInterval(vigilar);
        soltarMedidor();
      }
    }, 500);
    return medidor;
  }

  function soltarMedidor() {
    if (!medidor) return;
    // La pista de la sala no es nuestra: pararla te dejaría sin micrófono.
    if (medidor.propia) medidor.track.stop();
    void medidor.ctx.close().catch(() => {});
    medidor = null;
  }

  return engine;
}

/** El evento de grabación que corresponde a un metadata, encendido o apagado. */
export function recordingEvent(raw: string | undefined): VoiceEvent {
  const r = recordingFromMetadata(raw);
  return r
    ? { kind: "recording", active: true, ...r }
    : { kind: "recording", active: false, id: "", by: "", since: "" };
}

/**
 * Lo que dijo el navegador, con las etiquetas que la app ya sabe traducir.
 * Un permiso negado no es lo mismo que no tener el aparato, y quien lo lee
 * tiene que saber cuál de los dos arreglar.
 */
function errorDeMedios(e: unknown, que: "mic" | "cam" | "screen"): string {
  const nombre = (e as { name?: string })?.name;
  if (nombre === "NotAllowedError" || nombre === "SecurityError") {
    return que === "mic" ? "voice-mic-denied-web" : que === "cam" ? "voice-camera-denied-web" : "voice-share-cancelled";
  }
  if (nombre === "NotFoundError" || nombre === "OverconstrainedError") {
    return que === "mic" ? "voice-no-mic" : que === "cam" ? "voice-no-camera" : "voice-no-screen-capture";
  }
  if (nombre === "NotReadableError") return que === "mic" ? "voice-mic-busy" : "voice-camera-busy";
  return e instanceof Error ? e.message : String(e);
}

/** El de la build web. Uno por página, como la sala. */
export const browserEngine = createBrowserEngine();
