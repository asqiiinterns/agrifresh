import { supabase } from "../lib/supabase";
import type { Attachment } from "./attachments";

export type Message = {
  id: string;
  client_id: string;
  sender_id?: string | null;
  from_staff: boolean;
  body: string;
  created_at: string;
  read_at: string | null;
  attachment?: Attachment | null;
  // Flagged by the team: waiting for an answer (cleared by the next reply).
  needs_reply?: boolean;
  // The message this one answers (20261105_message_replies.sql).
  reply_to?: string | null;
};

export type InboxEntry = {
  client_id: string;
  business_name: string;
  client_number: number;
  last_body: string | null;
  last_at: string | null;
  last_from_staff: boolean | null;
  unread: number;
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchMessages(clientId: string): Promise<Message[]> {
  const { data, error } = await client()
    .from("messages")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Message[];
}

// The database decides the sender side (staff or client) from the caller's role.
export async function sendMessage(clientId: string, body: string, attachment: Attachment | null = null, needsReply = false, replyTo: string | null = null): Promise<Message> {
  const { data, error } = replyTo
    ? await client().rpc("send_message_v3", { p_client_id: clientId, p_body: body.trim(), p_attachment: attachment, p_needs_reply: needsReply, p_reply_to: replyTo })
    : attachment || needsReply
    ? await client().rpc("send_message_v2", { p_client_id: clientId, p_body: body.trim(), p_attachment: attachment, p_needs_reply: needsReply })
    : await client().rpc("send_message", { p_client_id: clientId, p_body: body.trim() });
  if (error) throw error;
  return data as Message;
}

export async function flagMessage(messageId: string, needsReply: boolean): Promise<void> {
  const { error } = await client().rpc("staff_flag_message", { p_message_id: messageId, p_needs_reply: needsReply });
  if (error) throw error;
}

export async function markMessagesRead(clientId: string): Promise<void> {
  const { error } = await client().rpc("mark_messages_read", { p_client_id: clientId });
  if (error) throw error;
}

export async function fetchInbox(): Promise<InboxEntry[]> {
  const { data, error } = await client().rpc("staff_inbox");
  if (error) throw error;
  return (data ?? []) as InboxEntry[];
}

// Messages waiting for my answer (client conversations, team conversations, or for a client its own).
export async function countNeedingReply(): Promise<number> {
  const { data, error } = await client().rpc("messages_needing_reply");
  if (error || !data || Array.isArray(data)) return 0;
  const board = data as { clients?: { count: number }[]; team?: { count: number }[]; own?: number };
  const sum = (list?: { count: number }[]) => (list ?? []).reduce((total, item) => total + Number(item.count), 0);
  return sum(board.clients) + sum(board.team) + Number(board.own ?? 0);
}

// Unread messages from the other side: staff count client messages, clients count staff replies.
export async function countUnread(isStaff: boolean): Promise<number> {
  const { count, error } = await client()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("from_staff", !isStaff)
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}
