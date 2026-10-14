import { useEffect, useMemo } from "react";

import Markdown from "@/components/markdown/Markdown";
import { openExternal } from "@/lib/platform";
import { repoImageSrc, resolveRepoHref } from "@/lib/repo-links";
import { useRepoDocs } from "@/store/repo-docs.store";
import type { RepoDoc } from "@/types/github";

/**
 * El cuerpo de un .md del repo, con sus enlaces y sus imágenes resueltos
 * contra su ruta (ver `lib/repo-links.ts`): un `../deploy.md` abre ese fichero
 * en cac, una imagen relativa se pide a cac, y lo demás va a GitHub.
 *
 * Para saber qué .md están copiados hacen falta los ficheros de su repo, que
 * son los del espacio: se piden si no estaban (una vez por espacio).
 */
export default function RepoMarkdown({ doc }: { doc: RepoDoc }) {
  const groups = useRepoDocs((s) => s.bySpace[doc.spaceId]);
  const fetchSpace = useRepoDocs((s) => s.fetchSpace);
  const goTo = useRepoDocs((s) => s.goTo);

  useEffect(() => {
    fetchSpace(doc.spaceId).catch(() => {});
  }, [doc.spaceId, fetchSpace]);

  const idByPath = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of groups?.find((g) => g.repoId === doc.repoId)?.files ?? []) out[f.path] = f.id;
    return out;
  }, [groups, doc.repoId]);

  const onLink = (href: string): boolean => {
    const to = resolveRepoHref(doc, href, idByPath);
    if (to.kind === "anchor") {
      document.getElementById(to.hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (to.kind === "repoDoc") {
      goTo(to.id, to.hash);
    } else {
      openExternal(to.url).catch(() => window.open(to.url, "_blank"));
    }
    return true;
  };

  return (
    <Markdown allowHtml onInternalLink={onLink} imageSrc={(src) => repoImageSrc(doc, src)}>
      {doc.body ?? ""}
    </Markdown>
  );
}
