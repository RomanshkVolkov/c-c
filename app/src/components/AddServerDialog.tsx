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
import { Textarea } from "@/components/ui/textarea";
import type { CreateServerPayload } from "@/types/server";

const schema = z.object({
  name:          z.string().min(1, "Required"),
  host:          z.string().min(1, "Required"),
  sshPort:       z.coerce.number().min(1).max(65535).default(22),
  sshUser:       z.string().min(1, "Required"),
  type:          z.enum(["docker-swarm", "kubernetes"]),
  agentPort:     z.coerce.number().min(1).max(65535).default(9090),
  sshPrivateKey: z.string().min(1, "Required"),
});

type FormData = z.infer<typeof schema>;

interface Props {
  onCreated: (payload: CreateServerPayload) => Promise<unknown>;
}

export default function AddServerDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { sshPort: 22, agentPort: 9090, type: "docker-swarm" } });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await onCreated(data);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild={false}>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Server
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
          <DialogDescription>
            SSH credentials are stored securely in your OS keychain and never sent to the database.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input placeholder="prod-01" {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Host / IP</Label>
              <Input placeholder="192.168.1.10" {...register("host")} />
              {errors.host && <p className="text-xs text-destructive">{errors.host.message}</p>}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label>SSH User</Label>
              <Input placeholder="root" {...register("sshUser")} />
              {errors.sshUser && <p className="text-xs text-destructive">{errors.sshUser.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>SSH Port</Label>
              <Input type="number" {...register("sshPort")} />
            </div>
            <div className="space-y-1">
              <Label>Agent Port</Label>
              <Input type="number" {...register("agentPort")} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Type</Label>
            <select
              {...register("type")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="docker-swarm">Docker Swarm</option>
              <option value="kubernetes">Kubernetes</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label>SSH Private Key</Label>
            <Textarea
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="font-mono text-xs h-32 resize-none"
              {...register("sshPrivateKey")}
            />
            <p className="text-xs text-muted-foreground">
              Stored in your OS keychain (Keychain Access / Secret Service). Never saved to the database.
            </p>
            {errors.sshPrivateKey && <p className="text-xs text-destructive">{errors.sshPrivateKey.message}</p>}
          </div>

          {error && <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Adding..." : "Add Server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
