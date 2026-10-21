import { supabase } from "../lib/supabase";

// Directory of validated Pros and the links between them (20261113_directory.sql).
export type LinkStatus = "active" | "requested_by_supplier" | "requested_by_buyer" | "refused";
export type DirectoryPro = {
  id: string; name: string; kind: "business" | "person"; is_supplier: boolean; is_buyer: boolean;
  address: string; tagline: string; open_to_new: boolean; link: { id: string; status: LinkStatus } | null;
  // 20261120: accepts messages from outside its network; products visible to everyone or to its network.
  open_to_messages?: boolean; catalog_visibility?: CatalogVisibility;
};
export type CatalogVisibility = "network" | "public";
export type MyLink = { client_id: string; org_id: string; name: string; status: LinkStatus; to_answer: boolean };
export type MyLinks = {
  org: { id: string; name: string; is_supplier: boolean; is_buyer: boolean; open_to_new: boolean;
    listed_in_directory?: boolean; open_to_messages?: boolean; catalog_visibility?: CatalogVisibility; kind?: "business" | "person" } | null;
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

// The Responsable's choices (null keeps the current value): products seen by everyone or by the network,
// listed in the directory, messages accepted from outside the network.
export const setProVisibility = (input: { catalog?: CatalogVisibility; listed?: boolean; messages?: boolean }) =>
  call<unknown>("set_pro_visibility", { p_catalog: input.catalog ?? null, p_listed: input.listed ?? null, p_messages: input.messages ?? null });

// Messages between Pros outside their network (one conversation per pair of Pros).
export type OrgConversation = { conversation_id: string; org_id: string; name: string; kind: "business" | "person"; last_at: string; last_body: string | null; unread: number; related: boolean };
export type OrgMessage = { id: string; body: string; mine: boolean; sender_name: string | null; created_at: string; read_at: string | null };
export type OrgThread = { conversation_id: string; org: { id: string; name: string; kind: string }; messages: OrgMessage[] };
export const fetchOrgInbox = () => call<OrgConversation[]>("org_inbox");
export const fetchOrgThread = (conversationId: string) => call<OrgThread>("org_thread", { p_conversation_id: conversationId });
export const sendOrgMessage = (orgId: string, body: string) => call<string>("org_send", { p_org_id: orgId, p_body: body.trim() });

// Invitations: a code to send; the person who opens it is linked to the one who invited.
export type InvitationSide = "client" | "supplier";
export type Invitation = { code: string; org_name: string; side: InvitationSide; name: string | null; app_url: string };
export type InvitationInfo = { org_name: string; side: InvitationSide; client_name: string | null; valid: boolean } | null;
export const createInvitation = (side: InvitationSide, clientId: string | null = null, name = "", contact = "") =>
  call<Invitation>("create_invitation", { p_side: side, p_client_id: clientId, p_name: name.trim() || null, p_contact: contact.trim() || null });
export const fetchInvitationInfo = (code: string) => call<InvitationInfo>("invitation_info", { p_code: code });
export const acceptInvitation = (code: string) => call<{ linked: boolean; org_name: string; side: InvitationSide; needs_space: boolean }>("accept_invitation", { p_code: code });

// Public catalogue: the suppliers visible to everyone (not yet my suppliers) and their products.
export type PublicSupplier = { org_id: string; name: string; address: string; tagline: string; show_prices: boolean };
export type PublicProduct = { id: string; org_id: string; supplier_name: string; name: string; description: string; image_url: string | null; unit_label: string; category: string | null; price: number | string | null; vat_rate: number | string | null };
export const fetchPublicCatalog = (search = "") => call<{ suppliers: PublicSupplier[]; products: PublicProduct[] }>("public_catalog", { p_search: search.trim() || null });
export const orderFromPublic = (supplierOrgId: string, items: { product_id: string; quantity: number }[], note = "") =>
  call<{ id: string; order_number: number; status: string; new_relation: boolean; supplier_name: string }>("order_from_public", { p_supplier_org_id: supplierOrgId, p_items: items, p_requested_date: null, p_note: note.trim() || null });

// Appro+ settings everyone may read (also before signing in), and the trials that ended.
export type PublicSettings = { app_url: string; trial_hours: number };
export async function fetchPublicSettings(): Promise<PublicSettings> {
  if (!supabase) return { app_url: "", trial_hours: 0 };
  const { data, error } = await supabase.rpc("public_settings");
  return error || !data ? { app_url: "", trial_hours: 0 } : data as PublicSettings;
}
export const setPlatformSetting = (key: "new_accounts_trial_hours" | "app_url", value: number | string) => call<void>("platform_set_setting", { p_key: key, p_value: value });
export async function expireTrials(): Promise<void> {
  if (!supabase) return;
  await supabase.rpc("expire_trials");
}

// Before 20261113 there is nothing to choose from.
export async function fetchMySuppliers(): Promise<MySupplier[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("my_suppliers");
  return error ? [] : (data ?? []) as MySupplier[];
}
