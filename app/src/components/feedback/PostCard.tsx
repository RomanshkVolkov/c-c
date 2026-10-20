import { Megaphone, MessageSquare, Pin } from "lucide-react";

import Markdown from "@/components/markdown/Markdown";
import { Reactions } from "@/components/chat/Reactions";
import { Badge } from "@/components/ui/badge";
import { desde, iniciales } from "@/lib/desde";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePostsStore } from "@/store/posts.store";
import type { Post } from "@/types/post";

/**
 * Una publicación en el muro: quién, de qué org, para quién, un extracto y sus
 * reacciones. Pulsarla la abre entera en el modal (PostModal).
 *
 * El extracto es el mismo markdown recortado por alto, no un texto aparte:
 * así la primera imagen se ve en la tarjeta, como en cualquier muro.
 */
export default function PostCard({ post, onOpen }: { post: Post; onOpen: () => void }) {
  const { t } = useT();
  const react = usePostsStore((s) => s.react);
  const announcement = post.kind === "announcement";

  return (
    <article
      className={cn(
        "lift rounded-xl border bg-card p-4 transition-colors",
        announcement && "border-primary/40 bg-primary/5",
      )}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={post.title || post.authorName}>
        <header className="mb-2 flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
            {announcement ? <Megaphone className="size-3.5" /> : iniciales(post.authorName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{post.authorName}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {[post.orgName, desde(post.createdAt), post.editedAt ? t("common:feedback.edited") : ""].filter(Boolean).join(" · ")}
            </span>
          </span>
          {post.pinned && (
            <span className="text-primary" title={t("common:feedback.pinned")} aria-label={t("common:feedback.pinned")} role="img">
              <Pin className="size-3.5" />
            </span>
          )}
          {post.unseen && <Badge>{t("common:feedback.new")}</Badge>}
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
        </header>
        {post.title && <h3 className="mb-1 font-semibold">{post.title}</h3>}
        {/* Recortado por alto; el entero, en el modal. */}
        <div className="relative max-h-56 overflow-hidden text-sm">
          <Markdown>{post.body}</Markdown>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card" />
        </div>
      </button>
      <footer className="mt-2 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Reactions reactions={post.reactions} onReact={(emoji, on) => react(post.id, emoji, on)} />
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <MessageSquare className="size-3.5" />
          {t("common:feedback.comments", { count: post.comments })}
        </button>
      </footer>
    </article>
  );
}
