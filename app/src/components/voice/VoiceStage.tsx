import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { AlertCircle, Check, Link2, Loader2, MessageSquare, Minimize2, UserPlus, Volume2, X } from "lucide-react";
import GuestInviteDialog from "@/components/voice/GuestInviteDialog";
import { iniciales } from "@/lib/desde";
import VoiceChat from "@/components/voice/VoiceChat";
import DeviceSettings from "@/components/voice/DeviceSettings";
import InvitePicker, { InviteButton } from "@/components/voice/InvitePicker";
import RingRow from "@/components/voice/RingRow";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";

import { useConfirm } from "@/components/ConfirmDialog";
import RecChip from "@/components/voice/RecChip";
import RecordingBanner from "@/components/voice/RecordingBanner";
import RecordingConsentDialog from "@/components/voice/RecordingConsentDialog";
import VoiceControls from "@/components/voice/VoiceControls";
import VideoSurface from "@/components/voice/VideoSurface";
import VoiceTile from "@/components/voice/VoiceTile";
import ScreenPicker from "@/components/voice/ScreenPicker";
import { cn } from "@/lib/utils";
import { guestLinkFor } from "@/lib/call-link";
import { isWebBuild } from "@/lib/platform";
import { phraseFor } from "@/lib/server-errors";
import { engine } from "@/lib/voice-engine";
import { isGuestIdentity, useCalls, type WaitingGuest } from "@/store/calls.store";
import { meetScope, useRecordings } from "@/store/recordings.store";
import { useVoice } from "@/store/voice.store";

/**
 * La sala, a pantalla completa.
 *
 * Hasta ahora la llamada era una pastilla en la cabecera del canal: cabían un
 * contador y dos iconos, y nada más. Eso bastaba para hablar, pero no para lo
 * que viene detrás —caras y pantallas compartidas—, que necesita sitio de
 * verdad. Así que la conversación hablada pasa a tener pantalla propia.
 *
 * Lo importante es que **esta pantalla no es la llamada**: minimizarla no
 * cuelga. Por eso el store lleva dos estados y no uno (ver `voice.store.ts`).
 *
 * La misma pantalla sirve a las tres salas (W3): la de un canal, una reunión
 * con invitados vista por un miembro, y esa reunión vista por el invitado. Lo
 * que cambia es **qué se ofrece**, y sale del store, no de props: a quien entró
 * con un enlace no se le ofrece nada que necesite sesión —el chat del canal, el
 * timbre, grabar, sacar a nadie—, porque fallaría al pulsarlo.
 */
/**
 * La lista vacía, siempre la misma. Un `[]` nuevo en el selector de zustand es
 * un valor distinto en cada lectura, y React vuelve a pintar sin parar.
 */
const NADIE: WaitingGuest[] = [];

export default function VoiceStage({ spaceName = "" }: { spaceName?: string }) {
  const { t } = useT();
  const estado = useVoice((s) => s.estado);
  const gente = useVoice((s) => s.gente);
  const hablando = useVoice((s) => s.hablando);
  const hablandoYo = useVoice((s) => s.hablandoYo);
  const yo = useVoice((s) => s.yo);
  const mic = useVoice((s) => s.mic);
  const mudos = useVoice((s) => s.mudos);
  const video = useVoice((s) => s.video);
  const pantallaAjena = useVoice((s) => s.pantalla);
  const compartiendo = useVoice((s) => s.compartiendo);
  const alternarCompartir = useVoice((s) => s.alternarCompartir);
  const latencia = useVoice((s) => s.latencia);
  const sordo = useVoice((s) => s.sordo);
  const salir = useVoice((s) => s.salir);
  const alternarMic = useVoice((s) => s.alternarMic);
  const alternarSordera = useVoice((s) => s.alternarSordera);
  const cam = useVoice((s) => s.cam);
  const alternarCam = useVoice((s) => s.alternarCam);
  const cerrarEscenario = useVoice((s) => s.cerrarEscenario);
  const error = useVoice((s) => s.error);
  const limpiarError = useVoice((s) => s.limpiarError);
  // La tuya manda sobre la de otro: si estás compartiendo, lo que necesitas ver
  // es lo que los demás están viendo de ti.
  const pantalla = compartiendo ? yo : pantallaAjena;
  const [invitando, setInvitando] = useState(false);
  const [ajustes, setAjustes] = useState(false);
  const [chat, setChat] = useState(false);
  const spaceId = useVoice((s) => s.spaceId);
  const meetId = useVoice((s) => s.meetId);
  const meetSpaceId = useVoice((s) => s.meetSpaceId);
  const title = useVoice((s) => s.title);
  const visitor = useVoice((s) => s.visitor);
  const enReunion = Boolean(meetId) || visitor;
  const nombreSala = enReunion ? (title ?? t("calls:untitled")) : `#${spaceName}`;
  // De qué sala son la política y el botón de grabar: la del canal, o la de la
  // reunión. Nunca la del canal estando en una reunión — ver `meetScope`.
  const recScope = visitor ? null : (spaceId ?? (meetId ? meetScope(meetId) : null));
  // El chat de la sala es el hilo del canal; en una reunión, el del canal del
  // que cuelga. Un invitado no tiene sesión con la que escribirlo.
  const chatSpaceId = visitor ? null : (spaceId ?? meetSpaceId);
  const kick = useCalls((s) => s.kick);
  const getInvite = useCalls((s) => s.get);
  const orgId = useVoice((s) => s.orgId);
  // Quién espera para entrar a esta reunión. Sólo lo ve un miembro: es quien
  // decide.
  const esperan = useCalls((s) => (meetId && !visitor ? (s.waiting[meetId] ?? NADIE) : NADIE));
  const loadWaiting = useCalls((s) => s.loadWaiting);
  const admit = useCalls((s) => s.admit);
  const rejectGuest = useCalls((s) => s.reject);
  const [porEnlace, setPorEnlace] = useState(false);
  // Quién graba lo dice **el motor**, no el botón: llega por el metadata de la
  // sala, así que enciende el chip en todas las pantallas a la vez —incluida la
  // de quien entró después.
  const recording = useVoice((s) => s.recording);
  const politica = useRecordings((s) => (recScope ? s.policy[recScope] : undefined));
  const startRecording = useRecordings((s) => s.start);
  const stopRecording = useRecordings((s) => s.stop);
  const grabacionEnVuelo = useRecordings((s) => s.inFlight);
  const loadPolicy = useRecordings((s) => s.loadPolicy);
  const [consenting, setConsenting] = useState(false);
  const confirm = useConfirm();
  // Se lee del estado en el momento, no por suscripción: sólo hace falta
  // justo después de que la petición conteste.
  const recordingError = () => useRecordings.getState().error;

  // Quién la empezó, por su nombre. Hace falta para el aviso de stop: no es lo
  // mismo cortar la tuya que la de otro, y quien pulsa tiene que saber cuál es
  // antes de decidir.
  const recorderName = (gente ?? []).find((p) => p.identity === recording?.by)?.name;

  const confirmAndStop = async () => {
    if (!recording) return;
    const mia = recording.by === yo;
    const ok = await confirm({
      title: t("recordings:stopConfirmTitle"),
      description: mia
        ? t("recordings:stopConfirmMine")
        : t("recordings:stopConfirmTheirs", {
            name: recorderName ?? t("recordings:chipUnknown"),
          }),
      confirmText: t("recordings:stopConfirmAction"),
      destructive: true,
    });
    if (ok) await stopRecording(recording.id);
  };

  // Se pregunta al entrar: de eso depende que el botón exista.
  useEffect(() => {
    if (recScope) void loadPolicy(recScope);
  }, [recScope, loadPolicy]);

  // Al entrar a la reunión se pide la lista; después la mantiene el stream
  // (`call:knock`).
  useEffect(() => {
    if (meetId && !visitor) void loadWaiting(meetId).catch(() => {});
  }, [meetId, visitor, loadWaiting]);

  const decidir = async (guestId: string, si: boolean) => {
    if (!meetId) return;
    try {
      await (si ? admit(meetId, guestId) : rejectGuest(meetId, guestId));
    } catch (e) {
      toast.error(phraseFor(String((e as Error)?.message ?? e), String(e)));
      void loadWaiting(meetId).catch(() => {});
    }
  };

  const copiarEnlace = async () => {
    if (!meetId) return;
    try {
      // En el clic, con la promesa del enlace: pedirlo antes y copiar después
      // pierde el gesto y WebKit lo rechaza (ver `copyText`).
      await copyText(getInvite(meetId).then((inv) => guestLinkFor(inv.link)));
      toast.success(t("calls:linkCopied"));
    } catch (e) {
      toast.error(phraseFor(String((e as Error)?.message ?? e), String(e)));
    }
  };

  const sacar = async (identity: string, nombre: string) => {
    if (!meetId) return;
    const ok = await confirm({
      title: t("calls:removeGuestTitle", { name: nombre }),
      description: t("calls:removeGuestBody"),
      confirmText: t("calls:removeGuestAction"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await kick(meetId, identity);
      toast.success(t("calls:removed", { name: nombre }));
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e));
    }
  };

  // Con alguien compartiendo, las caras se van **encima** de la imagen en vez
  // de ocupar una columna de 200 px al lado. El ancho es lo que se ha venido a
  // mirar; un bloque sólido robándoselo a una captura ya reducida es justo lo
  // que estorba.
  //
  // Automático y no un botón más: son cuatro pastillas en la cabecera y esto se
  // resuelve solo. Con las dos reglas de `useEncogerEnLlamada`, por lo mismo
  // que allí — se restaura al terminar, y si lo abres a mano deja de mandar.
  // Un solo booleano, y dice una cosa: «las pediste tú». Antes eran tres
  // estados —`null`, `false`, `true`— y dos de ellos significaban lo mismo
  // según hubiera pantalla o no; la mitad de la condición resultante no era
  // observable, que es como se acumulan guardas contra estados imposibles.
  const [carasAMano, setCarasAMano] = useState(false);
  useEffect(() => {
    if (!pantalla) setCarasAMano(false);
  }, [pantalla]);
  const carasFuera = !!pantalla && !carasAMano;

  // Tú cuentas como presente aunque el motor sólo reporte a los demás.
  const dentro = [...(yo ? [{ identity: yo, name: "You" }] : []), ...gente];
  const solo = dentro.length === 1;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <ScreenPicker />
      <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4">
        <Volume2 className="size-4 shrink-0 text-success" />
        <span className="truncate text-sm font-semibold">{nombreSala}</span>
        <span className="shrink-0 text-[13px] text-muted-foreground">
          {estado === "entrando"
            ? "connecting…"
            : solo
              ? "nobody else yet"
              : `${dentro.length} in voice`}
          {/* El ida y vuelta medido por WebRTC, no una estimación nuestra. Sólo
              cuando se sabe: mientras se establece la conexión no hay par
              nominado, y un «0 ms» ahí se lee como una llamada perfecta justo
              en el momento en que todavía no lo es. */}
          {latencia !== null && ` · ${latencia} ms`}
        </span>
        {/* En la cabecera y no entre los mandos: lo que se está recording es la
            llamada entera, no un botón. Quien mire la pantalla un segundo tiene
            que verlo sin buscarlo. */}
        {recording && <RecChip by={recorderName} />}
        <div className="flex-1" />
        {/* Llamar a alguien vive aquí y no en la barra de mandos: los mandos
            son sobre ti —tu micro, tu cámara— y esto es sobre la sala. */}
        {/* El timbre es del canal: llama a un compañero a **esta** sala, y
            una reunión con invitados no es la sala de ningún canal. */}
        {(spaceId || meetId) && !visitor && (
          <InviteButton abierto={invitando} onToggle={() => setInvitando((v) => !v)} />
        )}
        {/* Gente de fuera, desde la llamada del canal. No entra a esta sala:
            el botón abre una reunión aparte y muda la llamada a ella. */}
        {spaceId && !visitor && orgId && (
          <button
            type="button"
            onClick={() => setPorEnlace(true)}
            className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
          >
            <UserPlus className="size-[15px]" /> {t("calls:inviteByLink")}
          </button>
        )}
        {meetId && !visitor && (
          <button
            type="button"
            onClick={() => void copiarEnlace()}
            className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
          >
            <Link2 className="size-[15px]" /> {t("calls:copyLink")}
          </button>
        )}
        {/* La etiqueta dice lo que va a hacer, no en qué estado está: es el
            patrón del resto de la cabecera y del diseño. */}
        {chatSpaceId && (
          <button
            type="button"
            onClick={() => setChat((v) => !v)}
            className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
          >
            <MessageSquare className="size-[15px]" /> {chat ? t("common:last.hideChat") : t("common:last.chat")}
          </button>
        )}
        {/* Minimizar es volver a cac con la llamada abierta; quien entró con un
            enlace no tiene ningún cac al que volver. */}
        {!visitor && (
          <button
            type="button"
            onClick={cerrarEscenario}
            title={t("common:last.backToChannel")}
            className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
          >
            <Minimize2 className="size-[15px]" /> Minimize
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 p-5">
        {estado === "entrando" ? (
          <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Joining {nombreSala}…
          </div>
        ) : (
          <div className="flex size-full gap-3.5">
            {/* El eje de dentro depende de si hay pantalla; el chat va fuera,
                porque es una columna a la derecha en los dos casos. Estaban
                juntos y sin pantalla el panel caía debajo de la rejilla. */}
            <div className={cn("flex min-h-0 min-w-0 flex-1 gap-3.5", !pantalla && "flex-col")}>
            {/* Con una pantalla compartida, ella manda: ocupa el sitio y las
                caras se van a una tira lateral. Es lo que se ha venido a mirar
                —código, un documento— y en un mosaico de la rejilla no se lee.
                Sin pantalla, la rejilla de siempre. */}
            {pantalla && (
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border-2 border-primary bg-black">
                <VideoSurface identity={pantalla} fuente="screen" />
                <span className="absolute bottom-3 left-3 rounded-full bg-background/70 px-2.5 py-1 text-xs font-semibold text-primary">
                  {pantalla === yo
                    ? t("common:last.youAreSharing")
                    : `${dentro.find((p) => p.identity === pantalla)?.name ?? pantalla} is sharing`}
                </span>
                {pantalla === yo && (
                  <button
                    onClick={() => void alternarCompartir()}
                    className="absolute bottom-3 right-3 rounded-full border border-destructive/50 bg-background/80 px-3 py-1 text-xs font-semibold text-destructive"
                  >
                    {t("common:last.stopSharing")}
                  </button>
                )}
                {/* Las caras, encima y arriba a la derecha.
                    Arriba porque abajo ya viven las dos píldoras. Atenuadas
                    mientras nadie habla: presentando, lo único que hace falta
                    de un vistazo es quién está hablando, y el resto del tiempo
                    cuanto menos tapen mejor. Con sombra y no con un bloque —un
                    avatar sobre un IDE oscuro se lee, sobre una hoja blanca
                    no—, y pulsar cualquiera devuelve la columna. */}
                {carasFuera && (
                  <button
                    type="button"
                    onClick={() => setCarasAMano(true)}
                    title={t("common:last.showParticipants")}
                    className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-background/40 p-1 backdrop-blur-sm transition-opacity hover:opacity-100"
                  >
                    {dentro.map((p) => {
                      const habla = p.identity === yo ? hablandoYo : hablando.includes(p.identity);
                      return (
                        <span
                          key={p.identity}
                          title={p.name || p.identity}
                          className={cn(
                            "grid size-7 place-items-center rounded-full text-[11px] font-bold shadow-md transition-all",
                            habla
                              ? "bg-success/25 text-success ring-2 ring-success"
                              : "bg-background/80 text-muted-foreground opacity-40",
                          )}
                        >
                          {iniciales(p.name || p.identity)}
                        </span>
                      );
                    })}
                  </button>
                )}
              </div>
            )}
            <div
              className={cn(
                "min-h-0 gap-3.5",
                pantalla
                  ? "flex w-50 shrink-0 flex-col overflow-y-auto"
                  : "grid flex-1 auto-rows-fr grid-cols-2",
                // Al final y no antes: `cn` es tailwind-merge, y `hidden`,
                // `flex` y `grid` son la misma familia — gana la última. Puesto
                // arriba se descartaba en silencio y la columna seguía a la
                // vista, que es exactamente lo que esto venía a evitar.
                carasFuera && "hidden",
              )}
            >
              {dentro.map((p) => (
                <VoiceTile
                  key={p.identity}
                  nombre={p.name || p.identity}
                  compacto={!!pantalla}
                  // El tuyo sale de tu micrófono; el de los demás, del servidor.
                  hablando={p.identity === yo ? hablandoYo : hablando.includes(p.identity)}
                  // El propio sale de `mic` y no del mapa: es optimista, y
                  // esperar la confirmación del servidor para tachar tu propio
                  // micrófono son doscientos milisegundos en los que parece que
                  // el botón no hizo nada.
                  silenciado={p.identity === yo ? !mic : (mudos[p.identity] ?? false)}
                  // El tuyo también, y en espejo. El motor no se suscribe a
                  // sus propias pistas —el SFU no te devuelve lo que mandas—
                  // así que tu cara la guarda la captura por su cuenta. Sin
                  // esto, encender la cámara sin nadie más en la sala no
                  // enseñaba nada y parecía rota.
                  video={
                    p.identity === yo
                      ? cam
                        ? (yo ?? undefined)
                        : undefined
                      : video[p.identity]
                        ? p.identity
                        : undefined
                  }
                  espejo={p.identity === yo}
                  invitado={isGuestIdentity(p.identity)}
                  // Sacar a alguien es de los miembros, y sólo en una reunión:
                  // en el canal no hay invitados, y el invitado no saca a nadie.
                  // **A quién** se puede sacar lo decide el mosaico, por
                  // `invitado`: una sola puerta, no dos que se puedan desparejar.
                  onRemove={
                    meetId && !visitor
                      ? () => void sacar(p.identity, p.name || p.identity)
                      : undefined
                  }
                />
              ))}
              </div>
            </div>
            {chat && chatSpaceId && (
              <VoiceChat spaceId={chatSpaceId} spaceName={spaceName || nombreSala} onClose={() => setChat(false)} />
            )}
          </div>
        )}
      </div>

      {invitando && <InvitePicker onClose={() => setInvitando(false)} />}
      {spaceId && orgId && (
        <GuestInviteDialog open={porEnlace} onOpenChange={setPorEnlace} orgId={orgId} spaceId={spaceId} fromCall />
      )}
      {ajustes && <DeviceSettings />}

      {/* Lo que el motor no pudo hacer, **junto a los mandos** y no en un
          aviso flotante: el error de encender la cámara pertenece al botón de
          la cámara. Y sobre todo, en algún sitio — se quedaba en el store sin
          pintarse en ninguna parte, así que un fallo del motor se veía
          exactamente igual que un botón que no responde. Tres versiones se
          probaron a ciegas por eso. */}
      {error && (
        <p
          role="alert"
          className="flex shrink-0 items-center justify-center gap-2 border-t bg-destructive/10 px-4 py-2 text-center text-xs text-destructive"
        >
          <AlertCircle className="size-3.5 shrink-0" /> {error}
          {/* Con botón de cerrar, y no por pulcritud: nada limpiaba este campo
              salvo salir de la llamada, así que un fallo pasajero de la cámara
              dejaba el cartel puesto el resto de la sesión. Reintentar tampoco
              servía —el segundo intento contesta que el dispositivo sigue
              ocupado— y acababas leyendo un aviso de algo que ya no pasaba. */}
          <button
            type="button"
            onClick={limpiarError}
            aria-label={t("common:last.dismiss")}
            className="ml-1 shrink-0 rounded p-0.5 hover:bg-destructive/20"
          >
            <X className="size-3.5" />
          </button>
        </p>
      )}

      {/* La sala de espera: quién pide entrar con el enlace. Encima de los
          mandos, porque alguien está esperando delante de una puerta. */}
      {esperan.length > 0 && (
        <div role="region" aria-label={t("calls:waitingRoom", { count: esperan.length })} className="shrink-0 border-t bg-primary/5 px-4 py-2">
          <p className="mb-1.5 text-xs font-semibold text-primary">{t("calls:waitingRoom", { count: esperan.length })}</p>
          <ul className="flex flex-col gap-1.5">
            {esperan.map((g) => (
              <li key={g.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <button
                  type="button"
                  onClick={() => void decidir(g.id, false)}
                  className="flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:text-destructive"
                >
                  <X className="size-3.5" /> {t("calls:reject")}
                </button>
                <button
                  type="button"
                  onClick={() => void decidir(g.id, true)}
                  className="flex h-7 items-center gap-1 rounded-md bg-success px-2 text-xs font-semibold text-background"
                >
                  <Check className="size-3.5" /> {t("calls:admit")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Debajo de la cabecera y encima de todo lo demás: quien entra a una
          llamada que ya se graba tiene que leerlo antes de hablar. */}
      <RecordingBanner />

      <RingRow />

      <VoiceControls
        mic={mic}
        deafened={sordo}
        cam={cam}
        sharing={compartiendo}
        onMic={() => void alternarMic()}
        onDeafen={() => void alternarSordera()}
        onCam={() => void alternarCam()}
        // Un móvil no comparte pantalla: el botón no se pinta en vez de fallar.
        onShare={engine.canShareScreen() ? () => void alternarCompartir() : undefined}
        onSettings={() => setAjustes((v) => !v)}
        onLeave={() => void salir()}
        // El reporte de audio lee el registro del motor de Rust; en la web no
        // hay nada que leer.
        canReport={!isWebBuild}
        recording={Boolean(recording)}
        recordingInFlight={Boolean(grabacionEnVuelo)}
        // Sin política, o con la grabación apagada en el servidor, **no hay
        // botón**: pasar `undefined` es lo que hace que no se pinte.
        onRecord={
          politica?.enabled && recScope
            ? () => {
                // **Parar también pregunta**, y no por simetría: el botón vive
                // entre el de silenciarse y el de compartir pantalla, que se
                // pulsan con prisa. Cortar por error la grabación de una
                // reunión no se deshace — volver a start hace **otra**, y lo
                // de en medio no existe.
                if (recording) void confirmAndStop();
                // Y start **siempre pregunta**, aunque sea la segunda vez en
                // la misma llamada. Ver `RecordingConsentDialog`.
                else setConsenting(true);
              }
            : undefined
        }
      />
      <RecordingConsentDialog
        open={consenting}
        onOpenChange={setConsenting}
        inFlight={Boolean(grabacionEnVuelo)}
        onConfirm={() => {
          if (!recScope) return;
          void (async () => {
            const empezo = await startRecording(recScope);
            setConsenting(false);
            // Si dos pulsan a la vez, **gana uno** —lo decide el índice único
            // de la base, no una comprobación previa— y al otro le llega un
            // 409. Hasta ahora su pulsación se veía como si no hubiera hecho
            // nada: aparecía el chip y no se sabía por qué. Ahora se le dice.
            if (!empezo && recordingError() === "already-recording") {
              const quien = useRecordings.getState().policy[recScope]?.active?.startedBy;
              const nombre = (gente ?? []).find((p) => p.identity === quien)?.name;
              toast.info(
                nombre
                  ? t("recordings:alreadyStarted", { name: nombre })
                  : t("recordings:alreadyStartedUnknown"),
              );
            }
          })();
        }}
      />
    </div>
  );
}
