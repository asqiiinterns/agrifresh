import { supabase } from "../lib/supabase";
import type { Role } from "./account";
import type { Attachment } from "./attachments";

export type TeamPerson = { id: string; name: string; role: Role };
export type TeamConversationKind = "direct" | "group" | "role" | "all";
export type TeamConversation = {
  id: string;
  kind: TeamConversationKind;
  title: string;
  target_role: Role | null;
  member_count: number;
  last_at: string;
  last_body: string | null;
  last_sender: string | null;
  last_mine: boolean | null;
  unread: number;
};
export type TeamMessage = { id: string; conversation_id: string; sender_id: string | null; sender_name: string; body: string; created_at: string; attachment?: Attachment | null; needs_reply?: boolean };

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchTeamDirectory(): Promise<TeamPerson[]> {
  const { data, error } = await client().rpc("team_directory");
  if (error) throw error;
  return (data ?? []) as TeamPerson[];
}

export async function fetchTeamConversations(): Promise<TeamConversation[]> {
  const { data, error } = await client().rpc("team_conversations_list");
  if (error) throw error;
  return (data ?? []) as TeamConversation[];
}

// direct: one person; group: several people (+ optional name); role: a whole profile; all: everyone.
export async function startTeamConversation(kind: TeamConversationKind, options: { memberIds?: string[]; role?: Role; title?: string } = {}): Promise<string> {
  const { data, error } = await client().rpc("team_start_conversation", {
    p_kind: kind,
    p_member_ids: options.memberIds ?? null,
    p_role: options.role ?? null,
    p_title: options.title?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchTeamThread(conversationId: string): Promise<{ title: string; members: string[]; messages: TeamMessage[] }> {
  const { data, error } = await client().rpc("team_messages_of", { p_conversation_id: conversationId });
  if (error) throw error;
  return data as { title: string; members: string[]; messages: TeamMessage[] };
}

export async function sendTeamMessage(conversationId: string, body: string, attachment: Attachment | null = null, needsReply = false): Promise<TeamMessage> {
  const { data, error } = attachment || needsReply
    ? await client().rpc("team_send_message_v2", { p_conversation_id: conversationId, p_body: body.trim(), p_attachment: attachment, p_needs_reply: needsReply })
    : await client().rpc("team_send_message", { p_conversation_id: conversationId, p_body: body.trim() });
  if (error) throw error;
  return data as TeamMessage;
}

export async function flagTeamMessage(messageId: string, needsReply: boolean): Promise<void> {
  const { error } = await client().rpc("team_flag_message", { p_message_id: messageId, p_needs_reply: needsReply });
  if (error) throw error;
}

export async function markTeamRead(conversationId: string): Promise<void> {
  const { error } = await client().rpc("team_mark_read", { p_conversation_id: conversationId });
  if (error) throw error;
}

export async function countTeamUnread(): Promise<number> {
  const { data, error } = await client().rpc("team_unread_count");
  if (error) return 0;
  return Number(data ?? 0);
}
