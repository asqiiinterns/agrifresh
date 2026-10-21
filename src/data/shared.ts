import { supabase } from "../lib/supabase";

// Identical requests started at the same time (home tiles, the « À décider » badge, the decision board)
// share one network call. Only requests still in flight are shared: a later call always reloads.
// fresh: after a change (made here or announced live), a request started before it is not reused.
const inFlight = new Map<string, Promise<unknown>>();

export function shared<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  let promise = fresh ? undefined : inFlight.get(key) as Promise<T> | undefined;
  if (!promise) {
    const started: Promise<T> = load().finally(() => { if (inFlight.get(key) === started) inFlight.delete(key); });
    inFlight.set(key, started);
    promise = started;
  }
  // Each caller gets its own copy of a list, so sorting it on one screen does not affect another.
  return promise.then((value) => (Array.isArray(value) ? [...value] : value) as T);
}

// After signing in or changing space, a request started for the previous space must not be reused.
export const clearShared = () => inFlight.clear();

// A buyer's account: returns, credit notes, claims and recurring orders are read and made across all its
// suppliers (buyer_* functions of 20261122) instead of the selected one. Set when the account is loaded.
let buyer = false;
export const setBuyerMode = (value: boolean) => { buyer = value; };
export const isBuyerMode = () => buyer;

// Calls a function of a newer migration, or falls back to the former way when it is not installed yet.
export async function rpcOr<T>(name: string, args: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> {
  if (!supabase) return fallback();
  const { data, error } = await supabase.rpc(name, args);
  if (error && (error.code === "PGRST202" || error.code === "42883")) return fallback();
  if (error) throw error;
  return data as T;
}
