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
