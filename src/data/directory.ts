import { supabase } from "../lib/supabase";

// Directory of validated Pros and the links between them (20261113_directory.sql).
export type LinkStatus = "active" | "requested_by_supplier" | "requested_by_buyer" | "refused";
export type DirectoryPro = {
  id: string; name: string; kind: "business" | "person"; is_supplier: boolean; is_buyer: boolean;
  address: string; tagline: string; open_to_new: boolean; link: { id: string; status: LinkStatus } | null;
};
export type MyLink = { client_id: string; org_id: string; name: string; status: LinkStatus; to_answer: boolean };
export type MyLinks = {
  org: { id: string; name: string; is_supplier: boolean; is_buyer: boolean; open_to_new: boolean } | null;
  suppliers: MyLink[];
  clients: MyLink[];
};
export type MySupplier = { client_id: string; name: string; current: boolean };

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const fetchDirectory = (lookingFor: "clients" | "suppliers", search: string) =>
  call<DirectoryPro[]>("pro_directory", { p_looking_for: lookingFor, p_search: search });
export const requestLink = (otherOrgId: string, as: "supplier" | "buyer") => call<string>("pro_link_request", { p_other_org_id: otherOrgId, p_as: as });
export const respondLink = (clientId: string, accept: boolean) => call<void>("pro_link_respond", { p_client_id: clientId, p_accept: accept });
export const fetchMyLinks = () => call<MyLinks>("my_links");
export const setOpenToNew = (open: boolean) => call<void>("set_open_to_new", { p_open: open });
export const switchSupplier = (clientId: string) => call<void>("switch_supplier", { p_client_id: clientId });

// Before 20261113 there is nothing to choose from.
export async function fetchMySuppliers(): Promise<MySupplier[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("my_suppliers");
  return error ? [] : (data ?? []) as MySupplier[];
}
