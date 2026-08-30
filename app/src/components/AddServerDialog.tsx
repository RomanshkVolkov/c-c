import { useT, type MessageKey } from "@/lib/i18n";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NewServerInput } from "@/hooks/use-servers";

const schema = z.object({
  name: z.string().min(1, "common:servers.required"),
  host: z.string().min(1, "common:servers.required"),
  sshPort: z.number().min(1).max(65535),
  sshUser: z.string().min(1, "common:servers.required"),
  type: z.enum(["docker-swarm", "kubernetes"]),
  agentPort: z.number().min(1).max(65535),
});

type FormData = z.infer<typeof schema>;

interface Props {
  onCreated: (payload: NewServerInput) => Promise<unknown>;
}

export default function AddServerDialog({ onCreated }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { sshPort: 22, agentPort: 9090, type: "docker-swarm" },
  });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await onCreated(data);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common:servers.unknownError"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("common:servers.addServer")}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common:servers.addServer")}</DialogTitle>
          <DialogDescription>
            SSH access uses your local SSH agent (1Password recommended). No
            keys are stored or sent by this app.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{t("common:servers.thName")}</Label>
              <Input placeholder="prod-01" {...register("name")} />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {t(errors.name.message as MessageKey)}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Host / IP</Label>
              <Input placeholder="192.168.1.10" {...register("host")} />
              {errors.host && (
                <p className="text-xs text-destructive">
                  {t(errors.host.message as MessageKey)}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label>{t("common:servers.sshUser")}</Label>
              <Input placeholder="root" {...register("sshUser")} />
              {errors.sshUser && (
                <p className="text-xs text-destructive">
                  {t(errors.sshUser.message as MessageKey)}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>{t("common:servers.sshPort")}</Label>
              <Input type="number" {...register("sshPort", { valueAsNumber: true })} />
            </div>
            <div className="space-y-1">
              <Label>{t("common:servers.agentPort")}</Label>
              <Input type="number" {...register("agentPort", { valueAsNumber: true })} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>{t("common:servers.type")}</Label>
            <select
              {...register("type")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="docker-swarm">Docker Swarm</option>
              <option value="kubernetes">Kubernetes</option>
            </select>
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common:servers.cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("common:servers.adding") : t("common:servers.addServer")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
