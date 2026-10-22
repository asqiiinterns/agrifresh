import { supabase } from "../lib/supabase";

// The home figures counted by the database (20261205_home_counts.sql), with the person's own rights.
// null: the function is not installed yet; the home then counts the lists itself, as before.
export async function fetchHomeCounts(): Promise<Record<string, number> | null> {
  if (!supabase) return null;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const { data, error } = await supabase.rpc("home_counts", { p_today: today, p_offset_minutes: now.getTimezoneOffset() });
  if (error || !data || typeof data !== "object") return null;
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, Number(value) || 0]));
}

// The « À décider » badge from the database counts plus the few lists that are not counts (no download of every
// order). Same rules as the board: each list only if the person may act on it. null: counts not installed yet.
export async function fetchDecideCount(can: (feature: string) => boolean, isAdmin: boolean): Promise<number | null> {
  const counts = await fetchHomeCounts();
  if (!counts) return null;
  const today = new Date().toISOString().slice(0, 10);
  const [{ fetchWaitingMessages }, { fetchBillingBoard }, { fetchAccounts }, { fetchLeaves }] = await Promise.all([
    import("./decisions"), import("./invoices"), import("./admin"), import("./workplace"),
  ]);
  const [messages, billing, accounts, leaves] = await Promise.all([
    can("messages.manage") || can("team.messages") ? fetchWaitingMessages() : Promise.resolve(null),
    can("invoices.manage") ? fetchBillingBoard().catch(() => null) : Promise.resolve(null),
    isAdmin ? fetchAccounts().catch(() => []) : Promise.resolve([]),
    can("leave.manage") || isAdmin ? fetchLeaves(today, "2100-01-01").catch(() => []) : Promise.resolve([]),
  ]);
  const ordersAllowed = can("orders.view") || can("orders.decide") || can("orders.plan");
  return (can("orders.decide") ? counts.decide ?? 0 : 0)
    + (ordersAllowed ? counts.special ?? 0 : 0)
    + (can("orders.plan") ? counts.reschedule ?? 0 : 0)
    + (can("claims.manage") ? counts.claims ?? 0 : 0)
    + (messages ? messages.clients.length + messages.team.length : 0)
    + (billing ? billing.due.length + billing.overdue.length : 0)
    + (can("returns.manage") ? counts.returns ?? 0 : 0)
    + (isAdmin ? accounts.filter((item) => item.status === "pending").length : 0)
    + leaves.filter((leave) => leave.status === "pending" && !leave.mine).length
    + (can("incidents.manage") ? counts.incidents ?? 0 : 0);
}
