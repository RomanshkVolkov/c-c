import { isWebBuild } from "@/lib/platform";
import { useT, type MessageKey } from "@/lib/i18n";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { publicAccount } from "@/lib/account-links";
import { codigoDe } from "@/lib/api";
import { phraseFor } from "@/lib/server-errors";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Brand } from "@/components/brand/Brand";

const schema = z.object({
  username: z.string().min(1, "common:misc.usernameRequired"),
  password: z.string().min(8, "common:misc.passwordMin8"),
});

type FormData = z.infer<typeof schema>;

export default function Login() {
  const { t } = useT();
  const navigate = useNavigate();
  const { login } = useAuth();
  const continueAsGuest = useAuthStore((s) => s.continueAsGuest);
  const signedIn = useAuthStore((s) => !!s.accessToken);
  const [error, setError] = useState<string | null>(null);

  const enterAsGuest = () => {
    continueAsGuest();
    navigate("/image-tool");
  };

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  // «Olvidé mi contraseña»: la misma tarjeta, con un solo campo. La respuesta
  // es la misma exista o no la cuenta (el servidor no lo dice), así que lo que
  // se enseña después tampoco.
  const [forgot, setForgot] = useState<null | { login: string; sent: boolean; busy: boolean; error: string | null }>(null);
  const askLink = async () => {
    if (!forgot || !forgot.login.trim() || forgot.busy) return;
    setForgot({ ...forgot, busy: true, error: null });
    try {
      await publicAccount.forgot(forgot.login);
      setForgot({ ...forgot, busy: false, sent: true, error: null });
    } catch (err) {
      const code = codigoDe(err) || (err instanceof Error ? err.message : "");
      setForgot({ ...forgot, busy: false, error: phraseFor(code, t("errors:account-failed")) });
    }
  };

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await login(data.username, data.password);
      // Reemplazando: con el login en el historial, «atrás» volvía a él.
      navigate("/overview", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common:misc.authFailed"));
    }
  };

  // Con la sesión abierta no hay nada que hacer aquí. Se llegaba con «atrás»
  // (jose, en la web, 6-oct-2026): el formulario salía como si no hubiera
  // entrado, y atrás y adelante daban vueltas entre él y la app.
  if (signedIn) return <Navigate to="/overview" replace />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">
            <Brand />
          </CardTitle>
          <CardDescription>
            {t("common:misc.signInLead")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {forgot ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void askLink();
              }}
              className="space-y-4"
            >
              <div className="space-y-1">
                <p className="font-medium">{t("common:account.forgotTitle")}</p>
                <p className="text-sm text-muted-foreground">{t("common:account.forgotLead")}</p>
              </div>
              {forgot.sent ? (
                <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
                  {t("common:account.forgotSent")}
                </p>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="forgot-login">{t("common:account.forgotLogin")}</Label>
                  <Input
                    id="forgot-login"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={forgot.login}
                    onChange={(e) => setForgot({ ...forgot, login: e.target.value })}
                  />
                </div>
              )}
              {forgot.error && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {forgot.error}
                </p>
              )}
              {!forgot.sent && (
                <Button type="submit" className="w-full" disabled={!forgot.login.trim() || forgot.busy}>
                  {t("common:account.forgotSend")}
                </Button>
              )}
              <Button type="button" variant="ghost" className="w-full" onClick={() => setForgot(null)}>
                {t("common:account.backToSignIn")}
              </Button>
            </form>
          ) : (<>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t("common:misc.username")}</Label>
              <Input
                id="username"
                placeholder="admin"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                {...register("username")}
              />
              {errors.username && (
                <p className="text-sm text-destructive">
                  {t(errors.username.message as MessageKey)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t("common:misc.password")}</Label>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                {...register("password")}
              />
              {errors.password && (
                <p className="text-sm text-destructive">
                  {t(errors.password.message as MessageKey)}
                </p>
              )}
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setForgot({ login: getValues("username") ?? "", sent: false, busy: false, error: null })}
              >
                {t("common:account.forgot")}
              </button>
            </div>

            {error && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t("common:misc.signingIn") : t("common:misc.signIn")}
            </Button>
          </form>

          {isWebBuild && (
            <Link
              to="/download"
              className="mt-4 block text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("common:download.cta")}
            </Link>
          )}

          {/* Entrar como invitado es para las herramientas del propio equipo
              (imágenes, cripto), que en la versión web no existen. */}
          {!isWebBuild && (<>
          <div className="mt-4 flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="mt-4 w-full"
            onClick={enterAsGuest}
          >
            {t("common:misc.continueAsGuest")}
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Guest access is limited to the on-device tools (Image Tool, Crypto Tools).
          </p>
          </>)}
          </>)}
        </CardContent>
      </Card>
    </div>
  );
}
