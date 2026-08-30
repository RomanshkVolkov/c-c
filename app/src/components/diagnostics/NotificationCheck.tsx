import { useT } from "@/lib/i18n";
import { useState } from "react";
import { toast } from "sonner";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Does this desktop accept notifications at all?
 *
 * It used to be a button at the top of the notifications panel, where it read
 * as something you might want to do rather than as a check. It is a check —
 * "no notification appeared" is otherwise impossible to tell apart from "the
 * event never happened", and the delivery log next to it only records what the
 * app tried, not whether the desktop did anything with it.
 */
export default function NotificationCheck() {
  const { t } = useT();
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
        toast.error(t("common:last.permissionRefused"), {
          description: "cac can't post notifications on this desktop.",
        });
        return;
      }
      sendNotification({
        title: "cac — test",
        body: t("common:last.testBody"),
      });
      // Deliberately not "sent": the plugin hands it to the desktop and doesn't
      // hear back, so claiming success would be a guess. Only you can confirm.
      toast.success(t("common:last.handedToSystem"), {
        description: t("common:last.handedToSystemBody"),
      });
    } catch (e) {
      toast.error(t("common:last.couldNotSend"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={sendTest} disabled={testing}>
        <Bell className="mr-1 size-3" /> Send a test notification
      </Button>
      <span className="text-xs text-muted-foreground">
        {t("common:last.checksDesktop")}
      </span>
    </div>
  );
}
