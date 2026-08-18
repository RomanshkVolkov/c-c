import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Ending an organization, typed out in full.
 *
 * A yes/no dialog is answered by reflex — people click "confirm" on the thing
 * they meant and on the thing they did not, and this one takes the spaces, the
 * tasks and the channels with it, and stops every integration pointing at it.
 * Typing the name is not friction for its own sake: it is the step that cannot
 * be completed while thinking about something else.
 *
 * The server refuses this to anybody below platform level regardless. This is
 * the second lock, not the only one.
 */
export default function DeleteOrgDialog({
  open,
  onOpenChange,
  orgName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgName: string;
  onConfirm: () => Promise<void>;
}) {
  const frase = `delete/${orgName}`;
  const [escrito, setEscrito] = useState("");
  const [busy, setBusy] = useState(false);

  const cerrar = (v: boolean) => {
    if (!v) setEscrito("");
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={cerrar}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete {orgName}?</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          This deletes its spaces, its tasks and its channels. Reports arriving through
          its integrations stop being accepted. It cannot be undone.
        </p>

        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Type <code className="rounded bg-muted px-1 font-mono">{frase}</code> to confirm.
          </p>
          <Input
            autoFocus
            value={escrito}
            onChange={(e) => setEscrito(e.target.value)}
            placeholder={frase}
            aria-label="Confirmation"
            className="font-mono text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => cerrar(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            // Compared exactly, including case: a confirmation you can pass by
            // approximation is a confirmation that stopped confirming.
            disabled={escrito !== frase || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                cerrar(false);
              } catch (e) {
                toast.error("Could not delete it", { description: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
