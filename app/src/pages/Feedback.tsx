import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";

import PostCard from "@/components/feedback/PostCard";
import PostComposer from "@/components/feedback/PostComposer";
import PostModal from "@/components/feedback/PostModal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePostsStore } from "@/store/posts.store";

/**
 * El muro de feedback y comunicados (`/feedback`).
 *
 * Abrirlo es haberlo visto: se avisa al servidor (el punto de «nuevo» de la
 * barra se apaga), pero las tarjetas siguen marcando lo nuevo durante esta
 * visita, que es cuando sirve. `?post=<id>` —el enlace de un aviso— abre esa
 * publicación directamente.
 */
export default function Feedback() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const posts = usePostsStore((s) => s.posts);
  const loaded = usePostsStore((s) => s.loaded);
  const loading = usePostsStore((s) => s.loading);
  const nextCursor = usePostsStore((s) => s.nextCursor);
  const open = usePostsStore((s) => s.open);
  const { load, loadMore, openPost, markSeen, setViewing } = usePostsStore.getState();
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const org = useOrgsStore((s) => s.currentOrg());
  const [composing, setComposing] = useState(false);

  const canFeedback = !!org && (org.role === "admin" || org.role === "member");
  const canPublish = canFeedback || superadmin;

  useEffect(() => {
    setViewing(true);
    void load().then(() => markSeen()).catch(() => {});
    return () => setViewing(false);
  }, [load, markSeen, setViewing]);

  // El enlace de un aviso: abre esa publicación y se quita de la URL, para que
  // cerrarla no la vuelva a abrir.
  const wanted = params.get("post");
  useEffect(() => {
    if (!wanted) return;
    void openPost(wanted).catch(() => {});
    setParams((p) => {
      p.delete("post");
      return p;
    }, { replace: true });
  }, [wanted, openPost, setParams]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 motion-page">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{t("common:feedback.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("common:feedback.lead")}</p>
        </div>
        {canPublish && (
          <Button onClick={() => setComposing(true)}>
            <Plus className="mr-1 size-4" /> {t("common:feedback.publish")}
          </Button>
        )}
      </header>
      {!canPublish && org && <p className="text-xs text-muted-foreground">{t("common:feedback.readOnlyHint")}</p>}

      {!loaded ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
          {t("common:feedback.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} onOpen={() => void openPost(p.id)} />
          ))}
          {nextCursor && (
            <Button variant="outline" className="w-full" disabled={loading} onClick={() => void loadMore()}>
              {t("common:feedback.loadMore")}
            </Button>
          )}
        </div>
      )}

      {canPublish && (
        <PostComposer
          open={composing}
          onOpenChange={setComposing}
          orgId={org?.id ?? null}
          canFeedback={canFeedback}
          canAnnounce={superadmin}
        />
      )}
      {open && <PostModal />}
    </div>
  );
}
