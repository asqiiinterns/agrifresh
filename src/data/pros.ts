import { supabase } from "../lib/supabase";

// Pros (businesses or private persons): self-service creation, Appro+ management, roles.
export type ProKind = "business" | "person";
export type MyPro = { id: string; name: string; status: "pending" | "active" | "suspended" | "refused"; is_supplier: boolean; is_buyer: boolean; roles_delegated: boolean;
  // 20261120: end of the trial (until Appro+ validates the Pro), kind of space.
  trial_until?: string | null; kind?: ProKind };
export type ProCard = {
  id: string; name: string; kind: ProKind; status: MyPro["status"]; is_supplier: boolean; is_buyer: boolean; roles_delegated: boolean; legacy: boolean;
  tagline: string; address: string; phone: string; email: string; tax_id: string; rib: string; owner_email: string | null; created_at: string;
  members: { id: string; email: string; full_name: string | null; status: string; role: string }[];
  clients: number; suppliers: number; products: number;
};
export type ProInput = {
  name: string; kind: ProKind; is_supplier: boolean; is_buyer: boolean; roles_delegated?: boolean;
  tagline?: string; address?: string; phone?: string; email?: string; tax_id?: string; rib?: string; owner_email?: string;
};

export type RolePermission = { key: string; side: "supplier" | "buyer"; module: string | null };
export type OrgRole = {
  id: string; name: string; side: "supplier" | "buyer"; template: string | null; template_key: string | null;
  granted: string[]; overrides: Record<string, boolean>; members: number;
};
export type OrgMember = { id: string; email: string; full_name: string | null; status: string; roles: string[] };
export type RolesMatrix = {
  org: { id: string; name: string; is_supplier: boolean; is_buyer: boolean; roles_delegated: boolean };
  can_edit: boolean; permissions: RolePermission[]; roles: OrgRole[]; members: OrgMember[];
};
export type RoleTemplate = { key: string; name: string; side: "supplier" | "buyer"; description: string; granted: string[]; roles: number };
export type PlatformAccount = {
  id: string; email: string; full_name: string; role: string | null; status: string | null; org_id: string | null; org_name: string | null;
  org_kind: ProKind | null; created_at: string; last_sign_in_at: string | null;
  deleted_at?: string | null; email_confirmed?: boolean; invited_by?: string | null;
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw error;
  return data as T;
}

// Before 20261112 there is no Pro to read: null.
export async function fetchMyPro(): Promise<MyPro | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("my_pro");
  return error ? null : (data as MyPro | null);
}
export const registerPro = (input: { name: string; kind?: ProKind; is_supplier: boolean; is_buyer: boolean; phone?: string; address?: string; tax_id?: string }) =>
  call<string>("register_pro", { p_profile: input });

export const fetchProCard = (orgId: string) => call<ProCard>("platform_pro", { p_org_id: orgId });
export const saveProAsPlatform = (orgId: string | null, input: ProInput) => call<string>("platform_save_pro", { p_org_id: orgId, p_profile: input });

export const fetchRolesMatrix = (orgId?: string | null) => call<RolesMatrix>("org_roles_matrix", { p_org_id: orgId ?? null });

// Home and bottom bar per role (20261201). allowed: the Pro's plan includes « Accueil personnalisable » (or Appro+).
export type RoleLayout = { role_id: string; home: { tiles: string[]; shortcuts: string[] } | null; menu: { bar: string[] } | null };
export const fetchRoleLayouts = (orgId?: string | null) => call<{ allowed: boolean; layouts: RoleLayout[] }>("org_role_layouts_list", { p_org_id: orgId ?? null });
export const setRoleLayout = (roleId: string, home: RoleLayout["home"], menu: RoleLayout["menu"]) =>
  call<void>("set_org_role_layout", { p_role_id: roleId, p_home: home, p_menu: menu });
export const setRolePermission = (roleId: string, permission: string, allowed: boolean | null) =>
  call<void>("org_set_role_permission", { p_role_id: roleId, p_permission: permission, p_allowed: allowed });
export const createRole = (orgId: string | null, name: string, side: "supplier" | "buyer", fromRole: string | null) =>
  call<string>("org_create_role", { p_org_id: orgId, p_name: name, p_side: side, p_from_role: fromRole });
export const setMemberRole = (userId: string, roleId: string, enabled: boolean) =>
  call<void>("org_set_member_role", { p_user_id: userId, p_role_id: roleId, p_enabled: enabled, p_valid_until: null });
export const fetchMemberPermissions = (userId: string) => call<string[]>("org_member_permissions", { p_user_id: userId });

export const fetchTemplates = () => call<{ permissions: RolePermission[]; templates: RoleTemplate[] }>("platform_templates");
export const setTemplatePermission = (templateKey: string, permission: string, allowed: boolean) =>
  call<void>("platform_set_template_permission", { p_template_key: templateKey, p_permission: permission, p_allowed: allowed });

export const fetchPlatformAccounts = (search: string) => call<PlatformAccount[]>("platform_accounts", { p_search: search });
export const setPlatformAccountStatus = (userId: string, status: string) => call<void>("platform_set_account_status", { p_user_id: userId, p_status: status });

// Rights in cascade (20261124): catalogue of functions, hidden or locked display, Appro+ assisting a Pro.
export type CatalogueFunction = { key: string; side: "supplier" | "buyer"; area: string; kind: "read" | "write"; label: string; sort: number; module: string | null;
  display: "hidden" | "locked"; display_default: "hidden" | "locked"; display_own: "hidden" | "locked" | null };
export const fetchRightsCatalogue = (orgId?: string | null) => call<CatalogueFunction[]>("rights_catalogue", { p_org_id: orgId ?? null });
export const setFeatureDisplay = (orgId: string | null, permission: string, display: "hidden" | "locked" | null) =>
  call<void>("platform_set_feature_display", { p_org_id: orgId, p_permission: permission, p_display: display });
export type MemberRights = { id: string; name: string; email: string; status: string; side: "supplier" | "buyer"; granted: string[]; overrides: Record<string, boolean>
  // 20261129: the Responsable (set by Appro+ only) and the person itself are not editable here.
  owner?: boolean; is_self?: boolean;
};
export const fetchMembersRights = (orgId?: string | null) => call<MemberRights[]>("org_members_rights", { p_org_id: orgId ?? null });
export const setMemberPermission = (userId: string, permission: string, allowed: boolean | null) =>
  call<void>("org_set_member_permission", { p_user_id: userId, p_permission: permission, p_allowed: allowed });
export type Assisting = { org_id: string; org_name: string; can_edit: boolean; expires_at: string; reason: string | null };
export const startAssist = (orgId: string, canEdit: boolean, reason: string) =>
  call<{ org_id: string; org_name: string; can_edit: boolean }>("platform_start_assist", { p_org_id: orgId, p_edit: canEdit, p_reason: reason.trim() || null, p_hours: 2 });
export const stopAssist = () => call<void>("platform_stop_assist");
// Starting or ending an assistance reloads the whole account (menus, rights, space).
const assistListeners = new Set<() => void>();
export const onAssistChanged = (listener: () => void) => { assistListeners.add(listener); return () => { assistListeners.delete(listener); }; };
export const assistChanged = () => assistListeners.forEach((listener) => listener());

// Spaces: one account may work in several Pros, as a supplier or a buyer (20261113).
export type Space = { org_id: string; org_name: string; mode: "supplier" | "buyer"; status: string; current: boolean };
export async function fetchMySpaces(): Promise<Space[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("my_spaces");
  return error ? [] : (data ?? []) as Space[];
}
export const switchSpace = (orgId: string, mode: "supplier" | "buyer") => call<void>("switch_space", { p_org_id: orgId, p_mode: mode });
export const addMember = (email: string, roleId: string) => call<string>("org_add_member", { p_email: email.trim(), p_role_id: roleId });
export const removeMember = (userId: string) => call<void>("org_remove_member", { p_user_id: userId });
