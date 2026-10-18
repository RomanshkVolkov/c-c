import { useEffect } from "react";
import { FileText, Folder, Github } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { useBranch, useDocsFilter } from "@/components/docs/docs-tree-view";
import PanelRow from "@/components/sidebar/PanelRow";
import { useT } from "@/lib/i18n";
import { buildRepoTree, repoDirKey, repoFileKey, repoKey, type RepoDir } from "@/lib/repo-tree";
import { useRepoDocs } from "@/store/repo-docs.store";
import { useTasksStore } from "@/store/tasks.store";
import type { RepoDocEntry, RepoDocsGroup } from "@/types/github";

/**
 * Los .md de los repos atados a un espacio, colgando de él en el árbol de
 * Documentación (docs as code). De sólo lectura: abrir uno lo enseña, y se
 * edita en el repo.
 *
 * Se monta sólo con el espacio desplegado, y es entonces cuando se piden: el
 * panel no hace una petición por espacio al abrirse.
 */
export default function RepoDocsBranch({ spaceId, depth }: { spaceId: string; depth: number }) {
  const groups = useRepoDocs((s) => s.bySpace[spaceId]);
  const fetchSpace = useRepoDocs((s) => s.fetchSpace);
  const { shows } = useDocsFilter();

  useEffect(() => {
    fetchSpace(spaceId).catch(() => {});
  }, [spaceId, fetchSpace]);

  const shown = (groups ?? []).filter((g) => g.files.length > 0 && shows(repoKey(g.repoId)));
  if (shown.length === 0) return null;
  return (
    <ul>
      {shown.map((g) => (
        <RepoRow key={g.repoId} group={g} depth={depth} />
      ))}
    </ul>
  );
}

function RepoRow({ group, depth }: { group: RepoDocsGroup; depth: number }) {
  const { t } = useT();
  const key = repoKey(group.repoId);
  const branch = useBranch(key);
  const tree = buildRepoTree(group.files);
  return (
    <li>
      <PanelRow
        icon={<Github />}
        label={group.fullName}
        title={t("work:repoDocs.repoHint", { repo: group.fullName, branch: group.branch })}
        depth={depth}
        onClick={branch.toggle}
        expandable={{
          open: branch.open,
          onToggle: branch.toggle,
          collapseLabel: t("work:tree.collapse", { name: group.fullName }),
          expandLabel: t("work:tree.expand", { name: group.fullName }),
        }}
      />
      {branch.open && (
        <div className="motion-reveal">
          <DirContents repoId={group.repoId} dir={tree} depth={depth + 1} />
        </div>
      )}
    </li>
  );
}

function DirContents({ repoId, dir, depth }: { repoId: number; dir: RepoDir; depth: number }) {
  const { shows } = useDocsFilter();
  const dirs = dir.dirs.filter((d) => shows(repoDirKey(repoId, d.path)));
  const files = dir.files.filter((f) => shows(repoFileKey(f.id)));
  return (
    <ul>
      {dirs.map((d) => (
        <DirRow key={d.path} repoId={repoId} dir={d} depth={depth} />
      ))}
      {files.map((f) => (
        <FileRow key={f.id} file={f} depth={depth} />
      ))}
    </ul>
  );
}

function DirRow({ repoId, dir, depth }: { repoId: number; dir: RepoDir; depth: number }) {
  const { t } = useT();
  const branch = useBranch(repoDirKey(repoId, dir.path));
  return (
    <li>
      <PanelRow
        icon={<Folder />}
        label={dir.name}
        depth={depth}
        onClick={branch.toggle}
        expandable={{
          open: branch.open,
          onToggle: branch.toggle,
          collapseLabel: t("work:tree.collapse", { name: dir.name }),
          expandLabel: t("work:tree.expand", { name: dir.name }),
        }}
      />
      {branch.open && (
        <div className="motion-reveal">
          <DirContents repoId={repoId} dir={dir} depth={depth + 1} />
        </div>
      )}
    </li>
  );
}

function FileRow({ file, depth }: { file: RepoDocEntry; depth: number }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const reading = pathname === "/docs" && new URLSearchParams(search).get("repoDoc") === file.id;
  return (
    <li>
      <PanelRow
        icon={<FileText />}
        label={file.title}
        title={file.path}
        // Sin chevrón, sus 24px de sangría, como una lista sin páginas.
        depth={depth + 2}
        active={reading}
        onClick={() => {
          // Un fichero del repo no es el documento de ningún nodo: se cierra
          // el abierto para que la pantalla enseñe éste.
          closeDoc();
          navigate(`/docs?repoDoc=${encodeURIComponent(file.id)}`);
        }}
      />
    </li>
  );
}
