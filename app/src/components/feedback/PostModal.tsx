import { useCallback, useRef, useState } from "react";
import { Megaphone, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ReactionPicker, Reactions } from "@/components/chat/Reactions";
import { useConfirm } from "@/components/ConfirmDialog";
import FileDropZone from "@/components/FileDropZone";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor, { type MarkdownEditorHandle } from "@/components/markdown/MarkdownEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { codigoDe } from "@/lib/api";
import { desde, iniciales } from "@/lib/desde";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { usePeopleStore } from "@/store/people.store";
import { usePostsStore } from "@/store/posts.store";
import type { PostAudience } from "@/types/post";

/**
 * Una publicación abierta: entera, con sus reacciones y sus comentarios, como
 * al abrir una en un muro. Comentar usa el mismo editor que el chat (pegar o
 * arrastrar imágenes, `@` para mencionar), y cada comentario lleva sus
 * reacciones.
 *
 * Quien la escribió la edita aquí mismo (título, texto y, en un feedback,
 * para quién); un superadmin la fija arriba del muro. Moderar es borrar: el
 * admin de la org no reescribe lo que dijo otra persona.
 */
export default function PostModal() {
  const { t } = useT();
  const confirm = useConfirm();
  const post = usePostsStore((s) => s.open);
  const { closePost, react, comment, remove, removeComment, upload, update, pin, reactComment, publish } =
    usePostsStore.getState();
  const [publishing, setPublishing] = useState(false);
  const [draft, setDraft] = useState("");
  // Editando: una copia de lo que se puede cambiar. Nula, leyendo.
  const [editing, setEditing] = useState<{ title: string; body: string; audience: PostAudience } | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyEditor = useRef<MarkdownEditorHandle>(null);
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

  const save = async () => {
    if (!editing || !editing.body.trim() || saving) return;
    setSaving(true);
    try {
      await update(post.id, {
        title: editing.title.trim(),
        body: editing.body,
        ...(announcement ? {} : { audience: editing.audience }),
      });
      setEditing(null);
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
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
                {[
                  post.authorName,
                  post.orgName,
                  desde(post.createdAt),
                  post.via === "mcp" ? t("common:feedback.viaAgent") : "",
                  post.editedAt ? t("common:feedback.edited") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </DialogDescription>
            </div>
            {announcement ? (
              <Badge variant="secondary">{t("common:feedback.announcement")}</Badge>
            ) : (
              <Badge variant="outline">
                {post.audience === "everyone"
                  ? t("common:feedback.audienceEveryone")
                  : post.orgName
                    ? t("common:feedback.audienceOrg", { org: post.orgName })
                    : t("common:feedback.audiencePlatform")}
              </Badge>
            )}
            {post.canPin && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={post.pinned ? t("common:feedback.unpin") : t("common:feedback.pin")}
                title={post.pinned ? t("common:feedback.unpin") : t("common:feedback.pin")}
                aria-pressed={post.pinned}
                onClick={() => void pin(post.id, !post.pinned).catch(failed)}
              >
                {post.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </Button>
            )}
            {post.canEdit && !editing && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common:feedback.edit")}
                title={t("common:feedback.edit")}
                onClick={() => setEditing({ title: post.title, body: post.body, audience: post.audience })}
              >
                <Pencil className="size-4" />
              </Button>
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

        {/* Un borrador que redactó un agente: lo revisa y lo publica su autor,
            en persona (el backend no deja publicarlo con un token). */}
        {post.canPublish && !editing && (
          <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
            <p className="min-w-0 flex-1 text-sm">{t("common:feedback.publishDraftHint")}</p>
            <Button
              size="sm"
              disabled={publishing}
              onClick={() => {
                setPublishing(true);
                void publish(post.id)
                  .then(() => toast.success(t("common:feedback.published")))
                  .catch(failed)
                  .finally(() => setPublishing(false));
              }}
            >
              {t("common:feedback.publishDraft")}
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {editing ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                aria-label={t("common:feedback.titlePlaceholder")}
                placeholder={t("common:feedback.titlePlaceholder")}
                value={editing.title}
                maxLength={140}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
              <FileDropZone className="rounded-md border" onFiles={(fs) => bodyEditor.current?.insertFiles(fs)}>
                <MarkdownEditor
                  ref={bodyEditor}
                  value={editing.body}
                  onChange={(body) => setEditing({ ...editing, body })}
                  onUpload={onUpload}
                  people={people}
                  minHeight="8rem"
                  maxHeight="50vh"
                  placeholder={t("common:feedback.bodyPlaceholder")}
                />
              </FileDropZone>
              {!announcement && (
                <div role="radiogroup" aria-label={t("common:feedback.audience")} className="flex gap-2">
                  {(["platform", "everyone"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={editing.audience === a}
                      onClick={() => setEditing({ ...editing, audience: a })}
                      className={
                        "flex-1 rounded-lg border px-3 py-1.5 text-sm transition-colors " +
                        (editing.audience === a ? "border-primary bg-primary/10" : "hover:bg-muted")
                      }
                    >
                      {a === "everyone"
                        ? t("common:feedback.audienceEveryone")
                        : post.orgName
                          ? t("common:feedback.audienceOrg", { org: post.orgName })
                          : t("common:feedback.audiencePlatform")}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  {t("common:feedback.cancel")}
                </Button>
                <Button type="submit" disabled={!editing.body.trim() || saving}>
                  {saving ? t("common:feedback.saving") : t("common:feedback.save")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="text-sm">
              <Markdown>{post.body}</Markdown>
            </div>
          )}
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
                      {c.via === "mcp" && <span>· {t("common:feedback.viaAgent")}</span>}
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
                    {c.reactions.length > 0 ? (
                      <Reactions reactions={c.reactions} onReact={(emoji, on) => reactComment(post.id, c.id, emoji, on)} />
                    ) : (
                      <ReactionPicker
                        reactions={[]}
                        onReact={(emoji, on) => reactComment(post.id, c.id, emoji, on).catch(failed)}
                        className="mt-1 h-6 rounded-full px-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      />
                    )}
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
