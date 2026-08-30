import { useEffect, useState } from "react";
import { AlertCircle, Loader2, MessageSquare, Minimize2, Volume2, X } from "lucide-react";
import { iniciales } from "@/lib/desde";
import VoiceChat from "@/components/voice/VoiceChat";
import DeviceSettings from "@/components/voice/DeviceSettings";
import InvitePicker, { InviteButton } from "@/components/voice/InvitePicker";
import RingRow from "@/components/voice/RingRow";
import VoiceControls from "@/components/voice/VoiceControls";
import VideoLienzo from "@/components/voice/VideoLienzo";
import VoiceTile from "@/components/voice/VoiceTile";
import { cn } from "@/lib/utils";
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
 */
export default function VoiceStage({ spaceName }: { spaceName: string }) {
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
      <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4">
        <Volume2 className="size-4 shrink-0 text-success" />
        <span className="truncate text-sm font-semibold">#{spaceName}</span>
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
        <div className="flex-1" />
        {/* Llamar a alguien vive aquí y no en la barra de mandos: los mandos
            son sobre ti —tu micro, tu cámara— y esto es sobre la sala. */}
        <InviteButton abierto={invitando} onToggle={() => setInvitando((v) => !v)} />
        {/* La etiqueta dice lo que va a hacer, no en qué estado está: es el
            patrón del resto de la cabecera y del diseño. */}
        <button
          type="button"
          onClick={() => setChat((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
        >
          <MessageSquare className="size-[15px]" /> {chat ? "Hide chat" : "Chat"}
        </button>
        <button
          type="button"
          onClick={cerrarEscenario}
          title="Back to the channel — you stay connected"
          className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
        >
          <Minimize2 className="size-[15px]" /> Minimize
        </button>
      </header>

      <div className="min-h-0 flex-1 p-5">
        {estado === "entrando" ? (
          <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Joining #{spaceName}…
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
                <VideoLienzo identity={pantalla} fuente="screen" />
                <span className="absolute bottom-3 left-3 rounded-full bg-background/70 px-2.5 py-1 text-xs font-semibold text-primary">
                  {pantalla === yo
                    ? "You are sharing"
                    : `${dentro.find((p) => p.identity === pantalla)?.name ?? pantalla} is sharing`}
                </span>
                {pantalla === yo && (
                  <button
                    onClick={() => void alternarCompartir()}
                    className="absolute bottom-3 right-3 rounded-full border border-destructive/50 bg-background/80 px-3 py-1 text-xs font-semibold text-destructive"
                  >
                    Stop sharing
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
                    title="Show participants"
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
                />
              ))}
              </div>
            </div>
            {chat && spaceId && (
              <VoiceChat spaceId={spaceId} spaceName={spaceName} onClose={() => setChat(false)} />
            )}
          </div>
        )}
      </div>

      {invitando && <InvitePicker onClose={() => setInvitando(false)} />}
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
            aria-label="Dismiss"
            className="ml-1 shrink-0 rounded p-0.5 hover:bg-destructive/20"
          >
            <X className="size-3.5" />
          </button>
        </p>
      )}

      <RingRow />

      <VoiceControls
        mic={mic}
        deafened={sordo}
        cam={cam}
        sharing={compartiendo}
        onMic={() => void alternarMic()}
        onDeafen={() => void alternarSordera()}
        onCam={() => void alternarCam()}
        onShare={() => void alternarCompartir()}
        onSettings={() => setAjustes((v) => !v)}
        onLeave={() => void salir()}
      />
    </div>
  );
}
