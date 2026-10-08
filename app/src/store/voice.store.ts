import { phraseFor } from "@/lib/server-errors";
import { create } from "zustand";
import { api } from "@/lib/api";
import { engine, type Reattach, type VoiceEvent, type VoiceMeta } from "@/lib/voice-engine";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import type { APIResponse } from "@/types/auth";

/**
 * La sala de voz en la que estás, y quién está contigo.
 *
 * Aquí no hay media: sólo el estado que la pantalla pinta y las órdenes que se
 * le mandan al motor. En el escritorio el motor vive en Rust —el webview de
 * Linux no tiene WebRTC, ver `docs/voz.md`—; en el build web es
 * `livekit-client` (W3). El store no sabe cuál tiene debajo: los dos hablan el
 * mismo idioma de eventos (`lib/voice-engine`). Lo que se puede probar sin un
 * navegador de verdad vive aquí.
 */

export type { VoiceEvent, VoiceMeta };

/** Quién está recording esta llamada, para el chip REC. */
export interface Recording {
  id: string;
  by: string;
  since: string;
}

export interface VoicePeer {
  identity: string;
  name: string;
}

/** Lo que llega por el stream de eventos cuando alguien te llama. */
export interface TimbreEntrante {
  ringId: string;
  spaceId: string;
  /** La org del canal: te puede llamar alguien de otra. */
  orgId?: string;
  spaceName: string;
  from: { id: string; name: string };
  /** ISO. Pasada esa hora la tarjeta se va sola, llame quien llame. */
  expiresAt: string;
  /**
   * Te llaman a una reunión con invitados, no a la sala del canal. Aceptar
   * lleva a esa reunión; `spaceId` sólo dice de qué canal cuelga.
   */
  inviteId?: string;
  title?: string;
}

/** Una llamada tuya que todavía no ha contestado nadie. */
export interface TimbreSaliente {
  identity: string;
  name: string;
  /** Cuándo empezó a sonar, para el contador de la pantalla. */
  desde: number;
  /** Se rindió: veinte segundos sin respuesta, o el otro lado dijo que no. */
  sinRespuesta: boolean;
}

/**
 * Cuánto suena un timbre antes de rendirse. **Tiene que coincidir con
 * `service.TimbreTTL` del backend**, que es quien pone el `expiresAt`.
 *
 * El tope vive en los dos lados a propósito: el servidor no guarda el timbre en
 * ninguna parte —es un evento, no un registro— así que no hay nadie vigilando
 * el reloj. Cada extremo se rinde por su cuenta, y por eso un timbre sobrevive
 * a que la app de quien llamaba se cierre de golpe.
 */
export const TIMBRE_MS = 20_000;

/** La entrada a una reunión con invitados, como la da el servidor. */
export interface MeetToken {
  url: string;
  token: string;
  room: string;
  orgId: string;
  spaceId?: string | null;
  inviteId: string;
  title: string;
}

/** La entrada de alguien de fuera, como la da la puerta pública. */
export interface GuestEntry {
  url: string;
  token: string;
  room: string;
  identity: string;
  name: string;
  pass: string;
  title: string;
}

/**
 * Los motivos de desconexión que se le dicen a alguien, con su frase.
 *
 * Antes se enseñaba el motivo crudo del motor, y echar a un invitado le habría
 * dejado leyendo «ParticipantRemoved». Los que no son un fallo —salir tú, o no
 * saber por qué— no se enseñan.
 */
const MOTIVOS: Record<string, string | null> = {
  Unknown: null,
  UnknownReason: null,
  ClientInitiated: null,
  ParticipantRemoved: "voice-removed",
  RoomDeleted: "voice-room-closed",
  DuplicateIdentity: "voice-joined-elsewhere",
};

function motivoDeSalida(reason: string): string | null {
  if (!(reason in MOTIVOS)) return reason;
  const codigo = MOTIVOS[reason];
  return codigo ? phraseFor(codigo, reason) : null;
}

interface VoiceState {
  /**
   * El canal cuya sala está abierta, o null. Una sala a la vez.
   *
   * **En una reunión con invitados es null**, aunque la reunión cuelgue de un
   * canal: la sala no es la del canal, y todo lo que mira esto —el botón de
   * entrar de cada canal, el escenario dentro del canal— tiene que ver que no
   * estás en él. El canal de la reunión va en `meetSpaceId`.
   */
  spaceId: string | null;
  /** La reunión con invitados en la que estás (`meet:<id>`), o null. */
  meetId: string | null;
  /** El canal del que cuelga la reunión: su chat y sus grabaciones. */
  meetSpaceId: string | null;
  /** El título de la reunión, para la cabecera. */
  title: string | null;
  /**
   * Entraste como alguien de fuera, con un enlace. Sin cuenta: nada de lo que
   * necesita sesión —chat, timbre, grabar, echar— se ofrece.
   */
  visitor: boolean;
  /**
   * La organización y el nombre del canal de la llamada.
   *
   * Aparte del árbol a propósito: la llamada sigue al cambiar de
   * organización, y entonces el árbol es el de otra org y ya no sabe ni cómo
   * se llama el canal.
   */
  orgId: string | null;
  spaceName: string | null;
  /** "entrando" mientras se pide el token y se conecta. */
  estado: "fuera" | "entrando" | "dentro";
  /**
   * ¿Está abierta la pantalla de la sala?
   *
   * Estar conectado y estar mirando la llamada son dos cosas distintas, y con
   * un solo booleano no se pueden distinguir: minimizar acabaría colgando. Con
   * `estado` se sabe si el micrófono está abierto; con esto, si la sala ocupa
   * la pantalla. Salir apaga los dos; minimizar sólo éste.
   */
  escenario: boolean;
  /** Quién está dentro, tú incluido. */
  gente: VoicePeer[];
  /** Quién habla ahora mismo, **de los demás**. Lo decide el servidor. */
  hablando: string[];
  /**
   * Si estás hablando tú, medido de tu propio micrófono.
   *
   * Aparte de `hablando` a propósito: aquélla es la lista que manda el
   * servidor, tarda su medio segundo en decidirse y puede no incluirte nunca
   * según cómo esté configurado el SFU. Tu recuadro no debe depender de que un
   * servidor opine sobre lo que pasa en tu mesa — en la v1.6.38 no se encendía
   * nunca por eso.
   */
  hablandoYo: boolean;
  /**
   * Quién tiene el micrófono cerrado, por identidad.
   *
   * Un mapa y no una lista porque «no sé nada de esta persona» y «esta persona
   * está abierta» no son lo mismo: hasta que el motor reporta su pista, la
   * pantalla no debe afirmar ninguna de las dos.
   */
  mudos: Record<string, boolean>;
  /** Ida y vuelta al SFU en milisegundos, o null mientras no se sepa. */
  latencia: number | null;
  /**
   * Quién tiene la cámara encendida.
   *
   * Sólo dice que hay pista, no que haya llegado una trama. El mosaico pone el
   * lienzo con esto y el avatar se queda debajo hasta que se pinte algo: entre
   * suscribirse y la primera imagen pasa medio segundo, y un rectángulo negro
   * durante medio segundo se lee como una cámara rota.
   */
  video: Record<string, boolean>;
  /**
   * Quién está compartiendo pantalla, o null.
   *
   * Uno solo y no un mapa: en el escenario cabe una pantalla grande, y si dos
   * comparten a la vez hay que elegir cuál se mira. Se queda la primera —
   * cambiar el foco solo, porque alguien más empezó a compartir, es quitarte de
   * delante lo que estabas leyendo.
   */
  pantalla: string | null;
  /** Tu propia pantalla compartida. */
  compartiendo: boolean;
  /**
   * Las pantallas entre las que elegir, mientras se pregunta cuál compartir.
   * Sólo con más de una y donde elige la app (X11, Windows, macOS): en
   * Wayland pregunta el diálogo del sistema.
   */
  eligiendoPantalla: { id: string; title: string }[] | null;
  /** A quién estás llamando y todavía no contesta. */
  llamando: TimbreSaliente | null;
  /** Quién te llama a ti. */
  entrante: TimbreEntrante | null;
  yo: string | null;
  mic: boolean;
  /** Sordera: ni oyes ni te oyen. */
  sordo: boolean;
  /** Tu cámara. */
  cam: boolean;
  /**
   * Quién está recording esta llamada, o `null`.
   *
   * No lo pone el botón: lo pone **el motor**, cuando el SFU dice que el
   * metadata de la sala cambió. Por eso enciende el chip en todas las pantallas
   * a la vez —incluida la de quien entra después— y por eso pulsar «grabar» no
   * lo enciende hasta que el servidor lo confirma.
   */
  recording: Recording | null;
  error: string | null;
  /**
   * De qué canal es el error, para no pintarlos todos de rojo.
   *
   * `error` es uno solo para toda la sala, y el botón de entrar de **cada**
   * canal lo leía: un fallo al encender la cámara dejaba media lista en rojo
   * con un mensaje que allí no significaba nada. Con esto, cada botón enseña lo
   * suyo y calla lo ajeno.
   */
  errorSpaceId: string | null;
  /** Descartar el aviso. Ver el botón de cerrar del cartel. */
  limpiarError: () => void;
  /**
   * Quién está en cada canal de voz, **sin haber entrado**.
   *
   * Es lo que rompe el círculo del canal vacío: si no ves que hay alguien
   * dentro no entras, y si nadie entra nunca hay a quien ver.
   *
   * Se pregunta al servidor y él al SFU, en vez de llevar la cuenta por aquí:
   * un recuento propio se desincroniza con el primer evento perdido y entonces
   * la lista miente sin que nada falle.
   */
  ocupacion: Record<string, VoicePeer[]>;

  /**
   * Entrar a la sala de un canal. `donde` hace falta cuando el canal no es de
   * la org que está en pantalla —aceptar un timbre de otra—; sin él, se toman
   * la org actual y el nombre del árbol.
   */
  entrar: (spaceId: string, donde?: { orgId?: string | null; spaceName?: string | null }) => Promise<void>;
  /** Entrar a una reunión con invitados, como miembro. */
  entrarEnReunion: (inviteId: string) => Promise<void>;
  /** Entrar a una reunión como invitado, con lo que dio la puerta pública. */
  entrarComoInvitado: (entrada: GuestEntry) => Promise<void>;
  /**
   * Engancharse a la llamada que ya estaba en curso, tras recargar la página.
   *
   * La sala vive en el proceso de Rust y no se enteró de la recarga: el
   * micrófono seguía abierto y nada en pantalla lo decía. Se llama una vez al
   * arrancar.
   */
  reanudar: () => Promise<void>;
  salir: () => Promise<void>;
  /** Volver a la llamada sin reconectar: sólo abre la pantalla. */
  abrirEscenario: () => void;
  /** Minimizar. No cuelga: el audio sigue. */
  cerrarEscenario: () => void;
  alternarMic: () => Promise<void>;
  alternarSordera: () => Promise<void>;
  alternarCam: () => Promise<void>;
  alternarCompartir: () => Promise<void>;
  /** Compartir la pantalla elegida en el selector. */
  compartirPantalla: (sourceId: string | null) => Promise<void>;
  cancelarEleccionPantalla: () => void;
  /** Refresca quién anda por los canales. La pantalla decide cada cuánto. */
  refrescarOcupacion: (orgId?: string | null) => Promise<void>;
  /** Lo que reporta el motor. Público para poder probarlo sin Tauri. */
  alRecibir: (ev: VoiceEvent) => void;

  /** Hacer sonar el escritorio de un compañero para que entre a esta sala. */
  timbrar: (userId: string, nombre: string) => Promise<void>;
  /** Dejar de llamar. También sirve para quitar el «no contestó» de en medio. */
  cancelarTimbre: () => Promise<void>;
  /** Te llaman. Lo invoca el stream de eventos. */
  alTimbrar: (t: TimbreEntrante) => void;
  /** El que llamaba colgó, o rechazaste tú y el eco vuelve. */
  alColgarTimbre: (de: string) => void;
  aceptarEntrante: () => Promise<void>;
  rechazarEntrante: () => Promise<void>;
}

const VACIO = {
  spaceId: null,
  meetId: null,
  meetSpaceId: null,
  title: null,
  visitor: false,
  orgId: null,
  spaceName: null,
  estado: "fuera" as const,
  escenario: false,
  gente: [],
  hablando: [],
  hablandoYo: false,
  mudos: {},
  latencia: null,
  video: {},
  pantalla: null,
  compartiendo: false,
  eligiendoPantalla: null,
  llamando: null,
  yo: null,
  mic: true,
  sordo: false,
  cam: false,
  // Salir de la sala apaga el chip. Está en `VACIO` a propósito: si se quedara
  // fuera, el punto rojo de la última llamada seguiría encendido en la
  // siguiente, que es la clase de mentira que nadie se para a comprobar.
  recording: null,
  error: null,
  errorSpaceId: null,
};

/**
 * Los dos relojes del timbre, fuera del store.
 *
 * No son estado que nadie pinte —lo que se pinta es `sinRespuesta` y que la
 * tarjeta esté o no— y meterlos dentro obligaría a arrastrar identificadores de
 * temporizador por el `set` y a acordarse de no serializarlos nunca.
 */
let relojSaliente: ReturnType<typeof setTimeout> | null = null;
let relojEntrante: ReturnType<typeof setTimeout> | null = null;

function pararReloj(cual: "saliente" | "entrante") {
  const r = cual === "saliente" ? relojSaliente : relojEntrante;
  if (r) clearTimeout(r);
  if (cual === "saliente") relojSaliente = null;
  else relojEntrante = null;
}

/**
 * Lo que devuelve el motor de voz, en el idioma de quien lo lee.
 *
 * El proceso de Rust ya no manda frases sino **etiquetas** —`voice-no-mic`—,
 * por el mismo motivo que el servidor: quien las escribió pensaba en castellano
 * y salían en castellano dentro de una aplicación en inglés. La etiqueta es la
 * clave del catálogo, así que la frase la pone quien la va a leer.
 *
 * Se reutiliza `phraseFor`, que ya sabe la regla importante: una etiqueta que
 * esta versión no conozca se queda con el texto que llegó, no con la etiqueta
 * cruda. El motor y la interfaz se despliegan juntos, pero no siempre — un
 * binario viejo con una app nueva es un estado real.
 */
function deRust(e: unknown): string {
  const crudo = e instanceof Error ? e.message : String(e);
  return phraseFor(crudo, crudo);
}

/**
 * Cada entrada lleva su número. Si mientras conecta se pulsa «salir» —o se
 * entra a otra—, el número ya no es el último y la conexión que llega tarde se
 * cuelga en vez de dejar un micrófono abierto donde nadie lo ve.
 */
let intento = 0;

/**
 * A dónde va el timbre de la sala en la que estás: la del canal, o la de la
 * reunión. Una reunión no es la sala de ningún canal, y llamar a alguien «al
 * canal» desde ella le llevaría a otra parte.
 */
function rutaDelTimbre(s: { spaceId: string | null; meetId: string | null }): string | null {
  // Un invitado no llega aquí con nada: no conoce ni el canal ni el id de la
  // reunión (`entrarComoInvitado` no los pone), así que no tiene a dónde llamar.
  if (s.meetId) return `/api/v1/call-invites/${s.meetId}/ring`;
  if (s.spaceId) return `/api/v1/task-spaces/${s.spaceId}/voice/ring`;
  return null;
}

export const useVoice = create<VoiceState>((set, get) => {
  /** Conectar con un token ya pedido. Común a canal, reunión e invitado. */
  const conectar = async (
    url: string,
    token: string,
    meta: VoiceMeta,
    mio: number,
    errorSpaceId: string | null,
  ) => {
    try {
      const yo = await engine.join({ url, token, meta, onEvent: (ev) => get().alRecibir(ev) });
      if (mio !== intento) {
        void engine.leave().catch(() => {});
        return;
      }
      set({ estado: "dentro", yo, mic: true });
    } catch (e) {
      if (mio !== intento) return;
      set({ ...VACIO, error: deRust(e), errorSpaceId });
      void engine.leave().catch(() => {});
    }
  };

  return {
  ...VACIO,
  entrante: null,
  // Fuera de `VACIO` a propósito: salir de una sala no vacía los demás canales.
  ocupacion: {},

  entrar: async (spaceId, donde) => {
    // Ya dentro de ésta: no se reconecta. Volver a entrar cortaría la
    // conversación en curso para dejarla exactamente igual.
    if (get().spaceId === spaceId && get().estado !== "fuera") return;
    // En otra: se sale primero. Dos micrófonos abiertos a la vez es un fallo
    // que sólo se nota cuando alguien te oye desde donde no estabas.
    if (get().estado !== "fuera") await get().salir();
    const mio = ++intento;

    // El escenario se abre ya, mientras conecta: entrar a una llamada lleva un
    // segundo largo y sin nada que mirar parece que el botón no hizo nada.
    const meta: VoiceMeta = {
      spaceId,
      orgId: donde?.orgId ?? useOrgsStore.getState().currentOrgId,
      spaceName: donde?.spaceName ?? useTasksStore.getState().tree.find((e) => e.id === spaceId)?.name ?? null,
    };
    set({ ...VACIO, spaceId, orgId: meta.orgId, spaceName: meta.spaceName, estado: "entrando", escenario: true });
    let res: APIResponse<{ url: string; token: string; room: string }>;
    try {
      res = await api.post<APIResponse<{ url: string; token: string; room: string }>>(
        `/api/v1/task-spaces/${spaceId}/voice/token`,
        {},
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "no se pudo pedir la entrada");
    } catch (e) {
      if (mio === intento) set({ ...VACIO, error: deRust(e), errorSpaceId: spaceId });
      return;
    }
    // Puede haberse pulsado «salir» mientras se pedía; entonces esto ya no es
    // la sala actual y entrar dejaría un micrófono abierto.
    if (mio !== intento) return;
    await conectar(res.data.url, res.data.token, meta, mio, spaceId);
  },

  entrarEnReunion: async (inviteId) => {
    if (get().meetId === inviteId && get().estado !== "fuera") return;
    if (get().estado !== "fuera") await get().salir();
    const mio = ++intento;
    set({ ...VACIO, meetId: inviteId, estado: "entrando", escenario: true });
    let t: MeetToken;
    try {
      const res = await api.post<APIResponse<MeetToken>>(`/api/v1/call-invites/${inviteId}/voice/token`, {}, true);
      if (!res.success || !res.data) throw new Error(res.error ?? "no se pudo pedir la entrada");
      t = res.data;
    } catch (e) {
      if (mio === intento) set({ ...VACIO, error: deRust(e) });
      return;
    }
    if (mio !== intento) return;
    const meta: VoiceMeta = {
      spaceId: null,
      orgId: t.orgId,
      spaceName: null,
      meetId: inviteId,
      title: t.title,
    };
    set({ orgId: t.orgId, title: t.title, meetSpaceId: t.spaceId ?? null });
    await conectar(t.url, t.token, meta, mio, null);
  },

  entrarComoInvitado: async (entrada) => {
    if (get().estado !== "fuera") await get().salir();
    const mio = ++intento;
    set({ ...VACIO, visitor: true, title: entrada.title, estado: "entrando", escenario: true });
    const meta: VoiceMeta = { spaceId: null, orgId: null, spaceName: null, title: entrada.title };
    await conectar(entrada.url, entrada.token, meta, mio, null);
  },

  reanudar: async () => {
    if (get().estado !== "fuera") return;
    // Los eventos de la instantánea llegan **mientras** `voice_attach` no ha
    // contestado todavía, y el `set` de abajo arranca de `VACIO`: aplicados
    // antes, se los comería. Se guardan y se aplican después.
    const pendientes: VoiceEvent[] = [];
    let listo = false;

    let r: Reattach | null;
    try {
      r = await engine.attach((ev) => (listo ? get().alRecibir(ev) : pendientes.push(ev)));
    } catch {
      return; // un motor viejo sin `voice_attach`: no hay a qué engancharse
    }
    if (!r) return;

    const spaceId = r.meta?.spaceId ?? null;
    const meetId = r.meta?.meetId ?? null;
    if (!spaceId && !meetId) {
      // Una sala viva de la que no se sabe el canal ni la reunión no se puede
      // enseñar, y una que no se enseña es un micrófono abierto a escondidas.
      // Se cuelga.
      await engine.leave().catch(() => {});
      return;
    }
    set({
      ...VACIO,
      spaceId,
      meetId,
      title: r.meta?.title ?? null,
      orgId: r.meta?.orgId ?? null,
      spaceName: r.meta?.spaceName ?? null,
      estado: "dentro",
      // Minimizada: recargar no es pedir la sala a pantalla completa, y la
      // barra lateral ya dice que sigues dentro.
      escenario: false,
      yo: r.yo,
      mic: !r.silenciado,
      sordo: r.sordo,
      cam: r.camara,
      compartiendo: r.compartiendo,
    });
    listo = true;
    for (const ev of pendientes) get().alRecibir(ev);
  },

  salir: async () => {
    // Colgar mientras llamas a alguien tiene que callarle el teléfono: si no,
    // le sigue sonando veinte segundos una invitación a una sala vacía.
    if (get().llamando) await get().cancelarTimbre();
    pararReloj("saliente");
    intento++;
    set({ ...VACIO });
    await engine.leave().catch(() => {});
  },

  abrirEscenario: () => {
    // Sin sala no hay nada que enseñar, y un escenario vacío con la barra de
    // controles encima invita a pulsar botones que no van a ninguna parte.
    if (get().estado === "fuera") return;
    set({ escenario: true });
  },

  cerrarEscenario: () => set({ escenario: false }),

  refrescarOcupacion: async (orgId) => {
    try {
      const res = await api.get<APIResponse<Record<string, VoicePeer[]>>>(
        `/api/v1/chat/voice-presence${orgId ? `?orgId=${orgId}` : ""}`,
        true,
      );
      set({ ocupacion: res.data ?? {} });
    } catch {
      // Silencio: esto es informativo y se reintenta solo. Una pantalla roja
      // porque el SFU tardó sería peor que no saber quién hay.
    }
  },

  alternarMic: async () => {
    const siguiente = !get().mic;
    // Optimista: silenciarse tiene que sentirse instantáneo, y el motor no
    // puede fallar en apagar algo que ya tiene abierto.
    //
    // Se pinta también en `mudos` para que tu mosaico y el de los demás salgan
    // del mismo sitio; el motor confirma con su propio evento un instante
    // después y escribe encima lo mismo.
    const yo = get().yo;
    set((s) => ({
      mic: siguiente,
      mudos: yo ? { ...s.mudos, [yo]: !siguiente } : s.mudos,
    }));
    await engine
      .setMic(siguiente)
      .then(() => set({ error: null, errorSpaceId: null }))
      .catch(() => {});
  },

  /**
   * Sordera.
   *
   * Silencia el micrófono además de los altavoces, y no lo devuelve al
   * quitarla: quien se pone sordo en mitad de una llamada casi siempre se está
   * apartando de ella, y volver hablando sin querer es el accidente que este
   * botón existe para evitar. Reabrir el micro es un gesto aparte, deliberado.
   */
  alternarSordera: async () => {
    const siguiente = !get().sordo;
    set(siguiente ? { sordo: true, mic: false } : { sordo: false });
    await engine.setDeaf(siguiente).catch(() => {});
    if (siguiente) await engine.setMic(false).catch(() => {});
  },

  limpiarError: () => set({ error: null, errorSpaceId: null }),

  timbrar: async (userId, nombre) => {
    const ruta = rutaDelTimbre(get());
    if (!ruta) return;
    pararReloj("saliente");
    set({ llamando: { identity: userId, name: nombre, desde: Date.now(), sinRespuesta: false } });
    try {
      const res = await api.post<APIResponse<{ ringId: string }>>(ruta, { userId }, true);
      if (!res.success) throw new Error(res.error ?? "no se pudo llamar");
    } catch (e) {
      // Se cae la fila entera en vez de dejarla sonando: una llamada que el
      // servidor rechazó no está sonando en ninguna parte, y enseñarla como si
      // sonara es la peor de las mentiras posibles aquí.
      set({
        llamando: null,
        error: deRust(e),
        errorSpaceId: get().spaceId,
      });
      return;
    }
    // El tope lo pone también el cliente porque el servidor no guarda el
    // timbre: nadie está mirando el reloj por nosotros.
    relojSaliente = setTimeout(() => {
      set((s) => (s.llamando ? { llamando: { ...s.llamando, sinRespuesta: true } } : s));
    }, TIMBRE_MS);
  },

  cancelarTimbre: async () => {
    const { llamando } = get();
    const ruta = rutaDelTimbre(get());
    // Parar el reloj aquí no cambia nada que se vea: el callback comprueba que
    // siga habiendo llamada, así que uno que llegue tarde no hace nada. Es por
    // no dejar veinte segundos de temporizador colgando, no por corrección — y
    // se dice para que nadie quite el `if` de ahí abajo creyendo que sobra.
    pararReloj("saliente");
    set({ llamando: null });
    if (!ruta || !llamando) return;
    await api.delete(`${ruta}/${llamando.identity}`, true).catch(() => {});
  },

  alTimbrar: (t) => {
    // Ya estás dentro de esa sala: la llamada llegó tarde o cruzada, y una
    // tarjeta que te invita a donde ya estás sólo tapa la conversación.
    const ya = t.inviteId ? get().meetId === t.inviteId : !get().meetId && get().spaceId === t.spaceId;
    if (ya && get().estado !== "fuera") return;
    pararReloj("entrante");
    set({ entrante: t });
    // Se apaga sola a la hora que dijo el servidor. Es lo que hace que un
    // timbre sobreviva a que la app de quien llamaba muera de golpe: nadie
    // mandará la cancelación, y aun así deja de sonar.
    const falta = Math.max(0, new Date(t.expiresAt).getTime() - Date.now());
    relojEntrante = setTimeout(() => {
      set((s) => (s.entrante?.ringId === t.ringId ? { entrante: null } : s));
    }, falta);
  },

  alColgarTimbre: (de) => {
    set((s) => {
      const cambios: Partial<VoiceState> = {};
      // Colgó quien te llamaba.
      if (s.entrante?.from.id === de) {
        pararReloj("entrante");
        cambios.entrante = null;
      }
      // O al revés: a quien tú llamabas dijo que no, y su rechazo vuelve por
      // el mismo camino que una cancelación. Se queda «no contestó» en vez de
      // desaparecer, porque una fila que se esfuma sola no dice si te
      // rechazaron o si el botón nunca llegó a hacer nada.
      if (s.llamando?.identity === de) {
        pararReloj("saliente");
        cambios.llamando = { ...s.llamando, sinRespuesta: true };
      }
      return cambios;
    });
  },

  aceptarEntrante: async () => {
    const t = get().entrante;
    if (!t) return;
    pararReloj("entrante");
    set({ entrante: null });
    if (t.inviteId) await get().entrarEnReunion(t.inviteId);
    else await get().entrar(t.spaceId, { orgId: t.orgId, spaceName: t.spaceName });
  },

  rechazarEntrante: async () => {
    const t = get().entrante;
    if (!t) return;
    pararReloj("entrante");
    set({ entrante: null });
    // Decir que no en vez de dejar que expire: quien llamaba se entera ahora y
    // no dentro de veinte segundos. Va por el mismo endpoint —«deja de sonar
    // entre tú y yo»— y llega como una cancelación con tu id.
    const ruta = t.inviteId
      ? `/api/v1/call-invites/${t.inviteId}/ring`
      : `/api/v1/task-spaces/${t.spaceId}/voice/ring`;
    await api.delete(`${ruta}/${t.from.id}`, true).catch(() => {});
  },

  /**
   * Encender o apagar tu cámara.
   *
   * **No es optimista, al revés que el micrófono.** Silenciarse no puede
   * fallar —el motor ya tiene el micro abierto— pero la cámara sí: puede no
   * haber ninguna, puede estar cogida por otro programa, y en macOS puede
   * faltar el permiso. Pintar el botón encendido y que no salga imagen deja a
   * alguien saludando a nadie.
   *
   * Y si falla, **se queda como estaba**, que no es lo mismo que apagarse. Si
   * lo que falló fue apagarla, la cámara probablemente sigue publicando:
   * pintarla apagada te diría que nadie te ve mientras te siguen viendo, que
   * es el peor de los dos errores posibles. El mismo criterio que el micro.
   */
  alternarCam: async () => {
    const siguiente = !get().cam;
    try {
      await engine.setCamera(siguiente);
      set({ cam: siguiente, error: null, errorSpaceId: null });
    } catch (e) {
      set({ error: deRust(e), errorSpaceId: get().spaceId });
    }
  },

  /**
   * Compartir la pantalla, o dejar de hacerlo.
   *
   * Como la cámara y por lo mismo: **no es optimista**. Entre pulsar y que
   * empiece a salir imagen hay un diálogo del sistema pidiendo permiso, y
   * pintar el botón encendido mientras alguien decide es prometer algo que
   * todavía no ha pasado. Puede tardar y puede decir que no.
   *
   * Y si falla al parar, se queda encendido: decirte que dejaste de compartir
   * mientras tu pantalla sigue viéndose es el peor error posible de los dos.
   */
  alternarCompartir: async () => {
    if (get().compartiendo) {
      try {
        await engine.stopShare();
        set({ compartiendo: false, error: null, errorSpaceId: null });
      } catch (e) {
        set({ error: deRust(e), errorSpaceId: get().spaceId });
      }
      return;
    }
    // Con dos monitores, cuál. Antes se compartía siempre el primero que
    // listara el sistema, sin preguntar (#117).
    const fuentes = await engine.screenSources().catch(() => []);
    if (Array.isArray(fuentes) && fuentes.length > 1) {
      set({ eligiendoPantalla: fuentes });
      return;
    }
    await get().compartirPantalla(null);
  },

  compartirPantalla: async (sourceId) => {
    set({ eligiendoPantalla: null });
    try {
      await engine.shareScreen(sourceId);
      set({ compartiendo: true, error: null, errorSpaceId: null });
    } catch (e) {
      set({ error: deRust(e), errorSpaceId: get().spaceId });
    }
  },

  cancelarEleccionPantalla: () => set({ eligiendoPantalla: null }),

  alRecibir: (ev) => {
    switch (ev.kind) {
      case "connected":
        set({ yo: ev.identity, estado: "dentro" });
        break;
      case "joined":
        set((s) =>
          s.gente.some((p) => p.identity === ev.identity)
            ? s
            : { gente: [...s.gente, { identity: ev.identity, name: ev.name }] },
        );
        break;
      case "left":
        set((s) => {
          // Fuera del mapa de mudos también: dejar la entrada haría que quien
          // se fue mudo y vuelve abierto apareciera silenciado hasta que se le
          // ocurriera tocar el botón.
          const mudos = { ...s.mudos };
          delete mudos[ev.identity];
          const video = { ...s.video };
          delete video[ev.identity];
          return {
            video,
            // Y si era quien compartía, el escenario vuelve a los mosaicos.
            pantalla: s.pantalla === ev.identity ? null : s.pantalla,
            gente: s.gente.filter((p) => p.identity !== ev.identity),
            // Y fuera de los que hablan: sin esto, quien se va mientras habla
            // deja su punto encendido para siempre.
            hablando: s.hablando.filter((id) => id !== ev.identity),
            mudos,
          };
        });
        break;
      case "muted":
        set((s) => ({ mudos: { ...s.mudos, [ev.identity]: ev.muted } }));
        break;
      case "recording":
        set({
          recording: ev.active ? { id: ev.id, by: ev.by, since: ev.since } : null,
        });
        break;
      case "latency":
        set({ latencia: ev.ms });
        break;
      case "selfSpeaking":
        set({ hablandoYo: ev.speaking });
        break;
      case "video":
        if (ev.source === "screen") {
          set((s) => ({
            // El foco no se lo quita nadie al que ya está: sólo se ocupa si
            // está libre, y sólo se suelta el que lo tenía.
            pantalla: ev.enabled ? (s.pantalla ?? ev.identity) : s.pantalla === ev.identity ? null : s.pantalla,
            // Tu propia pantalla se deja de compartir también desde fuera de
            // la app —el botón del navegador, o el sistema que la retira— y
            // entonces el botón de aquí tiene que apagarse.
            ...(ev.identity === s.yo && !ev.enabled ? { compartiendo: false } : {}),
          }));
        } else {
          set((s) => ({
            video: { ...s.video, [ev.identity]: ev.enabled },
            // Si el evento habla de **tu** cámara, hazle caso al botón también.
            //
            // El motor sólo lo manda cuando la cámara se apaga sola a media
            // llamada —te la quita otra aplicación, o el dispositivo se cae— y
            // sin esto el mapa decía «apagada» mientras el botón seguía
            // encendido. Dos sitios contando cosas distintas del mismo aparato.
            ...(ev.identity === s.yo ? { cam: ev.enabled } : {}),
          }));
        }
        break;
      case "speaking":
        // La lista entera, no un delta: reconstruirla a base de altas y bajas
        // es cómo se acaba con un indicador encendido por un evento perdido.
        set({ hablando: ev.identities });
        break;
      case "disconnected": {
        // El invitado se queda con su reunión dicha: la pantalla de después
        // necesita saber que estaba dentro de una para ofrecer volver.
        const { spaceId, visitor, title } = get();
        intento++;
        set({
          ...VACIO,
          ...(visitor ? { visitor, title } : {}),
          error: motivoDeSalida(ev.reason),
          errorSpaceId: spaceId,
        });
        break;
      }
    }
  },
  };
});
