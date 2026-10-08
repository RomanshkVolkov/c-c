/**
 * El contrato entre la pantalla de la llamada y el motor que la mueve.
 *
 * Hay dos motores desde W3. En el escritorio, el de Rust (`tauri.ts`), porque
 * el webview de Linux no tiene WebRTC: ver `docs/voz.md` §1-2. En el build web,
 * `livekit-client` (`browser.ts`), porque quien entra desde un enlace no tiene
 * la app. **Hablan el mismo idioma de eventos**, y esa es la única defensa
 * contra las «dos superficies de bugs» que se temían al decidir el nativo: el
 * store y la pantalla no saben cuál de los dos tienen debajo.
 */

export type VoiceEvent =
  | { kind: "connected"; identity: string }
  | { kind: "joined"; identity: string; name: string }
  | { kind: "left"; identity: string }
  | { kind: "speaking"; identities: string[] }
  | { kind: "muted"; identity: string; muted: boolean }
  | { kind: "latency"; ms: number }
  | { kind: "video"; identity: string; source: "camera" | "screen"; enabled: boolean }
  | { kind: "selfSpeaking"; speaking: boolean }
  // Se está grabando, o se ha dejado de grabar. Sale del metadata de la sala,
  // así que llega también a quien entra tarde — ver `voice.rs` y
  // `recording-metadata.ts`.
  | { kind: "recording"; active: boolean; id: string; by: string; since: string }
  // `reason` va con los nombres del motor de Rust (`ParticipantRemoved`,
  // `RoomDeleted`…): el del navegador los traduce a esos mismos.
  | { kind: "disconnected"; reason: string };

/**
 * De qué es la llamada. Se le da al motor al entrar y el motor la devuelve al
 * engancharse tras una recarga: la página nueva no tiene otra forma de saber
 * dónde estabas —el SFU sabe la sala, no el canal ni la organización—.
 */
export interface VoiceMeta {
  /** El canal, si la llamada es la de un canal o una reunión que cuelga de él. */
  spaceId: string | null;
  orgId: string | null;
  spaceName: string | null;
  /** La reunión con invitados (`meet:<id>`), si es una. */
  meetId?: string | null;
  /** El título de la reunión, para la cabecera. */
  title?: string | null;
}

/** Lo que contesta el motor al engancharse a una llamada en curso. */
export interface Reattach {
  meta: Partial<VoiceMeta> | null;
  yo: string;
  silenciado: boolean;
  sordo: boolean;
  camara: boolean;
  compartiendo: boolean;
}

export interface Device {
  id: string;
  name: string;
  current: boolean;
}

export interface DeviceList {
  mics: Device[];
  cams: Device[];
}

/** El formato con el que se abrió de verdad el micrófono. */
export interface MicFormat {
  dispositivo: string;
  ritmo: number;
  canales: number;
  formato: string;
  ritmoDeLaFuente: number;
  coincide: boolean;
}

/** Una lectura del medidor del micrófono. */
export interface MicReading {
  enLlamada: boolean;
  picoMilesimas: number;
  formatoEntrada: MicFormat | null;
  error: string | null;
}

export interface VoiceEngine {
  /** Entra a la sala. Devuelve tu identidad. */
  join(a: { url: string; token: string; meta: VoiceMeta; onEvent: (e: VoiceEvent) => void }): Promise<string>;
  /**
   * Engancharse a la llamada que ya estaba en curso, tras recargar la página.
   * `null` si no hay ninguna. En el navegador siempre `null`: recargar la
   * página **es** colgar, porque la sala vivía en ella.
   */
  attach(onEvent: (e: VoiceEvent) => void): Promise<Reattach | null>;
  leave(): Promise<void>;
  setMic(enabled: boolean): Promise<void>;
  setDeaf(enabled: boolean): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  /**
   * Las pantallas entre las que elegir. Vacío cuando elige otro —el diálogo
   * del sistema en Wayland, el del navegador en la web—.
   */
  screenSources(): Promise<{ id: string; title: string }[]>;
  shareScreen(sourceId: string | null): Promise<void>;
  stopShare(): Promise<void>;
  /** Si este motor puede compartir pantalla aquí. Un móvil no puede. */
  canShareScreen(): boolean;
  listDevices(): Promise<DeviceList>;
  setDevice(kind: "mic" | "cam", deviceId: string): Promise<void>;
  micLevel(): Promise<MicReading>;
}
