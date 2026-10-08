import { describe, expect, it, vi } from "vitest";

import { createBrowserEngine } from "./browser";
import type { VoiceEvent } from "./types";

/**
 * Un `livekit-client` de mentira, con lo justo para que el motor hable con él:
 * una sala que guarda sus oyentes para poder dispararlos desde la prueba.
 */
const Source = { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" };
const RoomEvent = {
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  RoomMetadataChanged: "roomMetadataChanged",
  Disconnected: "disconnected",
};
// Un enum numérico de TS, con su vuelta: así lo trae `livekit-client`.
const DisconnectReason: Record<string | number, string | number> = {};
for (const [n, v] of [["UNKNOWN_REASON", 0], ["CLIENT_INITIATED", 1], ["PARTICIPANT_REMOVED", 4], ["ROOM_DELETED", 5]] as const) {
  DisconnectReason[n] = v;
  DisconnectReason[v] = n;
}

function remoto(identity: string, name = identity) {
  return { identity, name, setVolume: vi.fn(), getTrackPublication: () => undefined };
}

class FakeRoom {
  static last: FakeRoom;
  handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  metadata = "";
  remoteParticipants = new Map<string, ReturnType<typeof remoto>>();
  localParticipant = {
    identity: "u-ana",
    setMicrophoneEnabled: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    setScreenShareEnabled: vi.fn(async () => {}),
    getTrackPublication: () => undefined,
  };
  constructor() {
    FakeRoom.last = this;
  }
  on(ev: string, cb: (...a: unknown[]) => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
    return this;
  }
  fire(ev: string, ...a: unknown[]) {
    for (const cb of this.handlers.get(ev) ?? []) cb(...a);
  }
  connect = vi.fn(async () => {});
  startAudio = vi.fn(async () => {});
  disconnect = vi.fn(async () => this.fire(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED));
  getActiveDevice = () => undefined;
  switchActiveDevice = vi.fn(async () => true);
}

const fakeLK = {
  Room: FakeRoom,
  RoomEvent,
  DisconnectReason,
  Track: { Source, Kind: { Audio: "audio", Video: "video" } },
};

async function entrar(antes?: (r: FakeRoom) => void) {
  const eventos: VoiceEvent[] = [];
  const engine = createBrowserEngine(async () => fakeLK as never);
  // La sala se crea dentro de `join`; lo que ya había antes de conectar se
  // prepara en cuanto existe, antes de que `connect` conteste.
  const p = engine.join({
    url: "wss://rtc.example",
    token: "jwt",
    meta: { spaceId: null, orgId: null, spaceName: null },
    onEvent: (e) => eventos.push(e),
  });
  await Promise.resolve();
  await Promise.resolve();
  if (antes) antes(FakeRoom.last);
  const yo = await p;
  return { engine, eventos, room: FakeRoom.last, yo };
}

describe("el motor del navegador", () => {
  // Quien entra con la grabación en marcha no ve ningún «cambio» del
  // metadata: ya estaba puesto. El mutante que mata: no leer el inicial.
  it("quien llega tarde ve el REC que ya estaba", async () => {
    const { eventos } = await entrar((r) => {
      r.metadata = JSON.stringify({ recording: { id: "rec-1", by: "u-bea", since: "2026-10-08T00:00:00Z" } });
    });
    expect(eventos).toContainEqual({
      kind: "recording", active: true, id: "rec-1", by: "u-bea", since: "2026-10-08T00:00:00Z",
    });
  });

  // Los nombres de los motivos son los del motor de Rust: el store sólo
  // conoce ésos. El mutante que mata: emitir `PARTICIPANT_REMOVED` tal cual.
  it("que te saquen se dice como lo dice el motor de escritorio", async () => {
    const { eventos, room } = await entrar();
    room.fire(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    expect(eventos[eventos.length - 1]).toEqual({ kind: "disconnected", reason: "ParticipantRemoved" });
  });

  // Salir tú no es un error que enseñar.
  it("salir no avisa de nada", async () => {
    const { engine, eventos } = await entrar();
    const antes = eventos.length;
    await engine.leave();
    expect(eventos.slice(antes).filter((e) => e.kind === "disconnected")).toEqual([]);
  });

  // «Quién habla» es de los demás; lo tuyo va aparte. Mezclarlos encendería
  // tu propio recuadro con el criterio del servidor (ver `hablandoYo`).
  it("quién habla no te incluye, y lo tuyo va aparte", async () => {
    const { eventos, room } = await entrar();
    room.fire(RoomEvent.ActiveSpeakersChanged, [{ identity: "u-ana" }, { identity: "guest:g1" }]);
    expect(eventos).toContainEqual({ kind: "speaking", identities: ["guest:g1"] });
    expect(eventos).toContainEqual({ kind: "selfSpeaking", speaking: true });
  });

  // El audio de los demás no suena solo: necesita un elemento. Sin esto la
  // llamada conecta y no se oye a nadie.
  it("el audio de los demás se cuelga de la página para que suene", async () => {
    const { room } = await entrar();
    const el = document.createElement("audio");
    const track = { kind: "audio", attach: vi.fn(() => el), detach: vi.fn() };
    const p = remoto("guest:g1");
    room.fire(RoomEvent.TrackSubscribed, track, { trackSid: "TR_1", source: Source.Microphone }, p);
    expect(track.attach).toHaveBeenCalled();
    expect(document.body.contains(el)).toBe(true);
    room.fire(RoomEvent.TrackUnsubscribed, track, { trackSid: "TR_1", source: Source.Microphone }, p);
    expect(document.body.contains(el)).toBe(false);
  });

  // Sordo es no oír a nadie, tampoco a quien entra después.
  it("con la sordera puesta, quien entra llega en silencio", async () => {
    const { engine, room } = await entrar();
    await engine.setDeaf(true);
    const p = remoto("guest:g2");
    room.fire(RoomEvent.ParticipantConnected, p);
    expect(p.setVolume).toHaveBeenCalledWith(0, Source.Microphone);
  });

  // Dejar de compartir desde el navegador tiene que llegar al store.
  it("tu pantalla retirada desde el navegador se avisa", async () => {
    const { eventos, room } = await entrar();
    room.fire(RoomEvent.LocalTrackUnpublished, { source: Source.ScreenShare });
    expect(eventos[eventos.length - 1]).toEqual({ kind: "video", identity: "u-ana", source: "screen", enabled: false });
  });

  // Los que ya estaban dentro aparecen al entrar, con su nombre.
  it("los que ya estaban aparecen al entrar", async () => {
    const { eventos } = await entrar((r) => {
      r.remoteParticipants.set("guest:g1", remoto("guest:g1", "Ana López"));
    });
    expect(eventos).toContainEqual({ kind: "joined", identity: "guest:g1", name: "Ana López" });
  });
});
