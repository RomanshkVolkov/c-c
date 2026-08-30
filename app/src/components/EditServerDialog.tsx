import { useT, type MessageKey } from "@/lib/i18n";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NewServerInput } from "@/hooks/use-servers";
import type { Server } from "@/types/server";

const schema = z.object({
  name: z.string().min(1, "common:servers.required"),
  host: z.string().min(1, "common:servers.required"),
  sshPort: z.number().min(1).max(65535),
  sshUser: z.string().min(1, "common:servers.required"),
  type: z.enum(["docker-swarm", "kubernetes"]),
  agentPort: z.number().min(1).max(65535),
});

type FormData = z.infer<typeof schema>;

/**
 * Edits a registered server. Until this existed the only way to fix a wrong
 * host/user/port was to delete and re-create it — and there was no way to even
 * see the stored values.
 */
export default function EditServerDialog({
  server,
  onSave,
  onClose,
}: {
  server: Server;
  onSave: (id: string, payload: NewServerInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: server.name,
      host: server.host,
      sshPort: server.sshPort,
      sshUser: server.sshUser,
      type: server.type,
      agentPort: server.agentPort,
    },
  });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await onSave(server.id, data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {server.name}</DialogTitle>
          <DialogDescription>
            {t("common:servers.connectionDetails")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>{t("common:servers.thName")}</Label>
            <Input {...register("name")} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            {errors.name && <p className="text-xs text-destructive">{t(errors.name.message as MessageKey)}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>{t("common:servers.host")}</Label>
            <Input
              {...register("host")}
              placeholder="192.168.1.10"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {errors.host && <p className="text-xs text-destructive">{t(errors.host.message as MessageKey)}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("common:servers.sshUserLower")}</Label>
              <Input
                {...register("sshUser")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("common:servers.sshPortLower")}</Label>
              <Input type="number" {...register("sshPort", { valueAsNumber: true })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("common:servers.agentPortLower")}</Label>
              <Input type="number" {...register("agentPort", { valueAsNumber: true })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("common:servers.type")}</Label>
              <select
                {...register("type")}
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="docker-swarm">Docker Swarm</option>
                <option value="kubernetes">Kubernetes</option>
              </select>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:servers.cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("common:servers.saving") : t("common:servers.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
