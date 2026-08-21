import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ImageDown, Send, KeyRound, Mic, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAuthStore } from "@/store/auth.store";
import { cn } from "@/lib/utils";

/**
 * The three on-device tools, under one roof.
 *
 * They were three unrelated entries in a menu of ten, which said they had as
 * much to do with each other as Tasks has with Users. They don't: none of them
 * touches the product's data, two of them work with no account at all, and a
 * person reaching for one is in a different frame of mind than someone doing
 * their work. Grouping them says that.
 */

const TOOLS = [
  { to: "image", label: "Image", icon: ImageDown, guest: true },
  { to: "requests", label: "Requests", icon: Send, guest: false },
  // Renamed from "Crypto": what it actually does is read and sign tokens, and
  // "crypto" now says something else entirely to most people.
  { to: "tokens", label: "Tokens", icon: KeyRound, guest: true },
  // La Fase 0 de los canales de voz: interroga al webview. Ver VoiceLab.tsx.
  { to: "voice", label: "Voice lab", icon: Mic, guest: true },
];

export default function DevTools() {
  const [open, setOpen] = useState(true);
  // Signed out, the two that need no backend are the only ones that could work.
  // Listing the third and bouncing whoever clicks it to a login screen would be
  // an invitation the app then refuses.
  const authed = useAuthStore((s) => !!s.accessToken);
  const tools = TOOLS.filter((t) => authed || t.guest);

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r bg-muted/10 transition-[width]",
          open ? "w-[200px]" : "w-[46px]",
        )}
      >
        <div className="flex h-11 shrink-0 items-center border-b px-2">
          {open && <span className="px-1 text-xs font-medium text-muted-foreground">DevTools</span>}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title={open ? "Collapse" : "Expand"}
            aria-label={open ? "Collapse the tool rail" : "Expand the tool rail"}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 p-1">
          {tools.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              title={t.label}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                  open ? "" : "justify-center",
                  isActive
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <t.icon className="size-4 shrink-0" />
              {open && <span className="truncate">{t.label}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
