import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// Production steps of the Pro (20261130): with or without « En préparation », automatic « Préparée » once every
// product is ticked, its own steps inside the preparation, and whether its clients see them.
export type Workflow = { preparing: boolean; auto_ready: boolean; steps: string[]; client_sees_steps: boolean; auto_deliver_hours?: number };
export const defaultWorkflow: Workflow = { preparing: true, auto_ready: false, steps: [], client_sees_steps: true };

let current: Workflow = defaultWorkflow;
let loaded: Promise<Workflow> | null = null;
const listeners = new Set<(value: Workflow) => void>();

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

// Read once per session (and again after a change); before the migration, the built-in steps.
export function loadWorkflow(fresh = false): Promise<Workflow> {
  if (!loaded || fresh) {
    loaded = (async () => {
      if (!supabase) return defaultWorkflow;
      const { data, error } = await supabase.rpc("my_workflow_settings");
      const next = error || !data ? defaultWorkflow : { ...defaultWorkflow, ...(data as Partial<Workflow>) };
      current = next;
      listeners.forEach((listener) => listener(next));
      return next;
    })();
  }
  return loaded;
}

export function useWorkflow(): Workflow {
  const [value, setValue] = useState<Workflow>(current);
  useEffect(() => {
    listeners.add(setValue);
    void loadWorkflow().then(setValue);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

export async function saveWorkflow(input: Partial<Workflow>): Promise<Workflow> {
  const { data, error } = await client().rpc("set_workflow", { p_workflow: input });
  if (error) throw error;
  current = { ...current, ...(data as Partial<Workflow>) };
  loaded = Promise.resolve(current);
  listeners.forEach((listener) => listener(current));
  return current;
}

// Shared ticks of « À préparer »: null while the migration is not run (the phone keeps its own ticks then).
export async function fetchPrepTicks(): Promise<string[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("prep_ticks");
  if (error) return null;
  return (data ?? []) as string[];
}

export async function prepTick(itemIds: string[], done: boolean): Promise<{ started: string[]; ready: string[] }> {
  const { data, error } = await client().rpc("prep_tick", { p_item_ids: itemIds, p_done: done });
  if (error) throw error;
  return data as { started: string[]; ready: string[] };
}

export async function prepStep(orderId: string, step: string, done: boolean): Promise<string[]> {
  const { data, error } = await client().rpc("prep_step", { p_order_id: orderId, p_step: step, p_done: done });
  if (error) throw error;
  return (data ?? []) as string[];
}
