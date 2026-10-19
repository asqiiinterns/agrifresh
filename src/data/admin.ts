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
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchAccounts(): Promise<AdminAccount[]> {
  const { data, error } = await client().rpc("admin_list_accounts");
  if (error) throw error;
  return (data ?? []) as AdminAccount[];
}

// Validate (active), refuse, suspend, or put back on hold (pending).
export async function setAccountStatus(userId: string, status: AccountStatus): Promise<void> {
  const { error } = await client().rpc("admin_set_account_status", { p_user_id: userId, p_status: status });
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
export async function createAccount(input: { email: string; fullName: string; role: Role; password: string }): Promise<void> {
  const isolated = createIsolatedClient();
  if (!isolated) throw new Error("Supabase n’est pas configuré.");
  const email = input.email.trim().toLowerCase();
  const { data, error } = await isolated.auth.signUp({ email, password: input.password, options: { data: { full_name: input.fullName.trim() } } });
  if (error) throw error;
  // Supabase answers an existing e-mail with a user that has no identity.
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    throw new Error("Un compte existe déjà avec cet e-mail : retrouvez-le dans la liste.");
  }
  await setAccountStatus(data.user.id, "active");
  if (input.role !== "customer") await setAccountRole(email, input.role);
}
