import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, GitBranch, Github } from "lucide-react";

import DocToc from "@/components/docs/DocToc";
import Markdown from "@/components/markdown/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { desde } from "@/lib/desde";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/platform";
import { useRepoDocs } from "@/store/repo-docs.store";

/**
 * Un .md del repo, leído en cac (docs as code).
 *
 * **De sólo lectura, y lo dice**: el repo es la fuente, así que aquí no hay
 * editor ni autoguardado, sino «Ver en GitHub» para quien quiera cambiarlo.
 * Se pinta con el mismo lector que las páginas (`Markdown`), no con el
 * editor: el editor normaliza el markdown al cargarlo, y lo que se ve tiene
 * que ser lo que hay en el repo.
 */
export default function RepoDocView({ id }: { id: string }) {
  const { t } = useT();
  const doc = useRepoDocs((s) => (s.open?.id === id ? s.open : null));
  const openDoc = useRepoDocs((s) => s.openDoc);
  const closeDoc = useRepoDocs((s) => s.closeDoc);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    openDoc(id).catch(() => setFailed(true));
  }, [id, openDoc]);
  // Al salir, el panel deja de marcar el fichero.
  useEffect(() => () => closeDoc(), [closeDoc]);

  if (failed) {
    return <p className="m-auto text-sm text-muted-foreground">{t("work:repoDocs.gone")}</p>;
  }
  if (!doc) {
    return <p className="m-auto text-sm text-muted-foreground">{t("work:tree.loading")}</p>;
  }

  const crumbs = doc.path.split("/");
  const onGitHub = () => openExternal(doc.htmlUrl).catch(() => window.open(doc.htmlUrl, "_blank"));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <nav aria-label="breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Github className="size-3.5 shrink-0" />
          <span>{doc.fullName}</span>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <span className={i === crumbs.length - 1 ? "text-foreground" : undefined}>{c}</span>
            </span>
          ))}
        </nav>
        <Badge variant="outline" className="gap-1 font-mono text-[11px]">
          <GitBranch className="size-3" />
          {doc.branch}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {doc.syncedAt && (
            <span className="text-xs text-muted-foreground">{t("work:repoDocs.synced", { when: desde(doc.syncedAt) })}</span>
          )}
          <Button size="sm" variant="outline" onClick={onGitHub}>
            <ExternalLink className="size-3.5" />
            {t("work:repoDocs.onGitHub")}
          </Button>
        </div>
      </header>

      <div data-doc-scroll className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl xl:max-w-5xl xl:gap-8">
          <div className="min-w-0 flex-1">
            <p className="mb-4 text-xs text-muted-foreground">{t("work:repoDocs.readOnly")}</p>
            {doc.tooLarge ? (
              <p className="text-sm text-muted-foreground">{t("work:repoDocs.tooLarge")}</p>
            ) : doc.body ? (
              <div className="prose-doc">
                <Markdown allowHtml>{doc.body}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("work:repoDocs.empty")}</p>
            )}
          </div>
          {!doc.tooLarge && doc.body && <DocToc markdown={doc.body} />}
        </div>
      </div>
    </div>
  );
}
