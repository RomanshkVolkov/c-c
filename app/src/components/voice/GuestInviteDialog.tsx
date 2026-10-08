import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link2, Loader2, PhoneCall, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Picker from "@/components/ui/picker";
import { codigoDe } from "@/lib/api";
import { guestLinkFor } from "@/lib/call-link";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { useCalls, type CallInvite } from "@/store/calls.store";

/**
 * Llamar con gente de fuera desde un canal (W3).
 *
 * Crear la reunión es un formulario con su botón, no un clic suelto: lo que
 * sale de aquí es un enlace que abre una sala a cualquiera que lo tenga, y eso
 * se decide leyendo qué se va a crear. El texto lo dice: **es otra sala**, no
 * la voz del canal — quien entra con el enlace no oye al equipo hablando en el
 * canal ni ve nada de él.
 *
 * Debajo, las que ya están abiertas desde este canal: copiar el enlace otra
 * vez, entrar, o cerrarla.
 */
export default function GuestInviteDialog({
  open,
  onOpenChange,
  orgId,
  spaceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string;
  spaceId: string;
}) {
  const { t, i18n } = useT();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const abiertas = useCalls((s) => s.bySpace[spaceId]);
  const load = useCalls((s) => s.load);
  const create = useCalls((s) => s.create);
  const revoke = useCalls((s) => s.revoke);
  const [titulo, setTitulo] = useState("");
  const [horas, setHoras] = useState("24");
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    if (open) void load(orgId, spaceId).catch(() => {});
  }, [open, orgId, spaceId, load]);

  const copiar = async (inv: CallInvite) => {
    await navigator.clipboard.writeText(guestLinkFor(inv.link));
    toast.success(t("calls:linkCopied"));
  };

  const crear = async () => {
    if (!titulo.trim() || creando) return;
    setCreando(true);
    try {
      const inv = await create({ orgId, spaceId, title: titulo.trim(), ttlHours: Number(horas) });
      setTitulo("");
      await copiar(inv).catch(() => {});
    } catch (e) {
      toast.error(phraseFor(codigoDe(e), String((e as Error)?.message ?? e)));
    } finally {
      setCreando(false);
    }
  };

  const cerrar = async (inv: CallInvite) => {
    const ok = await confirm({
      title: t("calls:closeTitle"),
      description: t("calls:closeBody"),
      confirmText: t("calls:closeAction"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke(inv);
    } catch (e) {
      toast.error(phraseFor(codigoDe(e), String((e as Error)?.message ?? e)));
    }
  };

  const hasta = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("calls:dialogTitle")}</DialogTitle>
          <DialogDescription>{t("calls:dialogBody")}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void crear();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="call-title">{t("calls:titleLabel")}</Label>
            <Input
              id="call-title"
              value={titulo}
              maxLength={120}
              placeholder={t("calls:titlePlaceholder")}
              onChange={(e) => setTitulo(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="call-ttl">{t("calls:validFor")}</Label>
              <Picker
                id="call-ttl"
                value={horas}
                onChange={setHoras}
                options={[
                  { value: "1", label: t("calls:ttl1") },
                  { value: "24", label: t("calls:ttl24") },
                  { value: "168", label: t("calls:ttl168") },
                ]}
              />
            </div>
            <Button type="submit" disabled={!titulo.trim() || creando}>
              {creando ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
              {creando ? t("calls:creating") : t("calls:create")}
            </Button>
          </div>
        </form>

        <div className="mt-2 flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("calls:openCalls")}</h3>
          {(abiertas ?? []).length === 0 && <p className="text-sm text-muted-foreground">{t("calls:noOpenCalls")}</p>}
          {(abiertas ?? []).map((inv) => (
            <div key={inv.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{inv.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("calls:until", { when: hasta(inv.expiresAt) })}
                  {inv.occupants.length > 0 && ` · ${t("calls:inside", { count: inv.occupants.length })}`}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void copiar(inv)} title={t("calls:copyLink")}>
                <Link2 className="size-3.5" />
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`/call/${inv.id}`);
                }}
              >
                <PhoneCall className="size-3.5" /> {t("calls:join")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void cerrar(inv)} title={t("calls:close")}>
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
