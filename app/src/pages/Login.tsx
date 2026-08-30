import { useT, type MessageKey } from "@/lib/i18n";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [error, setError] = useState<string | null>(null);

  const enterAsGuest = () => {
    continueAsGuest();
    navigate("/image-tool");
  };

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await login(data.username, data.password);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common:misc.authFailed"));
    }
  };

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
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register("password")}
              />
              {errors.password && (
                <p className="text-sm text-destructive">
                  {t(errors.password.message as MessageKey)}
                </p>
              )}
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
        </CardContent>
      </Card>
    </div>
  );
}
