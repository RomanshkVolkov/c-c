import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import DecisionLinkPicker, { type PickedLink } from "@/components/docs/DecisionLinkPicker";
import { CheckSquare, Hash, Link2 } from "lucide-react";
import { useT } from "@/lib/i18n";

/**
 * Escribir una decisión, desde el documento o desde una tarjeta.
 *
 * El mismo formulario en los dos sitios porque es la misma cosa, y porque lo
 * que hay que decir —qué se decidió, por qué— no cambia según desde dónde se
 * diga. Lo que cambia es la procedencia, y ésa no la escribe nadie: la pone
 * quien llama.
 *
 * Avisa de que no hay vuelta atrás **antes** de guardar, no después. El registro
 * es append-only, así que una errata se queda; saberlo mientras se escribe es lo
 * que hace que la gente escriba con cuidado en vez de enfadarse luego.
 */

export interface DecisionDraft {
  title: string;
  body: string;
  tag: string;
  /** A qué se aplica, además de de dónde sale (ver `DecisionLink`). */
  taskIds?: string[];
  sectionIds?: string[];
}

export default function DecisionForm({
  open,
  onOpenChange,
  onSubmit,
  orgId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (d: DecisionDraft) => Promise<void>;
  /** Con ella se ofrece enlazar tareas y secciones de la org al escribirla. */
  orgId?: string;
}) {
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [links, setLinks] = useState<PickedLink[]>([]);
  const [picking, setPicking] = useState(false);

  const enviar = async () => {
    if (!title.trim()) return;
    setOcupado(true);
    try {
      const ids = (kind: PickedLink["kind"]) => links.filter((l) => l.kind === kind).map((l) => l.id);
      const draft: DecisionDraft = { title: title.trim(), body: body.trim(), tag: tag.trim() };
      if (links.length > 0) {
        draft.taskIds = ids("task");
        draft.sectionIds = ids("section");
      }
      await onSubmit(draft);
      setTitle("");
      setBody("");
      setTag("");
      setLinks([]);
      onOpenChange(false);
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("work:decisions.record")}</DialogTitle>
          <DialogDescription>{t("work:decisions.noUndo")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="dec-title">{t("work:decisions.title")}</Label>
            <Input
              id="dec-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("work:decisions.titleHint")}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dec-body">{t("work:decisions.body")}</Label>
            <Textarea
              id="dec-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dec-tag">{t("work:decisions.tag")}</Label>
            <Input
              id="dec-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder={t("work:decisions.tagHint")}
            />
          </div>
          {orgId && (
            <div className="space-y-1">
              <Label>{t("work:decisions.appliesTo")}</Label>
              <div className="flex flex-wrap items-center gap-1" data-testid="draft-links">
                {links.map((l) => (
                  <span key={`${l.kind}:${l.id}`} className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
                    {l.kind === "task" ? <CheckSquare className="size-3" /> : <Hash className="size-3" />}
                    {l.label}
                  </span>
                ))}
                <Button size="sm" variant="ghost" type="button" onClick={() => setPicking(true)}>
                  <Link2 className="mr-1 size-3" /> {t("work:decisions.link")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("work:decisions.linkHint")}</p>
              <DecisionLinkPicker open={picking} onOpenChange={setPicking} orgId={orgId} initial={links} onPick={setLinks} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("work:docs.cancel")}
          </Button>
          <Button disabled={ocupado || !title.trim()} onClick={() => void enviar()}>
            {ocupado && <Loader2 className="mr-1 size-3 animate-spin" />}
            {t("work:decisions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
