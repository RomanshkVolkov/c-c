import { useCallback, useRef, useState } from "react";
import { Megaphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ReactionPicker, Reactions } from "@/components/chat/Reactions";
import { useConfirm } from "@/components/ConfirmDialog";
import FileDropZone from "@/components/FileDropZone";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor, { type MarkdownEditorHandle } from "@/components/markdown/MarkdownEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { codigoDe } from "@/lib/api";
import { desde, iniciales } from "@/lib/desde";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { usePeopleStore } from "@/store/people.store";
import { usePostsStore } from "@/store/posts.store";

/**
 * Una publicación abierta: entera, con sus reacciones y sus comentarios, como
 * al abrir una en un muro. Comentar usa el mismo editor que el chat (pegar o
 * arrastrar imágenes, `@` para mencionar).
 */
export default function PostModal() {
  const { t } = useT();
  const confirm = useConfirm();
  const post = usePostsStore((s) => s.open);
  const { closePost, react, comment, remove, removeComment, upload } = usePostsStore.getState();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const people = useCallback(() => usePeopleStore.getState().current(), []);

  if (!post) return null;
  const announcement = post.kind === "announcement";
  const failed = (e: unknown) =>
    toast.error(phraseFor(codigoDe(e) || (e instanceof Error ? e.message : ""), t("common:feedback.failed")));

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await comment(post.id, body);
      setDraft("");
    } catch (e) {
      failed(e);
    } finally {
      setSending(false);
    }
  };

  const deletePost = async () => {
    const ok = await confirm({
      title: t("common:feedback.deleteTitle"),
      description: t("common:feedback.deleteBody"),
      confirmText: t("common:feedback.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove(post.id);
      toast.success(t("common:feedback.deleted"));
    } catch (e) {
      failed(e);
    }
  };

  const deleteComment = async (id: string) => {
    const ok = await confirm({
      title: t("common:feedback.deleteCommentTitle"),
      confirmText: t("common:feedback.delete"),
      destructive: true,
    });
    if (!ok) return;
    await removeComment(post.id, id).catch(failed);
  };

  const onUpload = async (file: File) => {
    try {
      return await upload(file);
    } catch (e) {
      failed(e);
      return null;
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closePost()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-6">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-bold">
              {announcement ? <Megaphone className="size-4" /> : iniciales(post.authorName)}
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{post.title || post.authorName}</DialogTitle>
              <DialogDescription className="truncate">
                {[post.authorName, post.orgName, desde(post.createdAt)].filter(Boolean).join(" · ")}
              </DialogDescription>
            </div>
            {announcement ? (
              <Badge variant="secondary">{t("common:feedback.announcement")}</Badge>
            ) : (
              <Badge variant="outline">
                {post.audience === "everyone" ? t("common:feedback.audienceEveryone") : t("common:feedback.audiencePlatform")}
              </Badge>
            )}
            {post.canDelete && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common:feedback.delete")}
                title={t("common:feedback.delete")}
                onClick={() => void deletePost()}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="text-sm">
            <Markdown>{post.body}</Markdown>
          </div>
          <Reactions reactions={post.reactions} onReact={(emoji, on) => react(post.id, emoji, on)} />
          {/* Sin ninguna, `Reactions` no pinta nada: el selector va solo,
              para poder poner la primera. */}
          {post.reactions.length === 0 && (
            <ReactionPicker
              reactions={[]}
              onReact={(emoji, on) => react(post.id, emoji, on).catch(failed)}
              className="h-7 rounded-full border px-2"
            />
          )}

          <section className="space-y-3 border-t pt-3">
            {post.commentList.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("common:feedback.noComments")}</p>
            ) : (
              post.commentList.map((c) => (
                <div key={c.id} className="group flex gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
                    {iniciales(c.authorName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{c.authorName}</span>
                      {desde(c.createdAt)}
                      {c.canDelete && (
                        <button
                          type="button"
                          className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                          aria-label={t("common:feedback.delete")}
                          onClick={() => void deleteComment(c.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="text-sm">
                      <Markdown>{c.body}</Markdown>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>

        <FileDropZone className="shrink-0 border-t pt-3" onFiles={(fs) => editor.current?.insertFiles(fs)}>
          <MarkdownEditor
            ref={editor}
            value={draft}
            onChange={setDraft}
            onUpload={onUpload}
            people={people}
            minHeight="2.5rem"
            maxHeight="30vh"
            onSubmit={() => void send()}
            placeholder={t("common:feedback.commentPlaceholder")}
          />
        </FileDropZone>
      </DialogContent>
    </Dialog>
  );
}
