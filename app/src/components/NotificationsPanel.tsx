import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Check, Trash2, TriangleAlert, Eye, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { useNotificationsStore, type Delivery } from "@/store/notifications.store";
import { cn } from "@/lib/utils";

/**
 * What arrived and what the system was told, plus a way to prove the path works.
 *
 * The test button is the point of the panel as much as the list is: an OS
 * notification that doesn't appear could be the app, the permission, the
 * desktop's notification daemon, or a rule in it that silences this app. Trying
 * it on demand and saying what came back separates those, instead of leaving
 * "I didn't see anything" as the only evidence.
 */

const DELIVERY: Record<Delivery, { label: string; icon: typeof Bell; className: string }> = {
  os: { label: "sent to the system", icon: MonitorSmartphone, className: "text-muted-foreground" },
  focused: { label: "you were here", icon: Eye, className: "text-muted-foreground" },
  failed: { label: "not delivered", icon: TriangleAlert, className: "text-destructive" },
};

export default function NotificationsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const items = useNotificationsStore((s) => s.items);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);
  const [testing, setTesting] = useState(false);

  const sendTest = async () => {
    setTesting(true);
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) {
        toast.error("The system refused permission", {
          description: "cac can't post notifications on this desktop.",
        });
        return;
      }
      sendNotification({
        title: "cac — test",
        body: "If you can see this, notifications work.",
      });
      // Deliberately not "sent": the plugin hands it to the desktop and doesn't
      // hear back, so claiming success would be a guess. Only you can confirm.
      toast.success("Handed to the system", {
        description: "If nothing appeared, the desktop is silencing it — check its notification settings.",
      });
    } catch (e) {
      toast.error("Couldn't send it", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (v) markAllRead(); }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Bell className="size-4" /> Notifications
          </SheetTitle>
        </SheetHeader>

        <div className="flex items-center gap-2 border-b px-4 pb-3">
          <Button size="sm" variant="outline" onClick={sendTest} disabled={testing}>
            Send a test
          </Button>
          {items.length > 0 && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={clear}>
              <Trash2 className="mr-1 size-3" /> Clear
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Nothing yet. Everything that arrives is recorded here, whether or not the
              system showed it.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const d = DELIVERY[n.delivery];
                const Icon = d.icon;
                return (
                  <li key={n.id}>
                    <button
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left hover:bg-accent/50",
                        !n.read && "bg-primary/5",
                      )}
                      onClick={() => {
                        if (!n.reportId) return;
                        onOpenChange(false);
                        navigate(`/reports?open=${n.reportId}`);
                      }}
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="truncate text-sm font-medium">{n.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {new Date(n.at).toLocaleString()}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{n.body}</p>
                      <p className={cn("flex items-center gap-1 text-xs", d.className)}>
                        <Icon className="size-3" />
                        {d.label}
                        {n.error && <span>· {n.error}</span>}
                        <span className="text-muted-foreground/60">· {n.kind}</span>
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {items.some((i) => i.delivery === "focused") && (
          <p className="flex items-start gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground">
            <Check className="mt-0.5 size-3 shrink-0" />
            «You were here» means the window had focus, so it wasn't sent — you'd already
            have seen the toast.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
