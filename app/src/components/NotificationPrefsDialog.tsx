import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useInboxStore, type InboxPrefs } from "@/store/inbox.store";
import { useNotificationsStore, type Delivery } from "@/store/notifications.store";
import { ChevronRight, Eye, MonitorSmartphone, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What you want to be told about.
 *
 * Mentions are not on this list, and that is the point rather than an
 * oversight: somebody naming you is the one thing this product must never
 * quietly swallow, so it is stated as a fact instead of offered as a switch
 * that would do nothing — the server forces it back on regardless.
 */

const OPCIONES: { key: keyof InboxPrefs; label: string; hint: string }[] = [
  { key: "dms", label: "Direct messages", hint: "Somebody writes to you privately." },
  { key: "comments", label: "Comments", hint: "Somebody comments on work you are on." },
  { key: "reports", label: "New reports", hint: "A client raises something through a channel." },
];

/**
 * Si esta máquina llegó a enseñar cada aviso, y si no, por qué.
 *
 * Vive aquí y no en el panel de notificaciones porque no es una noticia: un
 * aviso del sistema que no aparece puede ser la app, el permiso, el demonio de
 * notificaciones del escritorio o una regla suya que calla a esta app, y
 * saberlo sólo importa cuando vienes a preguntarte qué avisos quieres. En el
 * panel obligaba a leer la lista dos veces para encontrar lo mismo.
 */
function RegistroDeEntrega() {
  const items = useNotificationsStore((s) => s.items);
  const clear = useNotificationsStore((s) => s.clear);
  const [abierto, setAbierto] = useState(false);

  return (
    <div className="rounded border">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setAbierto((v) => !v)}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", abierto && "rotate-90")} />
        Delivery log · this session ({items.length})
        {abierto && items.length > 0 && (
          <span
            role="button"
            className="ml-auto hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
          >
            Clear
          </span>
        )}
      </button>
      {abierto && (
        <div className="max-h-56 overflow-auto border-t">
          {items.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing yet. Everything that arrives is recorded here, whether or not the
              system showed it.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const d = DELIVERY[n.delivery];
                const Icon = d.icon;
                return (
                  <li key={n.id} className="px-3 py-2">
                    <p className="flex items-center gap-2 text-xs">
                      <span className="truncate font-medium">{n.title}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {new Date(n.at).toLocaleTimeString()}
                      </span>
                    </p>
                    <p className={cn("flex items-center gap-1 text-[11px]", d.className)}>
                      <Icon className="size-3" />
                      {d.label}
                      {n.error && <span>· {n.error}</span>}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Cómo se llama cada desenlace, y con qué cara se dibuja. */
const DELIVERY: Record<Delivery, { label: string; icon: typeof Eye; className: string }> = {
  os: { label: "sent to the system", icon: MonitorSmartphone, className: "text-muted-foreground" },
  focused: { label: "you were here — the window had focus, so nothing was sent", icon: Eye, className: "text-muted-foreground" },
  failed: { label: "not delivered", icon: TriangleAlert, className: "text-destructive" },
};

export default function NotificationPrefsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const prefs = useInboxStore((s) => s.prefs);
  const loadPrefs = useInboxStore((s) => s.loadPrefs);
  const savePrefs = useInboxStore((s) => s.savePrefs);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) loadPrefs().catch(() => {});
  }, [open, loadPrefs]);

  // Defaults while it loads: everything on, which is what a person with no
  // preferences actually gets. Showing everything off for a moment would be a
  // dialog that lies before it is even used.
  const actual: InboxPrefs = prefs ?? { mentions: true, dms: true, comments: true, reports: true };

  const alternar = async (key: keyof InboxPrefs) => {
    if (busy) return;
    setBusy(true);
    try {
      await savePrefs({ ...actual, [key]: !actual[key] });
    } catch (e) {
      toast.error("Could not save it", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
        </DialogHeader>

        <div className="space-y-1">
          {OPCIONES.map((o) => (
            <button
              key={o.key}
              onClick={() => void alternar(o.key)}
              disabled={busy}
              className="flex w-full items-start gap-3 rounded px-2 py-2 text-left hover:bg-accent"
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                  actual[o.key] ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`size-3 rounded-full bg-background transition-transform ${
                    actual[o.key] ? "translate-x-3" : ""
                  }`}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-sm">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Being mentioned always reaches you. It is the one thing worth
          interrupting somebody for, so it is not a setting.
        </p>

        <RegistroDeEntrega />

        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
