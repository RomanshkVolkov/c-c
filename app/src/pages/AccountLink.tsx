import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Brand } from "@/components/brand/Brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { startSession } from "@/hooks/use-auth";
import { USERNAME_PATTERN, normalizeUsername, publicAccount, type AccountLinkInfo } from "@/lib/account-links";
import { codigoDe } from "@/lib/api";
import { tokenFromHash } from "@/lib/call-link";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";

/**
 * A donde lleva el enlace del correo: `/app/welcome#<token>` (terminar el
 * registro) o `/app/reset-password#<token>` (contraseña nueva).
 *
 * Fuera de `ProtectedRoute`, como la puerta de invitado: aquí no hay sesión.
 * Primero se mira el enlace sin gastarlo, para saludar a la persona por su
 * nombre o decirle ya que no vale; se gasta al guardar, y entonces se abre la
 * sesión y se entra. Un usuario ocupado no gasta el enlace: se elige otro.
 */
export default function AccountLink({ mode }: { mode: "welcome" | "reset" }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [info, setInfo] = useState<AccountLinkInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    publicAccount
      .inspect(token)
      // Un enlace de restablecer abierto como bienvenida (o al revés) no vale
      // aquí: el servidor lo rechazaría al gastarlo.
      .then((i) => (i.purpose === mode ? setInfo(i) : setInvalid(true)))
      .catch(() => setInvalid(true));
  }, [token, mode]);

  const welcome = mode === "welcome";
  const usernameOk = USERNAME_PATTERN.test(normalizeUsername(username));
  const passwordOk = password.length >= 8;
  const same = password === confirm;
  const ready = passwordOk && same && (!welcome || usernameOk);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = welcome
        ? await publicAccount.welcome(token, username, password)
        : await publicAccount.reset(token, password);
      startSession(session);
      // Reemplazando: «atrás» no tiene que volver a un enlace ya gastado.
      navigate("/overview", { replace: true });
    } catch (err) {
      const code = codigoDe(err) || (err instanceof Error ? err.message : "");
      if (code === "link-invalid") setInvalid(true);
      else setError(phraseFor(code, t("errors:account-failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">
            <Brand />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invalid ? (
            <div className="space-y-3">
              <p className="font-medium">{t("common:account.invalidTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {welcome ? t("common:account.invalidWelcome") : t("common:account.invalidReset")}
              </p>
              <Button className="w-full" onClick={() => navigate("/login", { replace: true })}>
                {t("common:account.goToSignIn")}
              </Button>
            </div>
          ) : !info ? (
            <div className="space-y-3" aria-busy aria-label={t("common:account.checking")}>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-4"
            >
              <div className="space-y-1">
                <p className="font-medium">
                  {welcome ? t("common:account.welcomeTitle", { name: info.name }) : t("common:account.resetTitle")}
                </p>
                <CardDescription>
                  {welcome
                    ? info.orgName
                      ? t("common:account.welcomeLead", { org: info.orgName, email: info.email })
                      : t("common:account.welcomeLeadNoOrg", { email: info.email })
                    : t("common:account.resetLead", { email: info.email })}
                </CardDescription>
              </div>

              {welcome && (
                <div className="space-y-2">
                  <Label htmlFor="username">{t("common:misc.username")}</Label>
                  <Input
                    id="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    aria-invalid={username !== "" && !usernameOk}
                    aria-describedby="username-hint"
                  />
                  <p id="username-hint" className="text-xs text-muted-foreground">
                    {t("common:account.usernameHint")}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">{t("common:misc.password")}</Label>
                <PasswordInput
                  id="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {password !== "" && !passwordOk && (
                  <p className="text-xs text-destructive">{t("common:misc.passwordMin8")}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm">{t("common:account.confirmPassword")}</Label>
                <PasswordInput
                  id="confirm"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {confirm !== "" && !same && (
                  <p className="text-xs text-destructive">{t("common:account.passwordsDiffer")}</p>
                )}
              </div>

              {error && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={!ready || busy}>
                {welcome
                  ? busy
                    ? t("common:account.creating")
                    : t("common:account.createAccount")
                  : busy
                    ? t("common:account.saving")
                    : t("common:account.saveAndEnter")}
              </Button>
            </form>
          )}
          {/* La invitación trae aquí: es el momento de decir que también hay
              app de escritorio. Se abre aparte para no perder el enlace. */}
          {welcome && !invalid && (
            <Link
              to="/download"
              target="_blank"
              className="mt-4 block text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("common:download.cta")}
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
