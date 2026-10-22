import { Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "../lib/supabase";

// Errors of the application itself, recorded for Appro+ (20261206_client_errors.sql). Never throws.
export type ClientErrorReport = { screen?: string | null; kind?: "render" | "global" | "promise"; message: string; stack?: string | null; component_stack?: string | null };

let currentScreen: string | null = null;
export const setCurrentScreen = (screen: string | null) => { currentScreen = screen; };

export function reportError(report: ClientErrorReport) {
  try {
    if (!supabase) return;
    const url = Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : null;
    void supabase.rpc("log_client_error", { p: {
      screen: report.screen ?? currentScreen,
      kind: report.kind ?? "render",
      message: report.message.slice(0, 2000),
      stack: report.stack?.slice(0, 8000) ?? null,
      component_stack: report.component_stack?.slice(0, 8000) ?? null,
      platform: `${Platform.OS} ${String(Platform.Version ?? "")}`.trim(),
      app_version: Constants.expoConfig?.version ?? null,
      url,
    } }).then(() => undefined, () => undefined);
  } catch {
    // Reporting must never break the application.
  }
}

const describe = (error: unknown) => error instanceof Error
  ? { message: `${error.name}: ${error.message}`, stack: error.stack ?? null }
  : { message: typeof error === "string" ? error : (() => { try { return JSON.stringify(error); } catch { return String(error); } })(), stack: null };

export const reportException = (error: unknown, extra: Omit<ClientErrorReport, "message" | "stack"> = {}) => reportError({ ...extra, ...describe(error) });

// Errors outside a screen (an event handler, a timer, a promise nobody awaited).
let installed = false;
export function installGlobalErrorReporting() {
  if (installed) return;
  installed = true;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.addEventListener("error", (event) => reportException(event.error ?? event.message, { kind: "global" }));
    window.addEventListener("unhandledrejection", (event) => reportException(event.reason, { kind: "promise" }));
    return;
  }
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler: () => (error: unknown, fatal?: boolean) => void; setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => void } }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    reportException(error, { kind: "global" });
    previous(error, fatal);
  });
}

export type ClientError = {
  id: string; created_at: string; last_seen_at: string; occurrences: number; screen: string | null; kind: string; message: string;
  stack: string | null; component_stack: string | null; platform: string | null; app_version: string | null; url: string | null;
  resolved_at: string | null; user: string | null; org_name: string | null;
};

export async function fetchClientErrors(includeResolved = false): Promise<ClientError[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("platform_client_errors", { p_include_resolved: includeResolved });
  if (error) throw error;
  return (data ?? []) as ClientError[];
}

export async function resolveClientError(id: string | null): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("platform_resolve_client_error", { p_id: id });
  if (error) throw error;
}
