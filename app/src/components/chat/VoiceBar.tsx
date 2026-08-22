import { Loader2, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVoice } from "@/store/voice.store";

/**
 * Entrar y salir de la voz de este canal.
 *
 * Vive en la cabecera, al lado del nombre: la conversación hablada es del canal,
 * no una pantalla aparte a la que haya que ir. Cuando estás dentro, el mismo
 * sitio pasa a ser la barra de la llamada — silenciar, colgar y quién habla.
 */
export default function VoiceBar({ spaceId }: { spaceId: string }) {
  const { spaceId: enSala, estado, gente, hablando, yo, mic, error } = useVoice();
  const entrar = useVoice((s) => s.entrar);
  const salir = useVoice((s) => s.salir);
  const alternarMic = useVoice((s) => s.alternarMic);
  const aqui = enSala === spaceId;

  if (!aqui) {
    return (
      <button
        onClick={() => void entrar(spaceId)}
        disabled={estado === "entrando"}
        title={error ?? "Join the voice channel"}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
          error ? "border-destructive/40 text-destructive" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {estado === "entrando" && enSala === spaceId ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Volume2 className="size-3" />
        )}
        Voice
      </button>
    );
  }

  // Tú cuentas como presente aunque el motor sólo reporte a los demás.
  const dentro = [...(yo ? [{ identity: yo, name: "You" }] : []), ...gente];
  const solo = dentro.length === 1;

  return (
    <span className="flex min-w-0 shrink items-center gap-2 rounded-md border border-success/40 bg-success/5 px-2 py-1 text-xs">
      {/* Los nombres, no un número. «1» no dice si estás solo, si te oyen, ni a
          quién estás oyendo — que son las tres cosas que uno quiere saber al
          entrar. Con nombre y punto, la barra contesta las tres de un vistazo. */}
      <span className="flex min-w-0 items-center gap-2">
        {dentro.map((p) => (
          <span key={p.identity} className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full transition-colors",
                // Verde vivo mientras habla; apagado cuando calla. Es lo que
                // convierte una lista de nombres en «quién está diciendo esto».
                hablando.includes(p.identity) ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span className={cn("max-w-24 truncate", hablando.includes(p.identity) && "text-success")}>
              {p.name || p.identity}
            </span>
          </span>
        ))}
      </span>

      {/* Estar solo se dice, no se deduce de un contador a uno. Sin esto, una
          llamada en la que nadie te oye se ve igual que una que va bien. */}
      {solo && <span className="shrink-0 text-muted-foreground">· nadie más aún</span>}

      <span className="ml-1 flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => void alternarMic()}
          title={mic ? "Mute your microphone" : "Unmute your microphone"}
          className={cn("rounded p-0.5 hover:bg-accent", !mic && "text-destructive")}
        >
          {mic ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
        </button>
        <button
          onClick={() => void salir()}
          title="Leave voice"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
        >
          <PhoneOff className="size-3.5" />
        </button>
      </span>
    </span>
  );
}
