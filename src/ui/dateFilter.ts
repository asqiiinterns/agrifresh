import { toDayKey } from "./components";

// A date filter: a period (inclusive days) or "no date"; null = no filter.
export type DateFilterValue = { label: string; from?: string; to?: string; noDate?: boolean } | null;
export type DatePreset = { label: string; value: () => NonNullable<DateFilterValue> };

const shift = (days: number) => {
  const today = new Date();
  return toDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
};

export const dayLabel = (key: string) =>
  new Date(`${key}T12:00:00`).toLocaleDateString("fr-TN", { day: "numeric", month: "short" });

export const rangeLabel = (from: string, to: string) => from === to ? dayLabel(from) : `${dayLabel(from)} → ${dayLabel(to)}`;

export const presets = {
  late: { label: "En retard", value: () => ({ label: "En retard", to: shift(-1) }) },
  today: { label: "Aujourd’hui", value: () => ({ label: "Aujourd’hui", from: shift(0), to: shift(0) }) },
  tomorrow: { label: "Demain", value: () => ({ label: "Demain", from: shift(1), to: shift(1) }) },
  next7: { label: "7 prochains jours", value: () => ({ label: "7 prochains jours", from: shift(0), to: shift(6) }) },
  yesterday: { label: "Hier", value: () => ({ label: "Hier", from: shift(-1), to: shift(-1) }) },
  last7: { label: "7 derniers jours", value: () => ({ label: "7 derniers jours", from: shift(-6), to: shift(0) }) },
  last30: { label: "30 derniers jours", value: () => ({ label: "30 derniers jours", from: shift(-29), to: shift(0) }) },
  thisMonth: { label: "Ce mois-ci", value: () => {
    const today = new Date();
    return { label: "Ce mois-ci", from: toDayKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: shift(0) };
  } },
  lastMonth: { label: "Mois dernier", value: () => {
    const today = new Date();
    return { label: "Mois dernier", from: toDayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: toDayKey(new Date(today.getFullYear(), today.getMonth(), 0)) };
  } },
  noDate: { label: "Sans date", value: () => ({ label: "Sans date", noDate: true }) },
} satisfies Record<string, DatePreset>;

// Day of an ISO date or timestamp, in local time (what the user picked on the calendar).
export const dayOf = (value: string | null | undefined) => {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : toDayKey(new Date(value));
};

export function matchesDate(value: string | null | undefined, filter: DateFilterValue) {
  if (!filter) return true;
  const day = dayOf(value);
  if (filter.noDate) return day === null;
  if (!day) return false;
  return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
}
