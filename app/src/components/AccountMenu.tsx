import { nombreDe, inicialesDe } from "@/lib/nombres";
import type { ReactNode } from "react";
import { useT, type MessageKey } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  UserRound,
  ChevronsUpDown, KeyRound, Bot, Bell, LogOut, Moon, CheckCircle2, Download, Loader2,
  Languages,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useThemeStore, type ThemePreference } from "@/store/theme.store";
import { useLocaleStore, type LocalePreference } from "@/store/locale.store";
import { chooseLocale } from "@/lib/locale-sync";
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

  /**
   * Una fila de opciones: el rótulo arriba, los botones debajo.
   *
   * En una sola línea no caben. El menú se dimensionó con «Theme · Auto Light
   * Dark» —tres palabras cortas— y la fila del idioma tiene la misma forma con
   * etiquetas más largas: en castellano «Español» se salía por el borde
   * derecho, cortada.
   *
   * Apilar y no ensanchar, y tampoco un submenú. Ensanchar arregla el idioma de
   * hoy y se vuelve a romper con el tercero, o con una traducción más larga de
   * «Auto». Un submenú escala pero esconde cuál está puesto, y en un selector de
   * idioma ver «Español» marcado de un vistazo es medio valor de la pantalla.
   * Apilado cabe siempre, no esconde nada, y los botones se reparten el ancho.
   */
  const filaDeOpciones = (
    icono: ReactNode,
    rotulo: string,
    opciones: { key: string; label: string; activo: boolean; onClick: () => void }[],
  ) => (
    <div className="w-full space-y-1 rounded px-2 py-1.5">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {icono} {rotulo}
      </span>
      <span className="flex gap-0.5">
        {opciones.map((o) => (
          <button
            key={o.key}
            onClick={o.onClick}
            className={cn(
              "flex-1 rounded px-1.5 py-1 text-[11px]",
              o.activo
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );

  return (
    <div ref={caja} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border bg-popover p-1 shadow-lg">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold uppercase text-primary">
              {inicialesDe(session)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{nombreDe(session)}</p>
              {session.email && (
                <p className="truncate text-[11px] text-muted-foreground">{session.email}</p>
              )}
            </div>
          </div>
          <div className="my-1 h-px bg-border" />

          {/* Three choices at once rather than a button that cycles: with a
              cycling control you cannot tell "auto, currently dark" from
              "dark", and those are different answers. */}
          {filaDeOpciones(
            <Moon className="size-3.5 shrink-0" />,
            t("nav:account.theme"),
            THEMES.map((theme) => ({
              key: theme.key,
              label: t(theme.labelKey),
              activo: preference === theme.key,
              onClick: () => setPreference(theme.key),
            })),
          )}

          {filaDeOpciones(
            <Languages className="size-3.5 shrink-0" />,
            t("nav:account.language"),
            LANGUAGES.map((l) => ({
              key: l.key,
              label: l.label || t("nav:account.languageAuto"),
              activo: language === l.key,
              onClick: () => void chooseLocale(l.key),
            })),
          )}

          {/* Encima de «cambiar la contraseña» porque es lo que se busca más:
              la contraseña se toca una vez, el nombre se pone al entrar. */}
          <button
            className={item}
            onClick={() => {
              setOpen(false);
              navigate("/profile");
            }}
          >
            <UserRound className="size-3.5 shrink-0" /> {t("nav:profile.title")}
          </button>
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
                      .then((i) => !i && toast.success(t("common:misc.alreadyLatest")))
                      .catch((e) => toast.error(String(e)))
              }
            >
              {checking ? <Loader2 className="size-3 animate-spin" /> : available ? t("common:misc.install") : t("common:misc.check")}
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
          {inicialesDe(session)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{nombreDe(session)}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", vivo ? "bg-success" : "bg-destructive")}
              title={vivo ? t("common:misc.receivingLive") : t("common:misc.notReceivingLive")}
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
