import { supabase } from "../lib/supabase";

export type Role = "customer" | "staff" | "admin" | "supervisor" | "production" | "driver";

export const roleLabels: Record<Role, string> = {
  customer: "Client",
  staff: "Superviseur",
  supervisor: "Superviseur",
  admin: "Administrateur",
  production: "Production",
  driver: "Livreur",
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
  delivery_points: DeliveryPointSummary[];
};

export type Account = {
  role: Role;
  full_name: string;
  client: ClientSummary | null;
};

export async function fetchMyAccount(): Promise<Account> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase.rpc("my_account");
  if (error) throw error;
  if (!data) throw new Error("Profil introuvable. Déconnectez-vous puis reconnectez-vous.");
  return data as Account;
}

export const formatClientNumber = (value: number) => `CL-${String(value).padStart(4, "0")}`;
