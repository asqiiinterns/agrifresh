import { shared } from "./shared";
import { createIsolatedClient, supabase } from "../lib/supabase";
import type { AccountStatus, Role } from "./account";

export type AdminAccount = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: AccountStatus;
  created_at: string;
  last_sign_in_at: string | null;
  client_name: string | null;
  is_self: boolean;
  // 20261126: soft delete, e-mail confirmation, who invited.
  deleted_at?: string | null;
  email_confirmed?: boolean;
  invited_by?: InvitedBy | string | null;
};

// Who invited the account (20261126: an object, not a text: shown as is, it emptied the screen).
export type InvitedBy = { name: string | null; org_name: string | null; code?: string | null; created_at?: string | null; accepted_at?: string | null };
export const invitedByLabel = (value: InvitedBy | string | null | undefined) => !value ? ""
  : typeof value === "string" ? value
  : [value.name, value.org_name ? `(${value.org_name})` : null].filter(Boolean).join(" ") || "une invitation";

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

async function loadAccounts(): Promise<AdminAccount[]> {
  const { data, error } = await client().rpc("admin_list_accounts");
  if (error) throw error;
  return (data ?? []) as AdminAccount[];
}

// Validate (active), refuse, suspend, or put back on hold (pending).
export async function setAccountStatus(userId: string, status: AccountStatus): Promise<void> {
  const { error } = await client().rpc("admin_set_account_status", { p_user_id: userId, p_status: status });
  if (error) throw error;
}

// Soft delete (restore = true brings it back, still suspended until reactivated). Admin of the space or Appro+.
export async function deleteAccount(userId: string, restore = false): Promise<void> {
  const { error } = await client().rpc("delete_account", { p_user_id: userId, p_restore: restore });
  if (error) throw error;
}

export async function setAccountRole(email: string, role: Role): Promise<void> {
  const { error } = await client().rpc("admin_set_role", { p_email: email.trim().toLowerCase(), p_role: role });
  if (error) throw error;
}

// Readable temporary password the admin can dictate or send.
export function temporaryPassword() {
  const letters = "abcdefghjkmnpqrstuvwxyz", digits = "23456789";
  const pick = (set: string) => set.charAt(Math.floor(Math.random() * set.length));
  return `Agri-${Array.from({ length: 4 }, () => pick(letters)).join("")}${Array.from({ length: 4 }, () => pick(digits)).join("")}`;
}

// Creates the account with an isolated client (the admin stays signed in), makes it active
// at once and gives it its role. A client e-mail that matches a client record is linked automatically.
// A member of the team: the account is created, then given its role (which attaches it to this Pro), then activated.
// In that order: activating an account that belongs to no team yet is refused by the database.
// An e-mail already used by an account that belongs to no team (e.g. a previous attempt that stopped half-way)
// is attached the same way instead of being refused.
export async function createAccount(input: { email: string; fullName: string; role: Exclude<Role, "customer">; password: string }): Promise<{ existing: boolean }> {
  const isolated = createIsolatedClient();
  if (!isolated) throw new Error("Supabase n’est pas configuré.");
  const email = input.email.trim().toLowerCase();
  const { data, error } = await isolated.auth.signUp({ email, password: input.password, options: { data: { full_name: input.fullName.trim() } } });
  if (error && !/already|registered|existe/i.test(error.message)) throw error;
  // Supabase answers an existing e-mail with a user that has no identity.
  const existing = !!error || !data.user || (!!data.user.identities && data.user.identities.length === 0);
  const { data: attached, error: roleError } = await client().rpc("admin_set_role", { p_email: email, p_role: input.role });
  if (roleError) throw existing ? new Error(`Un compte existe déjà avec cet e-mail et ne peut pas rejoindre votre équipe (${roleError.message})`) : roleError;
  await setAccountStatus((attached as { id: string }).id, "active");
  return { existing };
}

export const fetchAccounts = () => shared("fetchAccounts", loadAccounts);
