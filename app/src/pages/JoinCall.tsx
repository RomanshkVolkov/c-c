import { useEffect, useRef, useState } from "react";
import { Circle, Loader2, Mic, MicOff, PhoneCall, Video, VideoOff } from "lucide-react";

import { Brand } from "@/components/brand/Brand";
import MicLevel from "@/components/voice/MicLevel";
import VoiceStage from "@/components/voice/VoiceStage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { codigoDe } from "@/lib/api";
import { tokenFromHash } from "@/lib/call-link";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { publicCalls, type GuestEntryResponse, type PublicCallInvite } from "@/store/calls.store";
import { useVoice } from "@/store/voice.store";

/**
 * La puerta de quien no tiene cuenta (W3): `/app/join#<token>`.
 *
 * Fuera de `ProtectedRoute` y de `AppLayout` a propósito: aquí no hay sesión,
 * ni barra lateral, ni stream de eventos. Todo lo que se pide va **sin
 * autenticar** (ver `publicCalls`).
 *
 * Lo que no se negocia en esta pantalla: **el aviso de grabación va antes del
 * botón de entrar**. Quien entra a una llamada que se puede grabar tiene que
 * saberlo antes de decir nada, no descubrirlo por un chip rojo cuando ya está
 * hablando. Pulsar «Entrar» es el enterado, y es también el gesto que el
 * navegador exige para dejar sonar el audio.
 */

const NOMBRE = "cac.guestName";
/** Cada cuánto pregunta quien espera. El servidor le deja 1.500 por hora. */
const ESPERA_MS = 3000;
/** El pase va en `sessionStorage`: dura lo que la pestaña, como la reunión. */
const paseDe = (token: string) => `cac.guestPass.${token.slice(0, 48)}`;

function leer(store: Storage | undefined, k: string): string {
  try {
    return store?.getItem(k) ?? "";
  } catch {
    return "";
  }
}
function guardar(store: Storage | undefined, k: string, v: string) {
  try {
    store?.setItem(k, v);
  } catch {
    // Sin almacenamiento —modo privado— se entra igual; sólo se olvida.
  }
}

export default function JoinCall() {
  const { t } = useT();
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [info, setInfo] = useState<PublicCallInvite | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [nombre, setNombre] = useState(() => leer(globalThis.localStorage, NOMBRE));
  const [conCamara, setConCamara] = useState(false);
  const [conMic, setConMic] = useState(true);
  const [entrando, setEntrando] = useState(false);
  const [entro, setEntro] = useState(false);
  // En la sala de espera: pidió entrar y nadie de dentro ha decidido todavía.
  const [esperando, setEsperando] = useState(false);

  const estado = useVoice((s) => s.estado);
  const errorDeLlamada = useVoice((s) => s.error);
  const entrarComoInvitado = useVoice((s) => s.entrarComoInvitado);

  useEffect(() => {
    if (!token) {
      setFallo("invite-invalid");
      return;
    }
    publicCalls
      .inspect(token)
      .then(setInfo)
      .catch((e) => setFallo(codigoDe(e) || "invite-invalid"));
  }, [token]);

  /** Con una respuesta de la puerta: esperar, o entrar si ya le dejaron. */
  const seguir = async (entrada: GuestEntryResponse) => {
    guardar(globalThis.sessionStorage, paseDe(token), entrada.pass);
    if (entrada.status !== "admitted" || !entrada.token || !entrada.url) {
      setEsperando(true);
      return;
    }
    setEsperando(false);
    setEntro(true);
    await entrarComoInvitado({
      url: entrada.url,
      token: entrada.token,
      room: entrada.room ?? "",
      identity: entrada.identity ?? "",
      name: entrada.name,
      pass: entrada.pass,
      title: entrada.title,
    });
    const v = useVoice.getState();
    if (v.estado === "dentro") {
      if (!conMic && v.mic) await v.alternarMic();
      if (conCamara && !v.cam) await v.alternarCam();
    }
  };

  const entrar = async () => {
    const limpio = nombre.trim();
    if (!limpio || entrando) return;
    setEntrando(true);
    setFallo(null);
    try {
      const pase = leer(globalThis.sessionStorage, paseDe(token));
      const entrada = await publicCalls.join(token, limpio, pase || null);
      guardar(globalThis.localStorage, NOMBRE, limpio);
      await seguir(entrada);
    } catch (e) {
      setEsperando(false);
      setFallo(codigoDe(e) || String((e as Error)?.message ?? e));
      // Rechazado, echado o cerrado: ya no hay nada que esperar.
      setEntro(true);
    } finally {
      setEntrando(false);
    }
  };

  // Mientras espera, pregunta cada pocos segundos. **Es el servidor quien da la
  // entrada**: sin que alguien de dentro le deje, la respuesta no trae token.
  useEffect(() => {
    if (!esperando) return;
    let vivo = true;
    const id = setInterval(() => {
      const pase = leer(globalThis.sessionStorage, paseDe(token));
      if (!pase) return;
      publicCalls
        .status(token, pase)
        .then((r) => {
          if (vivo && r.status === "admitted") void seguir(r);
        })
        .catch((e) => {
          if (!vivo) return;
          setEsperando(false);
          setFallo(codigoDe(e) || "invite-invalid");
          setEntro(true);
        });
    }, ESPERA_MS);
    return () => {
      vivo = false;
      clearInterval(id);
    };
    // `seguir` cambia en cada render y no tiene por qué reiniciar la espera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esperando, token]);

  if (esperando) {
    return (
      <Pantalla>
        <CardHeader>
          <CardDescription>{info?.title}</CardDescription>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> {t("calls:waitingTitle")}
          </CardTitle>
          <CardDescription>{t("calls:waitingBody")}</CardDescription>
        </CardHeader>
      </Pantalla>
    );
  }

  if (estado !== "fuera") {
    return (
      <div className="flex h-dvh min-h-0 flex-col bg-background">
        <VoiceStage />
      </div>
    );
  }

  // Ya estuvo dentro: se fue, lo sacaron o se cerró.
  if (entro && !entrando) {
    const removed = errorDeLlamada === phraseFor("voice-removed", "");
    const closed = errorDeLlamada === phraseFor("voice-room-closed", "");
    const cerrada = fallo === "invite-revoked" || fallo === "invite-expired";
    return (
      <Pantalla>
        <CardHeader>
          <CardTitle>
            {fallo === "guest-rejected"
              ? t("calls:rejectedTitle")
              : removed || fallo === "guest-removed"
              ? t("calls:removedTitle")
              : closed || cerrada
                ? t("calls:closedTitle")
                : t("calls:leftTitle")}
          </CardTitle>
          {info && <CardDescription>{info.title}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {fallo && !cerrada && fallo !== "guest-removed" && fallo !== "guest-rejected" && (
            <p role="alert" className="text-sm text-destructive">
              {phraseFor(fallo, fallo)}
            </p>
          )}
          {!fallo && errorDeLlamada && !removed && !closed && (
            <p role="alert" className="text-sm text-destructive">
              {errorDeLlamada}
            </p>
          )}
          {/* A quien se sacó no se le ofrece volver: su pase ya no sirve, y un
              botón que siempre falla es peor que ninguno. */}
          {!removed && !closed && !cerrada && fallo !== "guest-removed" && fallo !== "guest-rejected" && (
            <Button onClick={() => void entrar()}>
              <PhoneCall className="size-4" /> {t("calls:rejoin")}
            </Button>
          )}
        </CardContent>
      </Pantalla>
    );
  }

  if (!info) {
    return (
      <Pantalla>
        {fallo ? (
          <CardHeader>
            <CardTitle>{t("calls:unavailableTitle")}</CardTitle>
            <CardDescription role="alert">{phraseFor(fallo, fallo)}</CardDescription>
          </CardHeader>
        ) : (
          <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t("calls:opening")}
          </CardContent>
        )}
      </Pantalla>
    );
  }

  return (
    <Pantalla>
      <CardHeader>
        <CardDescription>{t("calls:fromOrg", { org: info.orgName })}</CardDescription>
        <CardTitle className="text-xl">{info.title}</CardTitle>
        {info.hostName && <CardDescription>{t("calls:invitedBy", { host: info.hostName })}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void entrar();
          }}
        >
          <Vista camara={conCamara} />
          <div className="flex gap-2">
            <Alternar activo={conMic} onClick={() => setConMic((v) => !v)} on={Mic} off={MicOff}>
              {t("calls:microphone")}
            </Alternar>
            <Alternar activo={conCamara} onClick={() => setConCamara((v) => !v)} on={Video} off={VideoOff}>
              {t("calls:camera")}
            </Alternar>
          </div>
          {conMic && <MicLevel />}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="guest-name">{t("calls:yourName")}</Label>
            <Input
              id="guest-name"
              value={nombre}
              maxLength={60}
              autoComplete="name"
              placeholder={t("calls:namePlaceholder")}
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>

          {/* Antes del botón, siempre que se pueda grabar. */}
          {info.recordingPossible && (
            <div
              role="note"
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]",
                info.recordingActive
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "text-muted-foreground",
              )}
            >
              <Circle className="mt-0.5 size-3 shrink-0 fill-current" />
              <span>
                {info.recordingActive ? t("calls:recordingNow") : t("calls:recordingMay", { org: info.orgName })}
              </span>
            </div>
          )}

          {fallo && (
            <p role="alert" className="text-sm text-destructive">
              {phraseFor(fallo, fallo)}
            </p>
          )}

          <Button type="submit" disabled={!nombre.trim() || entrando}>
            {entrando ? <Loader2 className="size-4 animate-spin" /> : <PhoneCall className="size-4" />}
            {entrando ? t("calls:joining") : t("calls:joinCall")}
          </Button>
        </form>
      </CardContent>
    </Pantalla>
  );
}

function Pantalla({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-8">
      <Brand />
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}

function Alternar({
  activo,
  onClick,
  on: On,
  off: Off,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  on: typeof Mic;
  off: typeof Mic;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      onClick={onClick}
      className={cn(
        "flex h-9 flex-1 items-center justify-center gap-2 rounded-md border text-sm",
        activo ? "bg-card" : "border-destructive/40 text-destructive",
      )}
    >
      {activo ? <On className="size-4" /> : <Off className="size-4" />} {children}
    </button>
  );
}

/**
 * La cara antes de entrar. Se abre la cámara sólo si se pide: pedir permiso
 * para la cámara a quien sólo viene a hablar es la forma de que diga que no a
 * todo.
 */
function Vista({ camara }: { camara: boolean }) {
  const { t } = useT();
  const ref = useRef<HTMLVideoElement>(null);
  const [negada, setNegada] = useState(false);

  useEffect(() => {
    if (!camara) return;
    let stream: MediaStream | null = null;
    let vivo = true;
    navigator.mediaDevices
      ?.getUserMedia({ video: true })
      .then((s) => {
        if (!vivo) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        setNegada(false);
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => setNegada(true));
    return () => {
      vivo = false;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [camara]);

  if (!camara) return null;
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border bg-black">
      <video ref={ref} autoPlay playsInline muted className="size-full -scale-x-100 object-cover" />
      {negada && (
        <p className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-white/80">
          {t("calls:previewDenied")}
        </p>
      )}
    </div>
  );
}
