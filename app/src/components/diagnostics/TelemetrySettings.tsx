import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Loader2, Plus, X } from "lucide-react";
import Picker from "@/components/ui/picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useT, type MessageKey } from "@/lib/i18n";
import {
  OPS,
  emptyRule,
  formErrors,
  fromForm,
  leafPaths,
  noValue,
  toForm,
  type ConditionForm,
  type ConfigForm,
  type FormError,
} from "@/lib/telemetry-config";
import { cn } from "@/lib/utils";
import { useReportsStore } from "@/store/reports.store";
import type { APIResponse } from "@/types/auth";
import type { ReportProject } from "@/types/report";
import type { TelemetryDeviceDetail, TelemetryDeviceSummary } from "@/types/telemetry";

/**
 * La telemetría de un proyecto: cuánto se guarda, qué cuenta como estar mal y
 * cada cuánto debe latir un dispositivo. Plegada dentro de la ficha de la
 * integración; se guarda aparte del resto del formulario, y entera.
 *
 * Las rutas de las reglas se sugieren con las claves del último estado que
 * mandó un dispositivo del proyecto: escribirlas de memoria era la forma de
 * dejar una regla que nunca salta.
 */
export default function TelemetrySettings({ project: p, canManage }: { project: ReportProject; canManage: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const configured = !!(p.telemetryConfig?.heartbeat || p.telemetryConfig?.healthRules?.length || p.telemetryConfig?.retentionDays);

  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-xs hover:bg-accent/40"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className="font-medium">{t("diagnostics:settings.title")}</span>
        <span className="text-muted-foreground">
          · {configured ? t("diagnostics:settings.configured") : t("diagnostics:settings.notConfigured")}
        </span>
      </button>
      {open && <Editor project={p} canManage={canManage} />}
    </div>
  );
}

const ERROR_KEY: Record<string, MessageKey> = {
  retention: "diagnostics:settings.errors.retention",
  interval: "diagnostics:settings.errors.interval",
  grace: "diagnostics:settings.errors.grace",
  activeWhen: "diagnostics:settings.errors.activeWhen",
};

function errorText(t: ReturnType<typeof useT>["t"], e: FormError): string {
  if (e.field === "rule") {
    return t(e.what === "message" ? "diagnostics:settings.errors.ruleMessage" : "diagnostics:settings.errors.ruleNumber", { n: e.index + 1 });
  }
  return t(ERROR_KEY[e.field]);
}

function Editor({ project: p, canManage }: { project: ReportProject; canManage: boolean }) {
  const { t } = useT();
  const updateProject = useReportsStore((s) => s.updateProject);
  const [form, setForm] = useState<ConfigForm>(() => toForm(p.telemetryConfig));
  const [saving, setSaving] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const listId = useId();
  const errors = formErrors(form);

  // Las rutas del último estado de un dispositivo del proyecto. Sin dispositivo
  // no hay sugerencias, y se escribe a mano.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.get<APIResponse<TelemetryDeviceSummary[]>>(
          `/api/v1/telemetry/devices?projectId=${encodeURIComponent(p.id)}&limit=1`,
        );
        const d = list.data?.[0];
        if (!d) return;
        const detail = await api.get<APIResponse<TelemetryDeviceDetail>>(
          `/api/v1/telemetry/devices/${encodeURIComponent(p.id)}/${encodeURIComponent(d.deviceId)}`,
        );
        if (alive && detail.data?.device) setPaths(leafPaths(detail.data.device));
      } catch {
        // Sin sugerencias; no es un error que haya que enseñar.
      }
    })();
    return () => {
      alive = false;
    };
  }, [p.id]);

  const save = async () => {
    if (errors.length) return;
    setSaving(true);
    try {
      await updateProject(p.id, { telemetryConfig: fromForm(form) });
      toast.success(t("diagnostics:settings.saved"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;
  const setRule = (i: number, patch: Partial<ConfigForm["rules"][number]>) =>
    setForm((f) => ({ ...f, rules: f.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  return (
    <div className="space-y-4 px-3.5 pb-3 text-xs">
      <p className="text-muted-foreground">{t("diagnostics:settings.intro")}</p>
      {!canManage && <p className="text-warning">{t("diagnostics:settings.readOnly")}</p>}
      <datalist id={listId}>
        {paths.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>

      <label className="flex items-center gap-2">
        <span>{t("diagnostics:settings.retention")}</span>
        <Input
          value={form.retentionDays}
          onChange={(e) => setForm({ ...form, retentionDays: e.target.value })}
          inputMode="numeric"
          disabled={disabled}
          className="h-8 w-20 text-xs"
          aria-label={t("diagnostics:settings.retention")}
        />
        <span className="text-muted-foreground">
          {t("diagnostics:settings.retentionDays")} · {t("diagnostics:settings.retentionDefault")}
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="font-medium">{t("diagnostics:settings.rules")}</legend>
        <p className="text-muted-foreground">{t("diagnostics:settings.rulesHint")}</p>
        {form.rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded border p-2" data-rule={i}>
            <ConditionFields
              value={r}
              onChange={(c) => setRule(i, c)}
              disabled={disabled}
              listId={listId}
            />
            <Picker
              size="sm"
              aria-label={t("diagnostics:timeline.severity")}
              value={r.severity}
              onChange={(v) => setRule(i, { severity: v as "warn" | "error" })}
              disabled={disabled}
              options={[
                { value: "warn", label: t("diagnostics:settings.severityWarn") },
                { value: "error", label: t("diagnostics:settings.severityError") },
              ]}
            />
            <Input
              value={r.message}
              onChange={(e) => setRule(i, { message: e.target.value })}
              placeholder={t("diagnostics:settings.message")}
              aria-label={t("diagnostics:settings.message")}
              disabled={disabled}
              className="h-8 min-w-40 flex-1 text-xs"
            />
            {canManage && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("diagnostics:settings.removeRule")}
                onClick={() => setForm({ ...form, rules: form.rules.filter((_, j) => j !== i) })}
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        ))}
        {canManage && (
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setForm({ ...form, rules: [...form.rules, emptyRule()] })}>
            <Plus className="mr-1 size-3" /> {t("diagnostics:settings.addRule")}
          </Button>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">{t("diagnostics:settings.heartbeat")}</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.heartbeatOn}
            onChange={(e) => setForm({ ...form, heartbeatOn: e.target.checked })}
            disabled={disabled}
          />
          {t("diagnostics:settings.heartbeatOn")}
        </label>
        {form.heartbeatOn && (
          <div className="space-y-2 pl-5">
            <div className="flex flex-wrap gap-3">
              <label className="space-y-1">
                <span className="block text-muted-foreground">{t("diagnostics:settings.interval")}</span>
                <Input
                  value={form.intervalSeconds}
                  onChange={(e) => setForm({ ...form, intervalSeconds: e.target.value })}
                  inputMode="numeric"
                  disabled={disabled}
                  className="h-8 w-28 text-xs"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-muted-foreground">{t("diagnostics:settings.grace")}</span>
                <Input
                  value={form.graceSeconds}
                  onChange={(e) => setForm({ ...form, graceSeconds: e.target.value })}
                  inputMode="numeric"
                  disabled={disabled}
                  className="h-8 w-28 text-xs"
                />
              </label>
            </div>
            <div className="space-y-1">
              <span className="block text-muted-foreground">{t("diagnostics:settings.activeWhen")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <ConditionFields
                  value={form.activeWhen}
                  onChange={(c) => setForm({ ...form, activeWhen: { ...form.activeWhen, ...c } })}
                  disabled={disabled}
                  listId={listId}
                />
              </div>
              <p className="text-muted-foreground">{t("diagnostics:settings.activeWhenHint")}</p>
            </div>
          </div>
        )}
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-error">
          {errors.map((e, i) => (
            <li key={i}>{errorText(t, e)}</li>
          ))}
        </ul>
      )}
      {canManage && (
        <Button size="sm" onClick={() => void save()} disabled={saving || errors.length > 0}>
          {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
          {t("diagnostics:settings.save")}
        </Button>
      )}
    </div>
  );
}

function ConditionFields({
  value,
  onChange,
  disabled,
  listId,
}: {
  value: ConditionForm;
  onChange: (c: Partial<ConditionForm>) => void;
  disabled: boolean;
  listId: string;
}) {
  const { t } = useT();
  return (
    <>
      <Input
        value={value.path}
        onChange={(e) => onChange({ path: e.target.value })}
        placeholder={t("diagnostics:settings.path")}
        aria-label={t("diagnostics:settings.path")}
        list={listId}
        disabled={disabled}
        className="h-8 min-w-52 flex-1 font-mono text-xs"
      />
      <Picker
        size="sm"
        aria-label={t("diagnostics:settings.op")}
        value={value.op}
        onChange={(v) => onChange({ op: v as ConditionForm["op"] })}
        disabled={disabled}
        options={OPS.map((o) => ({ value: o, label: o }))}
      />
      {!noValue(value.op) && (
        <Input
          value={value.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder={t("diagnostics:settings.value")}
          aria-label={t("diagnostics:settings.value")}
          disabled={disabled}
          className="h-8 w-28 font-mono text-xs"
        />
      )}
    </>
  );
}
