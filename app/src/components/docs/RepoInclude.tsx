import DisclosureChevron from "@/components/ui/disclosure-chevron";
import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Github } from "lucide-react";

import RepoMarkdown from "@/components/docs/RepoMarkdown";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/platform";
import { useRepoDocs } from "@/store/repo-docs.store";

/**
 * El «include» de Confluence: la URL de GitHub de un .md, pegada sola en su
 * línea de un documento de cac, se ve con su contenido debajo, al día con el
 * repo. Sin macro ni sintaxis nueva: el markdown guardado sigue siendo la URL,
 * así que en GitHub, en el editor y por MCP se lee un enlace corriente.
 *
 * Mientras se busca, y si no es de un repo de esta org o no está copiado, se
 * queda el enlace tal cual (`children`): mejor un enlace que una tarjeta rota.
 *
 * Lo de dentro se pinta sin includes (`RepoMarkdown` no los pide): un .md que
 * se incluyera a sí mismo no tendría fondo.
 */
export default function RepoInclude({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useT();
  const doc = useRepoDocs((s) => s.byUrl[href]);
  const lookup = useRepoDocs((s) => s.lookup);
  const goTo = useRepoDocs((s) => s.goTo);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    void lookup(href);
  }, [href, lookup]);

  if (!doc) return <p>{children}</p>;

  return (
    <div className="not-prose my-3 rounded-md border" data-repo-include>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "work:tree.collapse" : "work:tree.expand", { name: doc.title })}
          className="motion-press grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          <DisclosureChevron open={open} className="size-3.5" />
        </button>
        <Github className="size-3.5 shrink-0 text-muted-foreground" />
        <button type="button" className="min-w-0 truncate font-medium hover:underline" onClick={() => goTo(doc.id)}>
          {doc.title}
        </button>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {doc.fullName}/{doc.path}
        </span>
        <a
          href={doc.htmlUrl}
          title={t("work:repoDocs.onGitHub")}
          aria-label={t("work:repoDocs.onGitHub")}
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            openExternal(doc.htmlUrl).catch(() => window.open(doc.htmlUrl, "_blank"));
          }}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {open && (
        <div className="motion-reveal px-4 py-3">
          {doc.tooLarge || !doc.body ? (
            <p className="text-sm text-muted-foreground">
              {t(doc.tooLarge ? "work:repoDocs.tooLarge" : "work:repoDocs.empty")}
            </p>
          ) : (
            <RepoMarkdown doc={doc} />
          )}
        </div>
      )}
    </div>
  );
}
