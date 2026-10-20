// The seller's details printed on its own documents. Entered by the administrator in
// Paramétrage → Entreprise (company_profile), loaded at sign-in; empty until then.
export const company = {
  name: "",
  tagline: "",
  address: "",
  phone: "",
  email: "",
  taxId: "",
  rib: "",
  brandColor: "",
};

export type CompanyProfile = typeof company;

export function applyCompanyProfile(profile: Partial<CompanyProfile>) {
  Object.assign(company, profile);
}
