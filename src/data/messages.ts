import { supabase } from "../lib/supabase";

export type Message = {
  id: string;
  client_id: string;
  from_staff: boolean;
  body: string;
  created_at: string;
  read_at: string | null;
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
    .select("id, client_id, from_staff, body, created_at, read_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Message[];
}

// The database decides the sender side (staff or client) from the caller's role.
export async function sendMessage(clientId: string, body: string): Promise<Message> {
  const { data, error } = await client().rpc("send_message", { p_client_id: clientId, p_body: body.trim() });
  if (error) throw error;
  return data as Message;
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
