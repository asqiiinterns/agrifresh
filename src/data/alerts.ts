import { supabase } from "../lib/supabase";
import type { NavParams, TabKey } from "../ui/navigation";

export type AppAlert = {
  id: string;
  event: string;
  title: string;
  body: string;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
  // Flagged by the recipient (column added by 20261028_alert_important.sql).
  important?: boolean;
  // Team conversation the alert is about (20261029_team_messages.sql).
  conversation_id?: string | null;
  // Personal note (20261030_numbering_returns.sql).
  note?: string | null;
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
  "team.message": "Messages",
  "return.new": "Retours",
  "return.update": "Retours",
  "credit.issued": "Avoirs",
};

// Where an alert leads: the order itself, the conversation, the invoices or the account to validate.
export function alertTarget(event: string | undefined, orderId: string | null | undefined, team: boolean, conversationId?: string | null): { tab: TabKey; params?: NavParams } {
  const order = orderId ? { orderId } : {};
  switch (event) {
    case "order.new": return { tab: "orders", params: team ? { section: "decide", ...order } : order };
    case "order.status":
    case "order.reconfirm": return { tab: "orders", params: order };
    case "claim.new": return { tab: "orders", params: team ? { section: "claims", ...order } : order };
    case "claim.answered": return { tab: "orders", params: order };
    case "message.new": return { tab: "messages", params: { section: "clients" } };
    case "team.message": return { tab: "messages", params: { section: "team", page: conversationId ?? undefined } };
    case "invoice.issued": return { tab: "invoices" };
    case "account.pending": return { tab: "admin", params: { page: "accounts" } };
    case "return.new": return { tab: "returns" };
    case "return.update": return team ? { tab: "returns" } : { tab: "invoices", params: { section: "returns" } };
    case "credit.issued": return team ? { tab: "returns", params: { section: "credits" } } : { tab: "invoices", params: { section: "credits" } };
    default: return { tab: "alerts" };
  }
}

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchAlerts(): Promise<AppAlert[]> {
  const { data, error } = await client().from("notifications").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as AppAlert[];
}

// A push notification only carries the alert id: look up the team conversation it opens.
export async function fetchAlertConversation(id: string): Promise<string | null> {
  const { data } = await client().from("notifications").select("*").eq("id", id).maybeSingle();
  return (data as AppAlert | null)?.conversation_id ?? null;
}

export async function markAlertsUnread(ids: string[]): Promise<void> {
  const { error } = await client().rpc("mark_notifications_unread", { p_ids: ids });
  if (error) throw error;
}

export async function setAlertNote(id: string, note: string): Promise<void> {
  const { error } = await client().rpc("set_notification_note", { p_id: id, p_note: note });
  if (error) throw error;
}

export async function setAlertImportant(id: string, important: boolean): Promise<void> {
  const { error } = await client().rpc("set_notification_important", { p_id: id, p_important: important });
  if (error) throw error;
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
