import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Las reuniones periódicas de la org (#122).
 *
 * Lo que se fija:
 * 1. Una reunión se edita: a una «diaria» se le quitan días desmarcándolos, y
 *    se le cambia la zona; lo que se manda es la regla nueva entera.
 * 2. Una nueva nace en la zona del equipo, no en la de quien la crea.
 * 3. La hora se dice con su ciudad, y con la tuya si no coincide; mientras se
 *    escribe y en la ficha.
 * 4. Una reunión fuera de la zona del equipo lo avisa.
 *
 * Corre bajo las tres zonas de `test:timezones`, así que «para ti» lleva la
 * ciudad de la zona de cada ejecución.
 */

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));

const { default: OrgMeetings, formFromMeeting } = await import("./OrgMeetings");
const { useMeetingsStore } = await import("@/store/meetings.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useTasksStore } = await import("@/store/tasks.store");
const { myZone, zoneCity, zoneLabel } = await import("@/lib/timezones");
const { pick } = await import("@/test-pick");
import type { Meeting } from "@/store/meetings.store";

const isDaily: Meeting = {
  id: "m-1", orgId: "org-1", title: "Daily", wallTime: "09:30", timezone: "America/Mexico_City",
  freq: "daily", interval: 1, nextFireAt: "2026-10-05T15:30:00Z", paused: false, excludedUserIds: [],
} as unknown as Meeting;

const update = vi.fn();
const create = vi.fn();

function mount(meetings: Meeting[], teamZone?: string) {
  useOrgsStore.setState({
    currentOrgId: "org-1",
    orgs: [{ id: "org-1", name: "Dwit", slug: "dwit", role: "admin", memberCount: 3, timezone: teamZone }],
    listMembers: async () => [],
  } as never);
  useTasksStore.setState({ tree: [] } as never);
  useMeetingsStore.setState({
    meetings, loading: false, agenda: [],
    fetch: vi.fn(async () => {}), fetchAgenda: vi.fn(async () => {}), update, create, remove: vi.fn(), setExcluded: vi.fn(),
  } as never);
  return render(<OrgMeetings canManage />);
}

const mine = () => zoneCity(myZone());

beforeEach(() => {
  update.mockReset().mockResolvedValue(undefined);
  create.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("reuniones", () => {
  it("a una diaria se le quitan días y se le cambia la zona, editándola", async () => {
    mount([isDaily], "America/Cancun");
    fireEvent.click(screen.getByRole("button", { name: /^(editar|edit)$/i }));

    // La diaria se enseña como los siete días marcados.
    const day = (n: string) => screen.getByRole("button", { name: n });
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(day(d).getAttribute("aria-pressed")).toBe("true");
    }
    for (const d of ["Fri", "Sat", "Sun"]) fireEvent.click(day(d));
    // En las sugeridas lleva « · del equipo» detrás: se busca por cómo empieza.
    const cancun = zoneLabel("America/Cancun").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await pick(screen.getByLabelText(/^(zone horaria|time zone)$/i), new RegExp(`^${cancun}`));
    fireEvent.click(screen.getByRole("button", { name: /^(save|save)$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [id, org, draft] = update.mock.calls[0];
    expect([id, org]).toEqual(["m-1", "org-1"]);
    expect(draft).toMatchObject({ title: "Daily", wallTime: "09:30", timezone: "America/Cancun", freq: "weekly", weekdays: "1,2,3,4" });
  });

  it("una nueva nace en la zona del equipo, y dice a qué hora suena allí y para ti", async () => {
    mount([], "America/Cancun");
    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(screen.getByLabelText(/^(zone horaria|time zone)$/i).textContent).toContain(zoneLabel("America/Cancun"));
    fireEvent.change(screen.getByLabelText(/^(time|time)$/i), { target: { value: "09:30" } });
    const view = screen.getByTestId("meeting-preview").textContent ?? "";
    expect(view).toMatch(/0?9:30(\s?[AaPp]\.?\s?[Mm]\.?)? (en|in) Cancun/);
    // Ninguna de las tres zonas de prueba es Cancún: siempre sale la tuya.
    expect(view).toContain(mine());

    // Entre semana es de lunes a viernes.
    fireEvent.click(screen.getByRole("button", { name: /^(entre semana|weekdays)$/i }));
    fireEvent.change(screen.getByLabelText(/(qué es|what it is|daily standup)/i), { target: { value: "Daily" } });
    fireEvent.click(screen.getByRole("button", { name: /^(handleCreate|create)$/i }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ timezone: "America/Cancun", freq: "weekly", weekdays: "1,2,3,4,5" });
  });

  it("sin zona del equipo, la nueva nace en la tuya", () => {
    mount([]);
    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(screen.getByLabelText(/^(zone horaria|time zone)$/i).textContent).toContain(zoneLabel(myZone()));
  });

  it("la ficha dice la hora con su ciudad y avisa si no es la del equipo", () => {
    mount([isDaily], "America/Cancun");
    const when = screen.getByTestId("meeting-when").textContent ?? "";
    expect(when).toMatch(/0?9:30(\s?[AaPp]\.?\s?[Mm]\.?)? (en|in) Mexico City/);
    expect(when).toMatch(/(zone del equipo|team time zone) \(Cancun\)/);
  });

  it("una diaria cada N días no cabe en días de la semana y se queda diaria", () => {
    expect(formFromMeeting({ ...isDaily, interval: 2 } as Meeting, "UTC").freq).toBe("daily");
    expect(formFromMeeting(isDaily, "UTC")).toMatchObject({ freq: "weekly", days: [0, 1, 2, 3, 4, 5, 6] });
    expect(formFromMeeting(undefined, "America/Cancun")).toMatchObject({ zone: "America/Cancun", days: [1, 2, 3, 4, 5] });
  });
});
