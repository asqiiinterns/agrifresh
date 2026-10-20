import { supabase } from "../lib/supabase";
import { applyCompanyProfile, company, type CompanyProfile } from "../config/company";

type Row = { name: string; tagline: string; address: string; phone: string; email: string; tax_id: string; rib: string; brand_color: string };

const fromRow = (row: Row): CompanyProfile => ({
  name: row.name, tagline: row.tagline, address: row.address, phone: row.phone, email: row.email,
  taxId: row.tax_id, rib: row.rib, brandColor: row.brand_color,
});

// Read by everyone (printed on documents); best effort before 20261106_appro_plus.sql.
// The supplier the person acts for (its own Pro, or a client's supplier); before 20261111 the
// single company_profile row.
export async function loadCompanyProfile(): Promise<CompanyProfile> {
  if (!supabase) return company;
  const mine = await supabase.rpc("my_company_profile");
  if (!mine.error && mine.data) {
    applyCompanyProfile(fromRow(mine.data as Row));
    return { ...company };
  }
  const { data } = await supabase.from("company_profile").select("*").eq("id", 1).maybeSingle();
  if (data) applyCompanyProfile(fromRow(data as Row));
  return { ...company };
}

export async function saveCompanyProfile(profile: CompanyProfile): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("set_company_profile", { p_profile: {
    name: profile.name, tagline: profile.tagline, address: profile.address, phone: profile.phone, email: profile.email,
    tax_id: profile.taxId, rib: profile.rib, brand_color: profile.brandColor,
  } });
  if (error) throw error;
  applyCompanyProfile(profile);
}
