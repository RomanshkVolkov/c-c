import { fechaConAno } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { useTasksStore } from "@/store/tasks.store";
import { cn } from "@/lib/utils";
import OrgIntegrations from "@/components/org/OrgIntegrations";
import OrgMeetings from "@/components/org/OrgMeetings";
import OrgSpaces from "@/components/org/OrgSpaces";
import OrgInvitations from "@/components/org/OrgInvitations";
import OrgGeneral from "@/components/org/OrgGeneral";
import OrgSwitcher from "@/components/OrgSwitcher";
import { Trash2, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/ConfirmDialog";
import { desde } from "@/lib/desde";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import type { OrgMember, OrgRole, Invitation } from "@/types/organization";

const ROLES: OrgRole[] = ["admin", "member", "viewer"];

/** The four jobs this screen does, in the order you usually come for them. */
const PESTANAS = [
  { key: "members", labelKey: "org:tab.members" },
  { key: "invites", labelKey: "org:tab.invites" },
  { key: "spaces", labelKey: "org:tab.spaces" },
  // The report projects: another system holds an ingest key and pushes work in.
  // They belong to the organization, which is why they are here and not on a
  // server's screen.
  { key: "integrations", labelKey: "org:tab.integrations" },
  // Las reuniones periódicas: lo que suena a una hora sin que nadie lo pida.
  { key: "meetings", labelKey: "org:tab.meetings" },
  { key: "general", labelKey: "org:tab.general" },
] as const;

type Pestana = (typeof PESTANAS)[number]["key"];

export default function OrganizationSettings() {
  const { t } = useT();
  const [pestana, setPestana] = useState<Pestana>("members");
  const espacios = useTasksStore((s) => s.tree.length);
  const current = useOrgsStore((s) => s.currentOrg());
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const confirm = useConfirm();

  const listMembers = useOrgsStore((s) => s.listMembers);
  const addMember = useOrgsStore((s) => s.addMember);
  const updateMemberRole = useOrgsStore((s) => s.updateMemberRole);
  const removeMember = useOrgsStore((s) => s.removeMember);
  const listOrgInvitations = useOrgsStore((s) => s.listOrgInvitations);

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  // Counts on the tabs, so the shape of the place is readable without opening
  // each one. Absent where there is nothing to count: a "0" beside a tab that
  // is a form rather than a list is just noise.
  const [busca, setBusca] = useState("");
  const [filtroRol, setFiltroRol] = useState("");
  const termino = busca.trim().toLowerCase();
  const visibles = members.filter(
    (m) =>
      (!filtroRol || m.role === filtroRol) &&
      (!termino ||
        m.username.toLowerCase().includes(termino) ||
        (m.email ?? "").toLowerCase().includes(termino)),
  );

  const cuentas: Partial<Record<Pestana, number>> = {
    members: members.length,
    invites: invites.length,
    spaces: espacios,
  };
  const [loading, setLoading] = useState(false);

  const orgId = current?.id;
  const canManage = superadmin || current?.role === "admin";
  const myId = useAuthStore((s) => s.session?.id);
  const iAmAMember = members.some((m) => m.userId === myId);

  /** Put myself in this organization, as an admin. */
  const joinSelf = async () => {
    if (!orgId || !myId) return;
    try {
      await addMember(orgId, { userId: myId, role: "admin" });
      toast.success(t("common:crash.joined", { org: current?.name }));
      refresh();
    } catch (e) {
      toast.error(t("common:crash.joinFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [m, i] = await Promise.all([
        listMembers(orgId),
        canManage ? listOrgInvitations(orgId) : Promise.resolve([]),
      ]);
      setMembers(m);
      setInvites(i);
    } catch (e) {
      toast.error(t("org:errLoad"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [orgId, canManage, listMembers, listOrgInvitations]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!current) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {t("org:none")}
      </div>
    );
  }

  const changeRole = async (userId: string, next: OrgRole) => {
    if (!orgId) return;
    try {
      await updateMemberRole(orgId, userId, next);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: next } : m)));
    } catch (e) {
      toast.error(t("org:errRole"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const kick = async (m: OrgMember) => {
    if (!orgId) return;
    const ok = await confirm({
      title: `Remove @${m.username}?`,
      description: `They will lose access to ${current.name} and its resources.`,
      confirmText: t("org:remove"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeMember(orgId, m.userId);
      setMembers((prev) => prev.filter((x) => x.userId !== m.userId));
      toast.success(t("common:last.memberRemoved", { name: m.username }));
    } catch (e) {
      toast.error(t("org:errRemove"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Full width. The design uses the pane it is given; centring this in a
          3xl column left the members table squeezed and the rest of the screen
          empty. */}
      <div className="w-full flex-1 space-y-6 overflow-auto px-8 py-6">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold uppercase text-primary">
            {current.name.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{current.name}</h1>
            {/* Everything that tells one organization from another, on one
                line. A date matters more than it looks: it is what separates a
                real place from one somebody made by accident last week. */}
            <p className="text-xs text-muted-foreground">
              {t("org:yourRole", { role: current.role })}
              {superadmin && " · superadmin"}
              {current.memberCount > 0 &&
                ` · ${t("common:count.members", { count: current.memberCount })}`}
              {espacios > 0 && ` · ${t("common:count.spaces", { count: espacios })}`}
              {current.createdAt &&
                ` · ${t("org:createdOn", { when: fechaConAno(current.createdAt) })}`}
            </p>
          </div>
          {canManage && (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <OrgSwitcher variant="button" />
              <Button size="sm" onClick={() => setPestana("invites")}>
                {t("org:invite")}
              </Button>
            </span>
          )}
        </div>

        {/* One screen with tabs instead of four stacked sections.

            Identity, who is in it, who has been asked, and what it is wired
            to are four different jobs, and a page that scrolls through all
            of them makes each one look like part of the next. Tabs also mean
            the invitation list is not the first thing between you and the
            member you came to find. */}
        <nav className="mb-4 flex gap-4 border-b text-sm">
          {PESTANAS.filter((p) => p.key !== "invites" || canManage).map((p) => (
            <button
              key={p.key}
              onClick={() => setPestana(p.key)}
              className={cn(
                "border-b-2 pb-2",
                p.key === pestana
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(p.labelKey)}
              {cuentas[p.key] !== undefined && (
                <span className="ml-1.5 text-xs text-muted-foreground">{cuentas[p.key]}</span>
              )}
            </button>
          ))}
        </nav>

        {pestana === "members" && (
          <>
          <section className="space-y-3">

            {/* Joining it yourself.
                The picker below searches everyone *except* you — right for
                inviting somebody, and a dead end for the one case a superadmin
                actually needs: they can see every organization without belonging
                to any, and belonging is what makes them mentionable and
                messageable. Without this there was no way in at all from the app. */}
            {canManage && !iAmAMember && (
              <div className="flex items-center gap-2 rounded-lg border border-dashed p-2 text-xs">
                <span className="text-muted-foreground">{t("common:crash.notAMember")}</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={joinSelf}>
                  {t("common:crash.addMe")}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {/* The magnifier does the work the placeholder was doing alone:
                  a bare box beside a dropdown reads as another field to fill
                  in, not as a way to narrow what is already there. */}
              <span className="relative max-w-xs flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={t("org:searchMember")}
                  className="h-8 bg-card pl-7 text-xs"
                />
              </span>
              <select
                aria-label={t("org:role")}
                value={filtroRol}
                onChange={(e) => setFiltroRol(e.target.value)}
                // A bordered chip and not a filled control: it narrows what is
                // already on screen, and giving it the same weight as the
                // search box made two things look like one form to fill in.
                className="h-8 rounded-lg border bg-transparent px-2 text-xs text-muted-foreground"
              >
                <option value="">Role: any</option>
                <option value="admin">admin</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
              {/* What each role actually means, next to the control that sets
                  it. Three words each; without them the dropdown asks a
                  question most people answer by guessing. */}
              <span className="ml-auto text-[11px] text-muted-foreground">
                admin manages · member writes · viewer only reads
              </span>
            </div>
            {/* On `card`, like every other surface that holds content. The
                tokens set the palette but not which surface each thing sits on,
                so this stayed on the page background — the darkest tone — and
                read as a hole rather than as a panel. */}
            <div className="overflow-hidden rounded-xl border bg-card">
              {/* Roomier than the shared table's default `px-2`. A members list
                  is read across — name, then email, then role — and at that
                  padding the columns run into each other. */}
              <Table className="[&_td]:px-3.5 [&_td]:py-2.5 [&_th]:px-3.5">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("org:thUser")}</TableHead>
                    <TableHead>{t("org:thEmail")}</TableHead>
                    <TableHead className="w-40">{t("org:thRole")}</TableHead>
                    <TableHead className="w-28">{t("org:thActivity")}</TableHead>
                    <TableHead className="text-right w-16">{t("org:thActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && members.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">
                        <Loader2 className="inline size-4 animate-spin" /> Loading…
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibles.map((m) => (
                      <TableRow key={m.userId}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-2">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold uppercase text-primary">
                              {m.username.slice(0, 2)}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate">{m.username}</span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                @{m.username}
                              </span>
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="truncate text-xs text-muted-foreground">
                          {m.email || "—"}
                        </TableCell>
                        <TableCell>
                          {canManage ? (
                            <Select
                              value={m.role}
                              onValueChange={(v) => v && changeRole(m.userId, v as OrgRole)}
                            >
                              <SelectTrigger className="w-32 capitalize">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLES.map((r) => (
                                  <SelectItem key={r} value={r} className="capitalize">
                                    {r}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="capitalize text-muted-foreground">{m.role}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {/* "never" and not an empty cell: a blank reads as
                              missing data, and this is a fact about the account
                              rather than a gap in what we know about it. */}
                          {desde(m.lastSeenAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="flex items-center justify-end gap-1">
                            {m.userId === myId && (
                              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                you
                              </span>
                            )}
                            {canManage && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() => kick(m)}
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
          </>
        )}

        {pestana === "members" && (
          <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Guests are not listed here: they reach DevTools and nothing else, and
            they do not belong to the organization.
          </p>
        )}

        {pestana === "invites" && (
          <OrgInvitations
            orgId={current.id}
            orgName={current.name}
            invites={invites}
            setInvites={setInvites}
            canManage={canManage}
            defaultRole={current.defaultInviteRole ?? "member"}
            onAdded={refresh}
          />
        )}

        {pestana === "spaces" && <OrgSpaces canManage={canManage} />}

        {pestana === "general" && <OrgGeneral org={current} canManage={canManage} />}

        {pestana === "integrations" && <OrgIntegrations canManage={canManage} />}

        {pestana === "meetings" && <OrgMeetings canManage={canManage} />}

      </div>
    </div>
  );
}
