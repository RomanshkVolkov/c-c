import { fechaLegible, horaCorta } from "@/lib/fechas";
import { useLocaleStore } from "@/store/locale.store";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, CalendarDays, List, Loader2, Pause, Pencil, Play, Plus, Trash2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ConfirmDialog";
import { useMeetingsStore, type Meeting, type MeetingDraft } from "@/store/meetings.store";
import ItemCalendar, { type CalendarItem } from "@/components/ItemCalendar";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { readableRule } from "@/lib/meeting-time";
import { hourIn, isZone, myZone, wallTimeToday, zoneCity } from "@/lib/timezones";
import TimezoneSelect from "@/components/TimezoneSelect";
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
  const teamZone = useOrgsStore((s) => s.orgs.find((o) => o.id === s.currentOrgId)?.timezone) || undefined;
  const listMembers = useOrgsStore((s) => s.listMembers);
  const meetings = useMeetingsStore((s) => s.meetings);
  const loading = useMeetingsStore((s) => s.loading);
  const fetch = useMeetingsStore((s) => s.fetch);
  const create = useMeetingsStore((s) => s.create);

  const agenda = useMeetingsStore((s) => s.agenda);
  const fetchAgenda = useMeetingsStore((s) => s.fetchAgenda);

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Lista o calendario. La lista primero: es donde se edita. */
  const [view, setView] = useState<"list" | "calendar">("list");

  useEffect(() => {
    if (orgId) fetch(orgId).catch(() => {});
  }, [orgId, fetch]);

  useEffect(() => {
    if (orgId) listMembers(orgId).then(setMembers).catch(() => {});
  }, [orgId, listMembers]);

  // Sólo al mirar el calendario: expandir dos meses de repeticiones para una
  // pantalla que nadie ha abierto es trabajo tirado.
  useEffect(() => {
    if (orgId && view === "calendar") fetchAgenda(orgId).catch(() => {});
  }, [orgId, view, fetchAgenda, meetings]);

  const handleCreate = async (draft: MeetingDraft) => {
    if (!orgId) return;
    setSaving(true);
    try {
      await create(orgId, draft);
      setCreating(false);
    } catch (e) {
      toast.error(t("org:errCreateMeeting"), { description: String(e) });
    } finally {
      setSaving(false);
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
            variant={view === "list" ? "secondary" : "ghost"}
            onClick={() => setView("list")}
          >
            <List className="mr-1 size-3" /> List
          </Button>
          <Button
            size="sm"
            variant={view === "calendar" ? "secondary" : "ghost"}
            onClick={() => setView("calendar")}
          >
            <CalendarDays className="mr-1 size-3" /> Calendar
          </Button>
        </div>
        {canManage && !creating && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-3" /> New
          </Button>
        )}
      </div>

      {creating && (
        <MeetingForm
          saving={saving}
          teamZone={teamZone}
          onCancel={() => setCreating(false)}
          onSave={handleCreate}
        />
      )}

      {view === "calendar" ? (
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
              label: horaCorta(o.at),
            }),
          )}
          onOpen={() => setView("list")}
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
            <MeetingCard key={m.id} meeting={m} canManage={canManage} members={members} teamZone={teamZone} />
          ))}
        </ul>
      )}
    </section>
  );
}

const WEEKDAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 0, label: "Sun" },
];
const WORKWEEK = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Lo que dice el formulario de una reunión que ya existe.
 *
 * «Diaria» cada 1 día es lo mismo que semanal con los siete días, y así se
 * enseña: los días se marcan siempre, y quitar el viernes de una «diaria» es
 * desmarcarlo (#122). Una diaria cada N días (N > 1) no cabe en días de la
 * semana y se queda como diaria.
 */
export function formFromMeeting(m: Meeting | undefined, zonaPorDefecto: string) {
  if (!m) {
    return { title: "", time: "09:00", zone: zonaPorDefecto, freq: "weekly" as Meeting["freq"], days: WORKWEEK, monthDay: 1, every: 1, room: "" };
  }
  const isDaily = m.freq === "daily" && m.interval <= 1;
  return {
    title: m.title,
    time: m.wallTime,
    zone: m.timezone,
    freq: isDaily ? ("weekly" as const) : m.freq,
    days: isDaily ? ALL_DAYS : (m.weekdays ?? "").split(",").filter(Boolean).map(Number),
    monthDay: m.monthDay ?? 1,
    every: m.interval || 1,
    room: m.spaceId ?? "",
  };
}

function MeetingForm({
  saving,
  existing,
  teamZone,
  onCancel,
  onSave,
}: {
  saving: boolean;
  /** La reunión a editar; sin ella, se crea una. */
  existing?: Meeting;
  /** La zona del equipo: las reuniones nuevas nacen en ella. */
  teamZone?: string;
  onCancel: () => void;
  onSave: (d: MeetingDraft) => void;
}) {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  // La sala general primero: es la que va a querer la mayoría de reuniones de
  // toda la organización.
  const rooms = [...tree].sort((a, b) => (a.kind === "general" ? -1 : b.kind === "general" ? 1 : 0));

  const defaults = formFromMeeting(existing, teamZone || myZone());
  const [title, setTitle] = useState(defaults.title);
  const [time, setTime] = useState(defaults.time);
  const [zone, setZone] = useState(defaults.zone);
  const [freq, setFreq] = useState<Meeting["freq"]>(defaults.freq);
  const [days, setDays] = useState<number[]>(defaults.days);
  const [monthDay, setMonthDay] = useState(defaults.monthDay);
  const [every, setEvery] = useState(defaults.every);
  const [room, setRoom] = useState(defaults.room);

  const sameDays = (a: number[], b: number[]) => a.length === b.length && b.every((x) => a.includes(x));

  // A qué hora suena, en su zona y en la tuya: lo que hay que ver **antes** de
  // guardar, no después (el «9:30» que era de otra zona).
  const instant = wallTimeToday(time, zone);
  const mine = myZone();

  const save = () => {
    const t = title.trim();
    if (!t) return;
    onSave({
      title: t,
      wallTime: time,
      timezone: zone,
      freq,
      interval: every,
      weekdays: freq === "weekly" ? [...days].sort().join(",") : undefined,
      monthDay: freq === "monthly" ? monthDay : undefined,
      // El ancla del ciclo cuando se repite cada N: sin ella «cada dos semanas»
      // no dice cuál de las dos es. Hoy es una respuesta tan buena como otra.
      anchor: every > 1 ? (existing?.anchor || new Date().toISOString().slice(0, 10)) : undefined,
      spaceId: room || (existing ? "" : undefined),
    });
  };

  return (
    <div className="space-y-3 rounded-xl border bg-card p-3">
      <Input
        autoFocus
        aria-label={t("org:meetingNamePlaceholder")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("org:meetingNamePlaceholder")}
        className="max-w-sm"
      />

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-muted-foreground">
          {t("org:time")}
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-1 h-8 w-32 text-xs"
          />
        </label>
        <label className="min-w-52 flex-1 text-xs text-muted-foreground">
          {t("org:timeZone")}
          <TimezoneSelect
            ariaLabel={t("org:timeZone")}
            value={zone}
            teamZone={teamZone}
            onChange={setZone}
            className="mt-1 block h-8 w-full rounded-md border bg-background px-2 text-xs"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t("org:repeats")}
          <select
            aria-label={t("org:repeats")}
            value={freq}
            onChange={(e) => setFreq(e.target.value as Meeting["freq"])}
            className="mt-1 h-8 w-36 rounded-md border bg-background px-2 text-xs"
          >
            <option value="weekly">{t("org:onTheseDays")}</option>
            <option value="monthly">{t("org:monthly")}</option>
            {/* Sólo para una que ya era «cada N días»: no cabe en días de la semana. */}
            {freq === "daily" && <option value="daily">{t("org:daily")}</option>}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {t("org:every")}
          <Input
            type="number"
            min={1}
            max={52}
            value={every}
            onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))}
            className="mt-1 h-8 w-20 text-xs"
          />
        </label>
      </div>

      {freq === "weekly" && (
        <div className="flex flex-wrap items-center gap-1">
          {WEEKDAYS.map((d) => (
            <button
              key={d.n}
              type="button"
              aria-pressed={days.includes(d.n)}
              onClick={() =>
                setDays((prev) =>
                  prev.includes(d.n) ? prev.filter((x) => x !== d.n) : [...prev, d.n],
                )
              }
              className={cn(
                "rounded border px-2 py-1 text-xs",
                days.includes(d.n)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {d.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <Button type="button" size="sm" variant={sameDays(days, WORKWEEK) ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setDays(WORKWEEK)}>
            {t("org:weekdaysPreset")}
          </Button>
          <Button type="button" size="sm" variant={sameDays(days, ALL_DAYS) ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setDays(ALL_DAYS)}>
            {t("org:everyDayPreset")}
          </Button>
          {days.length === 0 && (
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
            value={monthDay}
            onChange={(e) => setMonthDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
            className="mt-1 h-8 w-20 text-xs"
          />
          {/* Lo que pasa en los meses cortos, dicho antes de que sorprenda. */}
          {monthDay > 28 && (
            <span className="ml-2">{t("org:lastDayNote")}</span>
          )}
        </label>
      )}

      {instant && (
        <p className="text-xs" data-testid="meeting-preview">
          {t("org:ringsThere", { time: hourIn(instant, zone), city: zoneCity(zone) })}
          {zone !== mine && hourIn(instant, zone) !== hourIn(instant) && (
            <span className="text-muted-foreground"> · {t("org:ringsHere", { time: hourIn(instant), city: zoneCity(mine) })}</span>
          )}
        </p>
      )}

      <label className="block max-w-sm text-xs text-muted-foreground">
        {t("org:roomToJoin")}
        <select
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
        >
          <option value="">{t("org:noRoom")}</option>
          {rooms.map((s) => (
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
          onClick={save}
          disabled={saving || !title.trim() || (freq === "weekly" && days.length === 0)}
        >
          {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
          {existing ? t("org:saveMeeting") : t("org:createMeeting")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("org:cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Una reunión, con lo que hay que saber sin abrir nada. */
function MeetingCard({
  meeting: m,
  canManage,
  members,
  teamZone,
}: {
  meeting: Meeting;
  canManage: boolean;
  members: OrgMember[];
  teamZone?: string;
}) {
  const { t } = useT();
  const { resolved: lng } = useLocaleStore();
  const confirm = useConfirm();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const update = useMeetingsStore((s) => s.update);
  const remove = useMeetingsStore((s) => s.remove);
  const setExcluded = useMeetingsStore((s) => s.setExcluded);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // La hora dicha con su ciudad, y la tuya si no coincide: «9:30 en Cancun ·
  // 8:30 para ti (Mexico City)». Antes era «09:30 GMT-6», que no dice dónde.
  const when = new Date(m.nextFireAt);
  const valid = !Number.isNaN(when.getTime()) && isZone(m.timezone);
  const mine = myZone();
  const thereTime = valid ? hourIn(when, m.timezone) : m.wallTime;
  const hereTime = valid ? hourIn(when) : "";
  const showHere = valid && m.timezone !== mine && thereTime !== hereTime;

  const saveEdit = async (draft: MeetingDraft) => {
    if (!orgId) return;
    setSaving(true);
    try {
      await update(m.id, orgId, draft);
      setEditing(false);
    } catch (e) {
      toast.error(t("org:errSaveMeeting"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <li>
        <MeetingForm
          saving={saving}
          existing={m}
          teamZone={teamZone}
          onCancel={() => setEditing(false)}
          onSave={(d) => void saveEdit(d)}
        />
      </li>
    );
  }
  const invitedCount = members.filter((x) => !m.excludedUserIds.includes(x.userId)).length;

  const togglePerson = async (userId: string) => {
    if (!orgId) return;
    const excluded = m.excludedUserIds.includes(userId)
      ? m.excludedUserIds.filter((x) => x !== userId)
      : [...m.excludedUserIds, userId];
    try {
      await setExcluded(m.id, orgId, excluded);
    } catch (e) {
      toast.error(t("org:errReach"), { description: String(e) });
    }
  };

  const deleteMeeting = async () => {
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
          {readableRule(m, t, lng)}
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
          <dd className="mt-0.5" data-testid="meeting-when">
            <span className="font-medium">{t("org:ringsThere", { time: thereTime, city: zoneCity(m.timezone) })}</span>
            {showHere ? (
              <span className="text-muted-foreground"> · {t("org:ringsHere", { time: hereTime, city: zoneCity(mine) })}</span>
            ) : (
              m.timezone === mine && <span className="text-muted-foreground"> · {t("org:yourZone")}</span>
            )}
            {teamZone && m.timezone !== teamZone && (
              <span className="block text-[11px] text-warning">{t("org:notTeamZone", { city: zoneCity(teamZone) })}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-muted-foreground">{t("org:reaches")}</dt>
          <dd className="mt-0.5 flex items-center gap-2">
            <span>
              {invitedCount} of {members.length}
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                onClick={() => setPeopleOpen((v) => !v)}
              >
                <Users className="mr-1 size-3" /> {peopleOpen ? t("org:done") : t("org:change")}
              </Button>
            )}
          </dd>
        </div>
      </dl>

      {peopleOpen && (
        <div className="border-t px-3.5 py-3">
          {/* Marcados por defecto, y quien entre en la organización mañana
              entra marcado: lo que se guarda es quién se quitó. */}
          <p className="mb-2 text-xs text-muted-foreground">
            {t("org:everyoneByDefault")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {members.map((x) => {
              const included = !m.excludedUserIds.includes(x.userId);
              return (
                <li key={x.userId}>
                  <button
                    type="button"
                    onClick={() => togglePerson(x.userId)}
                    className={cn(
                      "rounded border px-2 py-1 text-xs",
                      included
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
            {!m.paused && fechaLegible(m.nextFireAt)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-3" /> {t("org:edit")}
          </Button>
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
            onClick={deleteMeeting}
          >
            <Trash2 className="mr-1 size-3" /> Delete
          </Button>
        </div>
      )}
    </li>
  );
}
