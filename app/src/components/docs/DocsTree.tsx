import { useEffect, useMemo } from "react";
import { FileText, Folder, List } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import DocPagesBranch from "@/components/docs/DocPagesBranch";
import RepoDocsBranch from "@/components/docs/RepoDocsBranch";
import { DocsTreeView, useBranch } from "@/components/docs/docs-tree-view";
import PanelRow from "@/components/sidebar/PanelRow";
import { useTreeExpansion } from "@/components/sidebar/useTreeExpansion";
import { docsRoute } from "@/lib/doc-mode";
import { defaultExpanded, docNodes, filterDocsTree, type DocNode } from "@/lib/docs-panel";
import { useT } from "@/lib/i18n";
import { repoDocPath } from "@/lib/repo-tree";
import { useDocPages } from "@/store/doc-pages.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useRepoDocs } from "@/store/repo-docs.store";
import { useTasksStore } from "@/store/tasks.store";
import { docKey, type DocPageTreeItem } from "@/types/task";

/**
 * El árbol de Documentación: espacio → carpeta → lista, cada nodo con su
 * documento, y colgando de cada documento sus páginas.
 *
 * De sólo lectura en cuanto a nodos: crear, renombrar o mover espacios y
 * listas sigue siendo cosa del árbol de Trabajo, con su candado. Aquí se
 * navega, y se trabaja con las páginas del documento abierto.
 *
 * Por defecto va abierto el camino hasta el documento que lees y nada más
 * (`defaultExpanded`); lo que pliegas o despliegas a mano se recuerda por org
 * (`layout.store.expanded`, módulo `docs`). Al cambiar de documento se olvida
 * lo decidido sobre su camino, para que nunca quede escondido.
 */
export default function DocsTree({ filter = "" }: { filter?: string }) {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const breadcrumb = useDocPages((s) => s.view?.breadcrumb);
  const pagesByOwner = useDocPages((s) => s.pagesByOwner);
  const expansion = useTreeExpansion("docs");
  const repoDoc = useRepoDocs((s) => s.open);
  const repoBySpace = useRepoDocs((s) => s.bySpace);

  // Un documento de otra org no cuenta: puede sobrevivir persistido a un cambio.
  const open = activeDoc && activeDoc.orgId === currentOrgId ? activeDoc : null;
  // Leyendo un fichero del repo, el camino hasta él: su espacio, el repo y
  // sus carpetas.
  const readingRepo = repoDoc && repoDoc.orgId === currentOrgId ? repoDoc : null;
  const defaults = useMemo(() => {
    const d = defaultExpanded(tree, open, breadcrumb ?? []);
    if (readingRepo) for (const k of [docKey("space", readingRepo.spaceId), ...repoDocPath(readingRepo)]) d.add(k);
    return d;
  }, [tree, open, breadcrumb, readingRepo]);
  const visible = useMemo(
    () => filterDocsTree(tree, filter, pagesByOwner, repoBySpace),
    [tree, filter, pagesByOwner, repoBySpace],
  );
  const nodes = useMemo(() => docNodes(tree), [tree]);

  const revealKey = [...defaults].join("/");
  useEffect(() => {
    if (defaults.size > 0) expansion.reveal([...defaults]);
    // Sólo cuando cambia lo que se lee, no cada vez que se pliega algo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  const shown = visible ? nodes.filter((n) => visible.has(docKey(n.kind, n.id))) : nodes;
  const view = useMemo(() => ({ defaults, visible }), [defaults, visible]);

  if (visible && shown.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t("nav:panel.noMatches")}</p>;
  }

  return (
    <DocsTreeView.Provider value={view}>
      <ul className="flex flex-col px-1">
        {shown.map((n) => (
          <DocNodeRow key={docKey(n.kind, n.id)} node={n} depth={0} />
        ))}
      </ul>
    </DocsTreeView.Provider>
  );
}

/**
 * Abrir documentos y páginas desde el árbol, y a qué pantalla ir.
 *
 * Quien ya lee documentación se queda donde está (`/tasks` o `/docs`, ver
 * `docsRoute`); quien llega de otro sitio va a `/docs`.
 */
function useOpenFromTree() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const openDoc = useTasksStore((s) => s.openDoc);
  const closePage = useDocPages((s) => s.closePage);
  const openPage = useDocPages((s) => s.openPage);
  const screen = () => docsRoute(activeDoc, currentOrgId, pathname) ?? "/docs";

  return {
    /** El documento de un nodo, por su portada. */
    node: (n: DocNode) => {
      const target = screen();
      if (activeDoc?.kind === n.kind && activeDoc.id === n.id) closePage();
      else openDoc(n.kind, n.id, n.name).catch((e) => toast.error(String(e)));
      navigate(target);
    },
    /**
     * Una página de un documento que no es el abierto. **La página primero**:
     * fija el dueño, y así abrir el documento no la cierra (`enter` sólo vacía
     * si cambia el dueño). Es la misma secuencia que `lib/open-ref.ts`.
     */
    page: (n: DocNode, page: DocPageTreeItem) => {
      const target = screen();
      openPage({ kind: n.kind, id: n.id }, page.id).catch((e) => toast.error(String(e)));
      openDoc(n.kind, n.id, n.name).catch((e) => toast.error(String(e)));
      navigate(target);
    },
  };
}

function DocNodeRow({ node, depth }: { node: DocNode; depth: number }) {
  const { t } = useT();
  const key = docKey(node.kind, node.id);
  const branch = useBranch(key);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const written = useTasksStore((s) => !!s.docIndex[key]);
  const indexedPages = useTasksStore((s) => s.docIndex[key]?.pages ?? 0);
  const cachedPages = useDocPages((s) => s.pagesByOwner[key]?.length ?? 0);
  const open = useOpenFromTree();
  const { pathname } = useLocation();

  const isActive =
    activeDoc?.kind === node.kind && activeDoc.id === node.id && activeDoc.orgId === currentOrgId;
  // Marcado sólo donde de verdad se está leyendo: en «Mi trabajo» con un
  // documento abierto de antes, ese documento no está en pantalla.
  const onScreen = isActive && docsRoute(activeDoc, currentOrgId, pathname) !== null;
  const hasPages = isActive || indexedPages > 0 || cachedPages > 0;
  const children = node.children.filter((c) => branch.shows(docKey(c.kind, c.id)));
  // Un espacio siempre se despliega: de él pueden colgar los .md de un repo,
  // y no se sabe hasta pedirlos.
  const expandable = hasPages || children.length > 0 || node.kind === "space";

  const icon =
    node.kind === "space" ? (
      <span className="size-2.5 rounded-sm" style={{ backgroundColor: node.color || "var(--muted-foreground)" }} />
    ) : node.kind === "folder" ? (
      <Folder />
    ) : (
      <List />
    );

  return (
    <li>
      <PanelRow
        icon={icon}
        label={node.name}
        // Sin chevrón, sus 24px (20 del botón y 4 de hueco) como sangría: si no,
        // una lista sin páginas quedaría más a la izquierda que su hermana.
        depth={expandable ? depth : depth + 2}
        // Con la rama abierta, el fondo va en la portada o la página que lees,
        // debajo; aquí sólo la negrita. Plegada, lo lleva el documento.
        active={onScreen && (expandable && branch.open && hasPages && !branch.filtering ? "path" : true)}
        onClick={() => open.node(node)}
        badge={written ? <FileText className="ml-auto size-3 shrink-0 text-muted-foreground" /> : undefined}
        expandable={
          expandable
            ? {
                open: branch.open,
                onToggle: branch.toggle,
                collapseLabel: t("work:tree.collapse", { name: node.name }),
                expandLabel: t("work:tree.expand", { name: node.name }),
              }
            : undefined
        }
      />
      {expandable && branch.open && (
        <>
          {hasPages && (
            <DocPagesBranch
              kind={node.kind}
              ownerId={node.id}
              depth={depth + 1}
              active={isActive}
              peek={!branch.filtering}
              onOpenOther={(p) => open.page(node, p)}
            />
          )}
          {children.length > 0 && (
            <ul>
              {children.map((c) => (
                <DocNodeRow key={docKey(c.kind, c.id)} node={c} depth={depth + 1} />
              ))}
            </ul>
          )}
          {node.kind === "space" && <RepoDocsBranch spaceId={node.id} depth={depth + 1} />}
        </>
      )}
    </li>
  );
}
