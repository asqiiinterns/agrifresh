import { supabase } from "../lib/supabase";

export type AppAlert = {
  id: string;
  event: string;
  title: string;
  body: string;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type NotificationSetting = { event: string; label: string; audience: string; push_enabled: boolean; email_enabled: boolean; sort_order: number };
export type EmailStatus = { enabled: boolean; from: string; has_key: boolean };

export const alertKinds: Record<string, string> = {
  "order.new": "Commandes",
  "order.status": "Commandes",
  "order.reconfirm": "Commandes",
  "claim.new": "Réclamations",
  "claim.answered": "Réclamations",
  "message.new": "Messages",
  "invoice.issued": "Factures",
  "account.pending": "Comptes",
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchAlerts(): Promise<AppAlert[]> {
  const { data, error } = await client().from("notifications").select("id, event, title, body, order_id, read_at, created_at").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as AppAlert[];
}

export async function countUnreadAlerts(): Promise<number> {
  const { count, error } = await client().from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

export async function markAlertsRead(ids?: string[]): Promise<void> {
  const { error } = await client().rpc("mark_notifications_read", { p_ids: ids ?? null });
  if (error) throw error;
}

export async function fetchMyNotificationPrefs(): Promise<{ push: boolean; email: boolean }> {
  const { data, error } = await client().rpc("my_notification_prefs");
  if (error) throw error;
  return (data ?? { push: true, email: true }) as { push: boolean; email: boolean };
}

export async function setMyNotificationPrefs(push: boolean, email: boolean): Promise<void> {
  const { error } = await client().rpc("set_my_notification_prefs", { p_push: push, p_email: email });
  if (error) throw error;
}

export async function fetchNotificationSettings(): Promise<NotificationSetting[]> {
  const { data, error } = await client().from("notification_settings").select("event, label, audience, push_enabled, email_enabled, sort_order").order("sort_order");
  if (error) throw error;
  return (data ?? []) as NotificationSetting[];
}

export async function setNotificationSetting(event: string, push: boolean, email: boolean): Promise<void> {
  const { error } = await client().rpc("admin_set_notification_setting", { p_event: event, p_push: push, p_email: email });
  if (error) throw error;
}

export async function fetchEmailStatus(): Promise<EmailStatus> {
  const { data, error } = await client().rpc("admin_email_status");
  if (error) throw error;
  return data as EmailStatus;
}

export async function setEmailSettings(enabled: boolean, from: string): Promise<void> {
  const { error } = await client().rpc("admin_set_email_settings", { p_enabled: enabled, p_from: from });
  if (error) throw error;
}

export async function setEmailApiKey(key: string): Promise<void> {
  const { error } = await client().rpc("admin_set_email_api_key", { p_key: key });
  if (error) throw error;
}

export async function sendTestEmail(to: string): Promise<void> {
  const { error } = await client().rpc("admin_send_test_email", { p_to: to });
  if (error) throw error;
}
