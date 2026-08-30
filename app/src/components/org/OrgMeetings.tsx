import { useLocaleStore } from "@/store/locale.store";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, CalendarDays, List, Loader2, Pause, Play, Plus, Trash2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ConfirmDialog";
import { useMeetingsStore, type Meeting, type MeetingDraft } from "@/store/meetings.store";
import ItemCalendar, { type CalendarItem } from "@/components/ItemCalendar";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { horaDual, reglaLegible } from "@/lib/horas";
import { cn } from "@/lib/utils";
import type { OrgMember } from "@/types/organization";

/**
 * Las reuniones periódicas de la organización.
 *
 * Lo que se programa aquí **suena**: a la hora exacta le sale a cada miembro una
 * tarjeta con timbre, como una llamada. Por eso lo crea quien administra y por
 * eso la pantalla insiste en dos cosas antes de guardar — a qué hora es *de
 * verdad* para cada quien, y a quién le va a sonar.
 */
export default function OrgMeetings({ canManage }: { canManage: boolean }) {
  const { t } = useT();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const listMembers = useOrgsStore((s) => s.listMembers);
  const meetings = useMeetingsStore((s) => s.meetings);
  const loading = useMeetingsStore((s) => s.loading);
  const fetch = useMeetingsStore((s) => s.fetch);
  const create = useMeetingsStore((s) => s.create);

  const agenda = useMeetingsStore((s) => s.agenda);
  const fetchAgenda = useMeetingsStore((s) => s.fetchAgenda);

  const [miembros, setMiembros] = useState<OrgMember[]>([]);
  const [creando, setCreando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  /** Lista o calendario. La lista primero: es donde se edita. */
  const [vista, setVista] = useState<"lista" | "calendario">("lista");

  useEffect(() => {
    if (orgId) fetch(orgId).catch(() => {});
  }, [orgId, fetch]);

  useEffect(() => {
    if (orgId) listMembers(orgId).then(setMiembros).catch(() => {});
  }, [orgId, listMembers]);

  // Sólo al mirar el calendario: expandir dos meses de repeticiones para una
  // pantalla que nadie ha abierto es trabajo tirado.
  useEffect(() => {
    if (orgId && vista === "calendario") fetchAgenda(orgId).catch(() => {});
  }, [orgId, vista, fetchAgenda, meetings]);

  const crear = async (draft: MeetingDraft) => {
    if (!orgId) return;
    setGuardando(true);
    try {
      await create(orgId, draft);
      setCreando(false);
    } catch (e) {
      toast.error(t("org:errCreateMeeting"), { description: String(e) });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="space-y-3">
      {/* Lo que hay que saber antes de crear una, no después. */}
      <p className="max-w-[660px] text-xs leading-relaxed text-muted-foreground">
        {t("org:meetingsExplain")}
      </p>

      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{t("org:recurringMeetings")}</Label>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={vista === "lista" ? "secondary" : "ghost"}
            onClick={() => setVista("lista")}
          >
            <List className="mr-1 size-3" /> List
          </Button>
          <Button
            size="sm"
            variant={vista === "calendario" ? "secondary" : "ghost"}
            onClick={() => setVista("calendario")}
          >
            <CalendarDays className="mr-1 size-3" /> Calendar
          </Button>
        </div>
        {canManage && !creando && (
          <Button size="sm" variant="outline" onClick={() => setCreando(true)}>
            <Plus className="mr-1 size-3" /> New
          </Button>
        )}
      </div>

      {creando && (
        <Formulario
          guardando={guardando}
          onCancel={() => setCreando(false)}
          onSave={crear}
        />
      )}

      {vista === "calendario" ? (
        <ItemCalendar
          items={agenda.map(
            (o, i): CalendarItem => ({
              // El id lleva el índice porque una reunión aparece **muchas
              // veces** en el mes, y el calendario necesita distinguirlas.
              id: `${o.meetingId}#${i}`,
              title: o.spaceName ? `${o.title} · #${o.spaceName}` : o.title,
              at: o.at,
              // Las pausadas se pintan apagadas en vez de esconderse: una
              // reunión pausada por error es invisible justo donde se buscaría.
              dotClass: o.paused ? "bg-muted-foreground/40" : "bg-primary",
              label: new Date(o.at).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              }),
            }),
          )}
          onOpen={() => setVista("lista")}
          countKey="common:count.meetings"
        />
      ) : loading && meetings.length === 0 ? (
        <p className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading…
        </p>
      ) : meetings.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          {t("org:nothingScheduled")}
        </p>
      ) : (
        <ul className="space-y-3">
          {meetings.map((m) => (
            <Ficha key={m.id} reunion={m} canManage={canManage} miembros={miembros} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** La zona de quien está mirando, que es el valor por defecto razonable. */
function miZona(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const DIAS = [
  { n: 1, etiqueta: "Mon" },
  { n: 2, etiqueta: "Tue" },
  { n: 3, etiqueta: "Wed" },
  { n: 4, etiqueta: "Thu" },
  { n: 5, etiqueta: "Fri" },
  { n: 6, etiqueta: "Sat" },
  { n: 0, etiqueta: "Sun" },
];

function Formulario({
  guardando,
  onCancel,
  onSave,
}: {
  guardando: boolean;
  onCancel: () => void;
  onSave: (d: MeetingDraft) => void;
}) {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  // La sala general primero: es la que va a querer la mayoría de reuniones de
  // toda la organización.
  const salas = [...tree].sort((a, b) => (a.kind === "general" ? -1 : b.kind === "general" ? 1 : 0));

  const [titulo, setTitulo] = useState("");
  const [hora, setHora] = useState("09:00");
  const [zona, setZona] = useState(miZona());
  const [freq, setFreq] = useState<Meeting["freq"]>("weekly");
  const [dias, setDias] = useState<number[]>([1]);
  const [diaDelMes, setDiaDelMes] = useState(1);
  const [intervalo, setIntervalo] = useState(1);
  const [sala, setSala] = useState("");

  const guardar = () => {
    const t = titulo.trim();
    if (!t) return;
    onSave({
      title: t,
      wallTime: hora,
      timezone: zona,
      freq,
      interval: intervalo,
      weekdays: freq === "weekly" ? dias.join(",") : undefined,
      monthDay: freq === "monthly" ? diaDelMes : undefined,
      // El ancla del ciclo cuando se repite cada N: sin ella «cada dos semanas»
      // no dice cuál de las dos es. Hoy es una respuesta tan buena como otra.
      anchor: intervalo > 1 ? new Date().toISOString().slice(0, 10) : undefined,
      spaceId: sala || undefined,
    });
  };

  return (
    <div className="space-y-3 rounded-xl border bg-card p-3">
      <Input
        autoFocus
        value={titulo}
        onChange={(e) => setTitulo(e.target.value)}
        placeholder={t("org:meetingNamePlaceholder")}
        className="max-w-sm"
      />

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-muted-foreground">
          {t("org:time")}
          <Input
            type="time"
            value={hora}
            onChange={(e) => setHora(e.target.value)}
            className="mt-1 h-8 w-32 text-xs"
          />
        </label>
        <label className="min-w-52 flex-1 text-xs text-muted-foreground">
          {t("org:timeZone")}
          <Input
            value={zona}
            onChange={(e) => setZona(e.target.value)}
            placeholder={t("org:timeZonePlaceholder")}
            className="mt-1 h-8 text-xs"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t("org:repeats")}
          <select
            value={freq}
            onChange={(e) => setFreq(e.target.value as Meeting["freq"])}
            className="mt-1 h-8 w-28 rounded-md border bg-background px-2 text-xs"
          >
            <option value="daily">{t("org:daily")}</option>
            <option value="weekly">{t("org:weekly")}</option>
            <option value="monthly">{t("org:monthly")}</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {t("org:every")}
          <Input
            type="number"
            min={1}
            max={52}
            value={intervalo}
            onChange={(e) => setIntervalo(Math.max(1, Number(e.target.value) || 1))}
            className="mt-1 h-8 w-20 text-xs"
          />
        </label>
      </div>

      {freq === "weekly" && (
        <div className="flex flex-wrap gap-1">
          {DIAS.map((d) => (
            <button
              key={d.n}
              type="button"
              onClick={() =>
                setDias((prev) =>
                  prev.includes(d.n) ? prev.filter((x) => x !== d.n) : [...prev, d.n],
                )
              }
              className={cn(
                "rounded border px-2 py-1 text-xs",
                dias.includes(d.n)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {d.etiqueta}
            </button>
          ))}
          {dias.length === 0 && (
            <span className="self-center text-xs text-destructive">
              {t("org:pickADay")}
            </span>
          )}
        </div>
      )}

      {freq === "monthly" && (
        <label className="block text-xs text-muted-foreground">
          {t("org:dayOfMonth")}
          <Input
            type="number"
            min={1}
            max={31}
            value={diaDelMes}
            onChange={(e) => setDiaDelMes(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
            className="mt-1 h-8 w-20 text-xs"
          />
          {/* Lo que pasa en los meses cortos, dicho antes de que sorprenda. */}
          {diaDelMes > 28 && (
            <span className="ml-2">{t("org:lastDayNote")}</span>
          )}
        </label>
      )}

      <label className="block max-w-sm text-xs text-muted-foreground">
        {t("org:roomToJoin")}
        <select
          value={sala}
          onChange={(e) => setSala(e.target.value)}
          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
        >
          <option value="">{t("org:noRoom")}</option>
          {salas.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.kind === "general" ? " (general)" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={guardar}
          disabled={guardando || !titulo.trim() || (freq === "weekly" && dias.length === 0)}
        >
          {guardando && <Loader2 className="mr-1 size-3 animate-spin" />} Create
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("org:cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Una reunión, con lo que hay que saber sin abrir nada. */
function Ficha({
  reunion: m,
  canManage,
  miembros,
}: {
  reunion: Meeting;
  canManage: boolean;
  miembros: OrgMember[];
}) {
  const { t } = useT();
  const { resolved: lng } = useLocaleStore();
  const confirm = useConfirm();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const update = useMeetingsStore((s) => s.update);
  const remove = useMeetingsStore((s) => s.remove);
  const setExcluded = useMeetingsStore((s) => s.setExcluded);
  const [abriendoGente, setAbriendoGente] = useState(false);

  const { alla, aqui, mismaZona } = horaDual(m.nextFireAt, m.timezone);
  const convocados = miembros.filter((x) => !m.excludedUserIds.includes(x.userId)).length;

  const alternarPersona = async (userId: string) => {
    if (!orgId) return;
    const fuera = m.excludedUserIds.includes(userId)
      ? m.excludedUserIds.filter((x) => x !== userId)
      : [...m.excludedUserIds, userId];
    try {
      await setExcluded(m.id, orgId, fuera);
    } catch (e) {
      toast.error(t("org:errReach"), { description: String(e) });
    }
  };

  const borrar = async () => {
    if (!orgId) return;
    const ok = await confirm({
      title: `Delete "${m.title}"?`,
      description: t("org:deleteMeetingBody"),
      confirmText: t("org:delete"),
      destructive: true,
    });
    if (ok) remove(m.id, orgId).catch((e) => toast.error(String(e)));
  };

  return (
    <li className={cn("rounded-xl border bg-card", m.paused && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-3">
        <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("truncate font-medium", m.paused && "text-muted-foreground")}>
          {m.title}
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {reglaLegible(m, t, lng)}
        </Badge>
        {m.paused && (
          <Badge variant="outline" className="text-[10px]">
            paused
          </Badge>
        )}
        {m.spaceName && (
          <Badge variant="outline" className="text-[10px]">
            #{m.spaceName}
          </Badge>
        )}
      </div>

      <dl className="grid gap-2 px-3.5 py-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="uppercase tracking-wide text-muted-foreground">{t("org:ringsAt")}</dt>
          {/* Las dos horas: la suya y la tuya. Enseñar sólo una obliga a
              convertir de cabeza, que es donde la gente se equivoca al quedar. */}
          <dd className="mt-0.5">
            <span className="font-medium">{alla}</span>
            {!mismaZona && (
              <span className="text-muted-foreground"> · {aqui} your time</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-muted-foreground">{t("org:reaches")}</dt>
          <dd className="mt-0.5 flex items-center gap-2">
            <span>
              {convocados} of {miembros.length}
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                onClick={() => setAbriendoGente((v) => !v)}
              >
                <Users className="mr-1 size-3" /> {abriendoGente ? t("org:done") : t("org:change")}
              </Button>
            )}
          </dd>
        </div>
      </dl>

      {abriendoGente && (
        <div className="border-t px-3.5 py-3">
          {/* Marcados por defecto, y quien entre en la organización mañana
              entra marcado: lo que se guarda es quién se quitó. */}
          <p className="mb-2 text-xs text-muted-foreground">
            {t("org:everyoneByDefault")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {miembros.map((x) => {
              const dentro = !m.excludedUserIds.includes(x.userId);
              return (
                <li key={x.userId}>
                  <button
                    type="button"
                    onClick={() => alternarPersona(x.userId)}
                    className={cn(
                      "rounded border px-2 py-1 text-xs",
                      dentro
                        ? "border-primary bg-primary/10 text-foreground"
                        : "text-muted-foreground line-through hover:bg-accent",
                    )}
                  >
                    @{x.username}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2">
          <span className="flex-1 text-[11px] text-muted-foreground">
            {m.paused ? t("org:notRinging") : t("org:next")}
            {!m.paused && new Date(m.nextFireAt).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              orgId &&
              update(m.id, orgId, { paused: !m.paused }).catch((e) => toast.error(String(e)))
            }
          >
            {m.paused ? (
              <>
                <Play className="mr-1 size-3" /> Resume
              </>
            ) : (
              <>
                <Pause className="mr-1 size-3" /> Pause
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={borrar}
          >
            <Trash2 className="mr-1 size-3" /> Delete
          </Button>
        </div>
      )}
    </li>
  );
}
