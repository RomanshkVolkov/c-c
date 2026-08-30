import { useT, type MessageKey } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronsUpDown, KeyRound, Bot, Bell, LogOut, Moon, CheckCircle2, Download, Loader2,
  Languages,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useThemeStore, type ThemePreference } from "@/store/theme.store";
import { useLocaleStore, type LocalePreference } from "@/store/locale.store";
import { useUpdaterStore } from "@/store/updater.store";
import { useConnectionStore } from "@/store/connection.store";
import { useAuth } from "@/hooks/use-auth";
import { useAppVersion } from "@/hooks/use-app-version";
import { cn } from "@/lib/utils";

/**
 * The account, and everything that is about you rather than about the work.
 *
 * These were six rows stacked at the bottom of the sidebar, which put "change
 * my password" at the same level as the navigation above it and made the last
 * thing in the list — logging out — the easiest to hit by accident. Folded into
 * one row that opens, the sidebar ends with who you are and the rest is a
 * decision you have to make on purpose.
 */

/**
 * Los idiomas, con la misma forma que los temas y por el mismo motivo: «Auto» y
 * «Auto, ahora mismo castellano» son respuestas distintas, y un botón que rota
 * no deja decir cuál de las dos es.
 *
 * Los nombres van **cada uno en su idioma** —«English», «Español»— y no
 * traducidos: quien busca su idioma en una lista lo busca escrito como él lo
 * escribe, no como lo escribe el idioma que no entiende.
 */
const LANGUAGES: { key: LocalePreference; label: string }[] = [
  // «Auto» sí se traduce —es una palabra del producto— pero los nombres de los
  // idiomas **no**: quien busca el suyo en una lista lo busca escrito como él lo
  // escribe, no como lo escribe el idioma que no entiende.
  { key: "system", label: "" },
  { key: "en", label: "English" },
  { key: "es", label: "Español" },
];

const THEMES: { key: ThemePreference; labelKey: MessageKey }[] = [
  { key: "system", labelKey: "nav:account.themeAuto" },
  { key: "light", labelKey: "nav:account.themeLight" },
  { key: "dark", labelKey: "nav:account.themeDark" },
];

export default function AccountMenu({
  onChangePassword,
  onConnectMcp,
  onNotificationPrefs,
}: {
  onChangePassword: () => void;
  onConnectMcp: () => void;
  onNotificationPrefs: () => void;
}) {
  const [open, setOpen] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const session = useAuthStore((s) => s.session);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const org = useOrgsStore((s) => s.currentOrg());
  const { t } = useT();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const language = useLocaleStore((s) => s.preference);
  const setLanguage = useLocaleStore((s) => s.setPreference);
  const version = useAppVersion();
  const available = useUpdaterStore((s) => s.available);
  const checking = useUpdaterStore((s) => s.checking);
  const checkForUpdate = useUpdaterStore((s) => s.checkForUpdate);
  const installUpdate = useUpdaterStore((s) => s.installUpdate);
  // The dot is the live stream, not the last request: a console that stopped
  // receiving events looks fine until something should have moved and didn't.
  const stream = useConnectionStore((s) => s.stream);
  const { logout } = useAuth();
  const navigate = useNavigate();

  // Click-away and Escape, because a menu that only closes by re-clicking the
  // row it came from is a menu people leave open.
  useEffect(() => {
    if (!open) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setOpen(false);
    };
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", fuera);
    window.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      window.removeEventListener("keydown", tecla);
    };
  }, [open]);

  if (!session) return null;
  const vivo = stream === "open" || stream === "idle";
  const rol = superadmin ? "superadmin" : (org?.role ?? "");

  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <div ref={caja} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border bg-popover p-1 shadow-lg">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold uppercase text-primary">
              {session.username.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{session.username}</p>
              {session.email && (
                <p className="truncate text-[11px] text-muted-foreground">{session.email}</p>
              )}
            </div>
          </div>
          <div className="my-1 h-px bg-border" />

          {/* Three choices at once rather than a button that cycles: with a
              cycling control you cannot tell "auto, currently dark" from
              "dark", and those are different answers. */}
          <div className={cn(item, "hover:bg-transparent hover:text-muted-foreground")}>
            <Moon className="size-3.5 shrink-0" /> {t("nav:account.theme")}
            <span className="ml-auto flex gap-0.5">
              {THEMES.map((theme) => (
                <button
                  key={theme.key}
                  onClick={() => setPreference(theme.key)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    preference === theme.key
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent hover:text-foreground",
                  )}
                >
                  {t(theme.labelKey)}
                </button>
              ))}
            </span>
          </div>

          <div className={cn(item, "hover:bg-transparent hover:text-muted-foreground")}>
            <Languages className="size-3.5 shrink-0" /> {t("nav:account.language")}
            <span className="ml-auto flex gap-0.5">
              {LANGUAGES.map((l) => (
                <button
                  key={l.key}
                  onClick={() => setLanguage(l.key)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    language === l.key
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent hover:text-foreground",
                  )}
                >
                  {l.label || t("nav:account.languageAuto")}
                </button>
              ))}
            </span>
          </div>

          <button className={item} onClick={() => { setOpen(false); onChangePassword(); }}>
            <KeyRound className="size-3.5 shrink-0" /> {t("nav:account.changePassword")}
          </button>
          <button className={item} onClick={() => { setOpen(false); onConnectMcp(); }}>
            <Bot className="size-3.5 shrink-0" /> Connect Claude Code
          </button>
          <button className={item} onClick={() => { setOpen(false); onNotificationPrefs(); }}>
            <Bell className="size-3.5 shrink-0" /> Notifications
          </button>

          <div className="my-1 h-px bg-border" />

          <div className={cn(item, "hover:bg-transparent hover:text-muted-foreground")}>
            {available ? (
              <Download className="size-3.5 shrink-0 text-primary" />
            ) : (
              <CheckCircle2 className="size-3.5 shrink-0 text-success" />
            )}
            <span className="min-w-0 truncate">
              <span className="font-mono">{version ? `v${version}` : "—"}</span>
              <span className="text-muted-foreground">
                {available ? ` · v${available.version} ready` : " · up to date"}
              </span>
            </span>
            <button
              className="ml-auto shrink-0 text-[11px] text-primary hover:underline"
              onClick={() =>
                available
                  ? installUpdate()
                  : checkForUpdate()
                      .then((i) => !i && toast.success("Already the latest"))
                      .catch((e) => toast.error(String(e)))
              }
            >
              {checking ? <Loader2 className="size-3 animate-spin" /> : available ? "Install" : "Check"}
            </button>
          </div>

          <button
            className={cn(item, "text-destructive hover:text-destructive")}
            onClick={() => {
              setOpen(false);
              logout();
              navigate("/login");
            }}
          >
            <LogOut className="size-3.5 shrink-0" /> {t("nav:account.logOut")}
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold uppercase text-primary">
          {session.username.slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{session.username}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", vivo ? "bg-success" : "bg-destructive")}
              title={vivo ? "Receiving live updates" : "Not receiving live updates"}
            />
            <span className="truncate">
              {rol}
              {version && ` · v${version}`}
            </span>
          </span>
        </span>
        <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}
