import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import FileDropZone from "@/components/FileDropZone";
import MarkdownEditor, { type MarkdownEditorHandle } from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { codigoDe } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/store/people.store";
import { usePostsStore } from "@/store/posts.store";
import type { PostAudience } from "@/types/post";

/**
 * Publicar en el muro. Quién puede, lo dice quien lo abre (`canFeedback`,
 * `canAnnounce`); el servidor lo vuelve a mirar.
 *
 * - Un feedback va en nombre de la organización actual, y quien publica elige
 *   para quién: sólo para cac o para todas las organizaciones.
 * - Un superadmin puede, además, publicarlo como comunicado: lo ven todas y va
 *   destacado arriba. Un superadmin que no es de la org actual sólo tiene eso.
 */
export default function PostComposer({
  open,
  onOpenChange,
  orgId,
  orgName,
  canFeedback,
  canAnnounce,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string | null;
  /** Para decir «Solo Dwit México» y no «Solo cac», que desde la org que opera cac se lee raro. */
  orgName?: string;
  canFeedback: boolean;
  canAnnounce: boolean;
}) {
  const { t } = useT();
  const { create, upload } = usePostsStore.getState();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<PostAudience>("platform");
  const [announce, setAnnounce] = useState(!canFeedback && canAnnounce);
  const [busy, setBusy] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const people = useCallback(() => usePeopleStore.getState().current(), []);

  const asAnnouncement = announce || !canFeedback;
  const ready = body.trim() !== "" && !busy && (asAnnouncement ? canAnnounce : canFeedback && !!orgId);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await create(
        asAnnouncement
          ? { kind: "announcement", title: title.trim(), body }
          : { kind: "feedback", orgId: orgId ?? undefined, audience, title: title.trim(), body },
      );
      setTitle("");
      setBody("");
      onOpenChange(false);
    } catch (e) {
      toast.error(phraseFor(codigoDe(e) || (e instanceof Error ? e.message : ""), t("common:feedback.failed")));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File) => {
    try {
      return await upload(file);
    } catch (e) {
      toast.error(phraseFor(codigoDe(e) || (e instanceof Error ? e.message : ""), t("common:feedback.failed")));
      return null;
    }
  };

  const option = (value: PostAudience, label: string, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={audience === value}
      onClick={() => setAudience(value)}
      className={cn(
        "flex-1 rounded-lg border px-3 py-2 text-left transition-colors",
        audience === value ? "border-primary bg-primary/10" : "hover:bg-muted",
      )}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("common:feedback.publish")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label={t("common:feedback.titlePlaceholder")}
            placeholder={t("common:feedback.titlePlaceholder")}
            value={title}
            maxLength={140}
            onChange={(e) => setTitle(e.target.value)}
          />
          <FileDropZone className="rounded-md border" onFiles={(fs) => editor.current?.insertFiles(fs)}>
            <MarkdownEditor
              ref={editor}
              value={body}
              onChange={setBody}
              onUpload={onUpload}
              people={people}
              minHeight="8rem"
              maxHeight="50vh"
              placeholder={t("common:feedback.bodyPlaceholder")}
            />
          </FileDropZone>

          {canAnnounce && canFeedback && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
              <span>
                <span className="block font-medium">{t("common:feedback.asAnnouncement")}</span>
                <span className="block text-xs text-muted-foreground">{t("common:feedback.asAnnouncementHint")}</span>
              </span>
            </label>
          )}

          {!asAnnouncement && (
            <div className="space-y-1.5">
              <Label>{t("common:feedback.audience")}</Label>
              <div role="radiogroup" aria-label={t("common:feedback.audience")} className="flex gap-2">
                {orgName
                  ? option("platform", t("common:feedback.audienceOrg", { org: orgName }), t("common:feedback.audienceOrgHint", { org: orgName }))
                  : option("platform", t("common:feedback.audiencePlatform"), t("common:feedback.audiencePlatformHint"))}
                {option("everyone", t("common:feedback.audienceEveryone"), t("common:feedback.audienceEveryoneHint"))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={!ready}>
              {busy ? t("common:feedback.publishing") : t("common:feedback.publish")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
