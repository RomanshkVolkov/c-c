import { useEffect, useState } from "react";
import { Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, refreshSession } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";

/**
 * Tus propios datos.
 *
 * No existía: hasta ahora el nombre de alguien sólo lo podía poner un superadmin
 * desde la pantalla de usuarios, y eso dejaba a todo el mundo sin forma de
 * decidir cómo se le llama. Se notó al empezar a enseñar el nombre en vez del
 * usuario por toda la aplicación — el sitio para escribirlo no estaba.
 *
 * Deliberadamente corta. El idioma y el tema ya viven en el menú de la cuenta,
 * que es donde se buscan, y la contraseña tiene su propio camino porque pide la
 * actual. Meterlo todo aquí sería una pantalla de ajustes, que es otra cosa y
 * nadie ha pedido.
 */
export default function Profile() {
  const { t } = useT();
  const session = useAuthStore((s) => s.session);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guardando, setGuardando] = useState(false);

  // Del store y no de un fetch propio: la sesión ya está cargada, y pedirla otra
  // vez sólo añadiría un parpadeo con los campos vacíos.
  useEffect(() => {
    setName(session?.name ?? "");
    setEmail(session?.email ?? "");
  }, [session?.name, session?.email]);

  const guardar = async () => {
    setGuardando(true);
    try {
      await api.patch<APIResponse<unknown>>("/api/v1/auth/me", {
        name: name.trim(),
        email: email.trim(),
      });
      // Y se relee la sesión: el nombre se pinta desde ahí en el menú de la
      // cuenta y en media aplicación, así que sin esto se guardaría bien y se
      // seguiría viendo el de antes hasta reiniciar.
      await refreshSession();
      toast.success(t("nav:profile.saved"));
    } catch (e) {
      toast.error(t("nav:profile.errSave"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setGuardando(false);
    }
  };

  if (!session) return null;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto w-full max-w-lg space-y-5">
        <header className="flex items-center gap-2">
          <UserRound className="size-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{t("nav:profile.title")}</h1>
        </header>
        <p className="text-sm text-muted-foreground">{t("nav:profile.lead")}</p>

        <section className="space-y-1.5">
          <Label htmlFor="perfil-nombre">{t("nav:profile.name")}</Label>
          <Input
            id="perfil-nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("nav:profile.namePlaceholder")}
          />
          <p className="text-xs text-muted-foreground">{t("nav:profile.nameHelp")}</p>
        </section>

        <section className="space-y-1.5">
          <Label htmlFor="perfil-correo">{t("nav:profile.email")}</Label>
          <Input
            id="perfil-correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("nav:profile.emailHelp")}</p>
        </section>

        {/* El usuario se enseña y no se edita: es el identificador, y cambiarlo
            rompería las menciones que ya están escritas en hilos y tarjetas. */}
        <section className="space-y-1.5">
          <Label>{t("nav:profile.username")}</Label>
          <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
            {session.username}
          </p>
          <p className="text-xs text-muted-foreground">{t("nav:profile.usernameHelp")}</p>
        </section>

        <Button onClick={() => void guardar()} disabled={guardando}>
          {guardando && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          {guardando ? t("nav:profile.saving") : t("nav:profile.save")}
        </Button>
      </div>
    </div>
  );
}
