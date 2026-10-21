import { supabase } from "../lib/supabase";

export type Role = "customer" | "staff" | "admin" | "supervisor" | "production" | "driver" | "platform";

export const roleLabels: Record<Role, string> = {
  customer: "Client",
  staff: "Superviseur",
  supervisor: "Superviseur",
  admin: "Administrateur",
  production: "Production",
  driver: "Livreur",
  platform: "Équipe Appro+",
};

export const isManager = (role: Role | undefined) => role === "admin" || role === "supervisor" || role === "staff";

export type DeliveryPointSummary = {
  id: string;
  label: string;
  address_line: string;
  city: string;
};

export type ClientSummary = {
  id: string;
  client_number: number;
  business_name: string;
  contact_name: string;
  phone: string;
  show_prices: boolean;
  show_origin: boolean;
  show_stock: boolean;
  stock_managed: boolean;
  reception_qr: boolean;
  reception_token: string | null;
  // Off: finished orders and order timelines are hidden from the client.
  history_enabled?: boolean;
  // 20261121: false when the supplier keeps its delivery notes for itself.
  delivery_note?: boolean;
  delivery_points: DeliveryPointSummary[];
};

export type AccountStatus = "pending" | "active" | "refused" | "suspended";

// Home screen: figures (tiles) and shortcuts, in display order.
export type HomeLayout = { tiles: string[]; shortcuts: string[] };

export type Account = {
  id?: string;
  role: Role;
  full_name: string;
  // Features enabled for this account (see role_permissions); admins get all of them.
  features: string[];
  disabled?: boolean;
  // Decided by the admin: a new sign-up stays pending until validated.
  status?: AccountStatus;
  client: ClientSummary | null;
  // The user's own layout, else the one set by the admin for the role (null = built-in default).
  home_layout?: HomeLayout | null;
  role_home_layout?: HomeLayout | null;
  // 20261124: functions not allowed but shown locked; Appro+ assisting a Pro.
  locked_features?: string[];
  // 20261201: the bottom bar chosen for the person's role (null: the built-in order).
  menu?: { bar: string[] } | null;
  assisting?: { org_id: string; org_name: string; can_edit: boolean; expires_at: string; reason: string | null } | null;
};

export async function fetchMyAccount(): Promise<Account> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase.rpc("my_account");
  if (error) throw error;
  if (!data) throw new Error("Profil introuvable. Déconnectez-vous puis reconnectez-vous.");
  const account = data as Account;
  // Databases without the permissions migration return no feature list.
  return { ...account, features: Array.isArray(account.features) ? account.features : [] };
}

export async function setMyHomeLayout(layout: HomeLayout | null): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("set_my_home_layout", { p_layout: layout });
  if (error) throw error;
}

export async function setRoleHomeLayout(role: Role, layout: HomeLayout | null): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("admin_set_home_layout", { p_role: role, p_layout: layout });
  if (error) throw error;
}

export const formatClientNumber = (value: number) => `CL-${String(value).padStart(4, "0")}`;

export async function fetchRoleHomeLayouts(): Promise<Partial<Record<Role, HomeLayout>>> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase.from("home_layouts").select("role, layout");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row: { role: Role; layout: HomeLayout }) => [row.role, row.layout]));
}
