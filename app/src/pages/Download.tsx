import { useEffect, useState } from "react";
import { Download as DownloadIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Brand } from "@/components/brand/Brand";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RELEASES_URL,
  detectOS,
  fetchLatestDownloads,
  type Download,
  type DownloadKind,
  type LatestDownloads,
} from "@/lib/app-downloads";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";

const LABEL: Record<DownloadKind, MessageKey> = {
  windows: "common:download.windows",
  mac: "common:download.mac",
  appimage: "common:download.appimage",
  deb: "common:download.deb",
  rpm: "common:download.rpm",
};

const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

/**
 * Las descargas de la app de escritorio, en la web: `/app/download`.
 *
 * Fuera de `ProtectedRoute`, como el alta: se llega desde la invitación, y
 * quien la abre puede no tener cuenta todavía. El instalador de su sistema va
 * primero; los demás, debajo.
 */
export default function DownloadPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const signedIn = useAuthStore((s) => s.isAuthenticated());
  const [latest, setLatest] = useState<LatestDownloads | null>(null);
  const [failed, setFailed] = useState(false);
  const os = detectOS(navigator.userAgent);

  useEffect(() => {
    fetchLatestDownloads().then(setLatest).catch(() => setFailed(true));
  }, []);

  const mine: Download | undefined = latest?.downloads.find((d) => d.os === os);
  const others = latest?.downloads.filter((d) => d !== mine) ?? [];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">
            <Brand />
          </CardTitle>
          <CardDescription>{t("common:download.lead")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {failed ? (
            <p className="text-sm text-muted-foreground">
              {t("common:download.failed")}{" "}
              <a className="text-primary underline-offset-4 hover:underline" href={RELEASES_URL}>
                {t("common:download.allReleases")}
              </a>
            </p>
          ) : !latest ? (
            <div className="space-y-3" aria-busy aria-label={t("common:download.loading")}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <>
              {mine && (
                <a href={mine.url} className={cn(buttonVariants(), "w-full motion-press")}>
                  <DownloadIcon className="size-4" />
                  {t("common:download.forYou", { what: t(LABEL[mine.kind]) })}
                </a>
              )}
              <div className="space-y-1">
                {mine && <p className="text-xs text-muted-foreground">{t("common:download.others")}</p>}
                <ul className="divide-y divide-border rounded-md border">
                  {others.map((d) => (
                    <li key={d.kind}>
                      <a
                        href={d.url}
                        className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                      >
                        <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{t(LABEL[d.kind])}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{mb(d.size)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("common:download.version", { version: latest.version })} ·{" "}
                <a className="underline-offset-4 hover:underline" href={RELEASES_URL}>
                  {t("common:download.allReleases")}
                </a>
              </p>
            </>
          )}
          <Button
            variant="ghost"
            className="w-full motion-press"
            onClick={() => navigate(signedIn ? "/overview" : "/login")}
          >
            {signedIn ? t("common:download.backToApp") : t("common:account.goToSignIn")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
