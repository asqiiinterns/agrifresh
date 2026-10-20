import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { supabase } from "../lib/supabase";

// Driver offline mode: lists are cached on the phone, shipments and hand-overs made without
// network are queued and sent automatically when the connection comes back.

type QueuedAction = { id: string; kind: "ship" | "deliver"; rpc: string; args: Record<string, unknown>; label: string; created_at: string };
const QUEUE_KEY = "agrifresh-offline-queue";
const FAILED_KEY = "agrifresh-offline-failed";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export async function isOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected !== false && state.isInternetReachable !== false;
  } catch {
    return true;
  }
}

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => NetInfo.addEventListener((state) => setOnline(state.isConnected !== false && state.isInternetReachable !== false)), []);
  return online;
}

export async function cacheSet(key: string, value: unknown) {
  try { await AsyncStorage.setItem(`agrifresh-cache-${key}`, JSON.stringify(value)); } catch { /* cache is best effort */ }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const stored = await AsyncStorage.getItem(`agrifresh-cache-${key}`);
    return stored ? JSON.parse(stored) as T : null;
  } catch {
    return null;
  }
}

async function readQueue(): Promise<QueuedAction[]> {
  try { return JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? "[]") as QueuedAction[]; } catch { return []; }
}
async function writeQueue(queue: QueuedAction[]) {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  changed();
}

export async function enqueue(kind: QueuedAction["kind"], rpc: string, args: Record<string, unknown>, label: string) {
  const queue = await readQueue();
  queue.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, rpc, args, label, created_at: new Date().toISOString() });
  await writeQueue(queue);
}

// Sends the queued actions in order; stops at the first network failure, keeps server refusals aside.
let flushing = false;
export async function flushQueue(): Promise<{ sent: number; failed: string[] }> {
  if (flushing || !supabase || !(await isOnline())) return { sent: 0, failed: [] };
  flushing = true;
  let sent = 0;
  const failed: string[] = [];
  try {
    let queue = await readQueue();
    while (queue.length) {
      const action = queue[0];
      const { error } = await supabase.rpc(action.rpc, action.args);
      if (error && /fetch|network|timeout/i.test(error.message)) break;
      if (error) failed.push(`${action.label} : ${error.message}`);
      else sent += 1;
      queue = queue.slice(1);
      await writeQueue(queue);
    }
    if (failed.length) {
      const previous = JSON.parse((await AsyncStorage.getItem(FAILED_KEY)) ?? "[]") as string[];
      await AsyncStorage.setItem(FAILED_KEY, JSON.stringify([...previous, ...failed].slice(-20)));
    }
  } finally {
    flushing = false;
    changed();
  }
  return { sent, failed };
}

export function useOfflineQueue() {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const refresh = () => { void readQueue().then((queue) => setPending(queue.length)); };
    refresh();
    listeners.add(refresh);
    // Back online: send what was recorded without network.
    const unsubscribe = NetInfo.addEventListener((state) => { if (state.isConnected) void flushQueue(); });
    return () => { listeners.delete(refresh); unsubscribe(); };
  }, []);
  return pending;
}
