import { company } from "../config/company";
import { brandColor } from "./pdf";
import { Platform, Share } from "react-native";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "./account";
import { escapeHtml, outputPdf } from "./pdf";
import { QR, qrSvg } from "../ui/Qr";
import type { ClientOptionKey } from "./permissions";

export type DeliveryPoint = {
  id: string;
  client_id: string;
  label: string;
  address_line: string;
  city: string;
  phone: string;
  instructions: string | null;
  qr_token: string;
  active: boolean;
};

export type ClientRecord = {
  id: string;
  client_number: number;
  business_name: string;
  contact_name: string;
  email: string | null;
  phone: string;
  notes: string | null;
  tax_id: string | null;
  active: boolean;
  show_prices: boolean;
  show_origin: boolean;
  show_stock: boolean;
  stock_managed: boolean;
  invoice_mode: "auto" | "manual";
  reception_qr: boolean;
  history_enabled: boolean;
  reconfirm_declined: boolean;
  scan_delivery_note: boolean;
  scan_client_qr: boolean;
  // Options set apart from the "all clients" default, and client tabs switched on/off for this client.
  payment_reminders: boolean;
  delivery_signature: boolean;
  reminder_opt_out_allowed: boolean;
  reminder_opt_out: boolean;
  // Billing frequency and payment terms (20261031_billing_decisions.sql).
  payment_terms_days: number;
  reminder_interval_days: number;
  billing_frequency: "manual" | "every_n_days" | "monthly_day";
  billing_every_days: number;
  billing_start: string | null;
  billing_month_day: number;
  custom_settings: ClientOptionKey[];
  feature_overrides: Record<string, boolean>;
  client_delivery_points: DeliveryPoint[];
  has_account: boolean;
};

export type BillingSettings = Pick<ClientRecord, "payment_terms_days" | "reminder_interval_days" | "billing_frequency" | "billing_every_days" | "billing_start" | "billing_month_day">;
export type ClientOptions = Pick<ClientRecord, ClientOptionKey | "custom_settings" | "feature_overrides"> & BillingSettings;
export type ClientInput = Pick<ClientRecord, "business_name" | "contact_name" | "phone" | "notes"> & Partial<ClientOptions> & { email: string; tax_id: string };
export type DeliveryPointInput = Pick<DeliveryPoint, "label" | "address_line" | "city" | "phone" | "instructions">;

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchClients(): Promise<ClientRecord[]> {
  const { data, error } = await client()
    .from("clients")
    .select("id, client_number, business_name, contact_name, email, phone, notes, tax_id, active, show_prices, show_origin, show_stock, stock_managed, invoice_mode, reception_qr, history_enabled, reconfirm_declined, scan_delivery_note, scan_client_qr, payment_reminders, delivery_signature, reminder_opt_out_allowed, reminder_opt_out, payment_terms_days, reminder_interval_days, billing_frequency, billing_every_days, billing_start, billing_month_day, custom_settings, feature_overrides, client_delivery_points(id, client_id, label, address_line, city, phone, instructions, qr_token, active, created_at), profiles(id)")
    .order("business_name");
  if (error) throw error;
  type Row = Omit<ClientRecord, "has_account"> & {
    client_delivery_points: (DeliveryPoint & { created_at: string })[];
    // profiles.client_id is unique, so PostgREST embeds a single object (or null), not an array.
    profiles: { id: string } | { id: string }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map(({ profiles, ...record }) => ({
    ...record,
    has_account: Array.isArray(profiles) ? profiles.length > 0 : Boolean(profiles),
    client_delivery_points: [...record.client_delivery_points].sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

const clean = (input: ClientInput) => ({
  business_name: input.business_name.trim(),
  contact_name: input.contact_name.trim(),
  email: input.email.trim().toLowerCase() || null,
  phone: input.phone.trim(),
  notes: input.notes?.trim() || null,
  tax_id: input.tax_id.trim() || null,
  // Options are only sent when edited; the database applies the defaults to the others.
  ...Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined
    && !["business_name", "contact_name", "email", "phone", "notes", "tax_id"].includes(key))),
});

export async function updateClientOptions(id: string, options: Partial<ClientOptions>): Promise<void> {
  const { error } = await client().from("clients").update({ ...options, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function createClient(input: ClientInput, firstPoint: DeliveryPointInput): Promise<string> {
  const { data, error } = await client().from("clients").insert(clean(input)).select("id").single();
  if (error) throw error;
  await saveDeliveryPoint(data.id, null, firstPoint);
  return data.id;
}

export async function updateClient(id: string, input: ClientInput & { active: boolean }): Promise<void> {
  const { error } = await client().from("clients").update({ ...clean(input), active: input.active, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function saveDeliveryPoint(clientId: string, pointId: string | null, input: DeliveryPointInput): Promise<void> {
  const values = {
    label: input.label.trim() || "Principal",
    address_line: input.address_line.trim(),
    city: input.city.trim(),
    phone: input.phone.trim(),
    instructions: input.instructions?.trim() || null,
  };
  const query = pointId
    ? client().from("client_delivery_points").update(values).eq("id", pointId)
    : client().from("client_delivery_points").insert({ ...values, client_id: clientId });
  const { error } = await query;
  if (error) throw error;
}

export async function setDeliveryPointActive(pointId: string, active: boolean): Promise<void> {
  const { error } = await client().from("client_delivery_points").update({ active }).eq("id", pointId);
  if (error) throw error;
}

// Printable sticker to put on the wall at the delivery point.
export async function printDeliveryPointQr(record: ClientRecord, points: DeliveryPoint[]): Promise<void> {
  const sheets = points.map((point) => {
    const svg = qrSvg(QR.point(point.qr_token), 8);
    return `<section class="sheet">
      <div class="brand">${escapeHtml(company.name || "Appro+")}</div>
      <div class="client">${escapeHtml(record.business_name)}</div>
      <div class="point">${escapeHtml(point.label)} · ${escapeHtml(formatClientNumber(record.client_number))}</div>
      <div class="qr">${svg}</div>
      <div class="address">${escapeHtml(point.address_line)}, ${escapeHtml(point.city)}</div>
      <div class="hint">Livreur : scannez ce code avec l’application Appro+ à chaque livraison.</div>
    </section>`;
  }).join("");

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><style>
    @page{margin:12mm} body{font-family:Arial,sans-serif;color:#1d2939;margin:0}
    .sheet{page-break-after:always;text-align:center;padding:24px;border:3px solid ${brandColor()};border-radius:18px;max-width:520px;margin:0 auto 24px}
    .sheet:last-child{page-break-after:auto}
    .brand{color:${brandColor()};font-weight:bold;font-size:28px;letter-spacing:1px}
    .client{font-size:24px;font-weight:bold;margin-top:14px}.point{color:#667085;font-size:15px;margin-top:6px}
    .qr{width:320px;height:320px;margin:20px auto}.qr svg{width:100%;height:100%}
    .address{font-size:14px}.hint{margin-top:14px;font-size:12px;color:#667085}
  </style></head><body>${sheets}</body></html>`;

  await outputPdf(html, `QR-${record.business_name}-${points.length > 1 ? "points" : points[0].label}`, `QR codes · ${record.business_name}`);
}

export async function shareInvitation(record: ClientRecord): Promise<"shared" | "copied"> {
  const link = Platform.OS === "web" && typeof window !== "undefined" ? `\n${window.location.origin}` : "";
  const message = `Bonjour ${record.contact_name || record.business_name},\n\nVotre accès sur Appro+ est prêt. Ouvrez l’application Appro+${link ? ` (${link.trim()})` : ""}, touchez « Créer mon compte » et utilisez l’adresse e-mail ${record.email ?? ""} pour choisir votre mot de passe.\n\nDès que nous aurons validé votre compte, vous pourrez passer vos commandes directement.${company.name ? `\n\n${company.name}` : ""}`;
  if (Platform.OS === "web" && typeof navigator !== "undefined" && typeof navigator.share !== "function") {
    await navigator.clipboard.writeText(message);
    return "copied";
  }
  await Share.share({ message, title: "Invitation Appro+" });
  return "shared";
}
