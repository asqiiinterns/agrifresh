import * as Print from "expo-print";
import qrcode from "qrcode-generator";
import { Platform, Share } from "react-native";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "./account";

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
  active: boolean;
  client_delivery_points: DeliveryPoint[];
  has_account: boolean;
};

export type ClientInput = Pick<ClientRecord, "business_name" | "contact_name" | "phone" | "notes"> & { email: string };
export type DeliveryPointInput = Pick<DeliveryPoint, "label" | "address_line" | "city" | "phone" | "instructions">;

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchClients(): Promise<ClientRecord[]> {
  const { data, error } = await client()
    .from("clients")
    .select("id, client_number, business_name, contact_name, email, phone, notes, active, client_delivery_points(id, client_id, label, address_line, city, phone, instructions, qr_token, active, created_at), profiles(id)")
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
});

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

export const QR_PREFIX = "agrifresh:point:";

export function parseDeliveryQr(data: string): string | null {
  const match = data.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character] ?? character));

// Printable sticker to put on the wall at the delivery point.
export async function printDeliveryPointQr(record: ClientRecord, points: DeliveryPoint[]): Promise<void> {
  const sheets = points.map((point) => {
    const qr = qrcode(0, "M");
    qr.addData(`${QR_PREFIX}${point.qr_token}`);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    return `<section class="sheet">
      <div class="brand">AgriFresh</div>
      <div class="client">${escapeHtml(record.business_name)}</div>
      <div class="point">${escapeHtml(point.label)} · ${escapeHtml(formatClientNumber(record.client_number))}</div>
      <div class="qr">${svg}</div>
      <div class="address">${escapeHtml(point.address_line)}, ${escapeHtml(point.city)}</div>
      <div class="hint">Livreur : scannez ce code avec l’application AgriFresh à chaque livraison.</div>
    </section>`;
  }).join("");

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><style>
    @page{margin:12mm} body{font-family:Arial,sans-serif;color:#24372c;margin:0}
    .sheet{page-break-after:always;text-align:center;padding:24px;border:3px solid #24543b;border-radius:18px;max-width:520px;margin:0 auto 24px}
    .sheet:last-child{page-break-after:auto}
    .brand{color:#24543b;font-weight:bold;font-size:28px;letter-spacing:1px}
    .client{font-size:24px;font-weight:bold;margin-top:14px}.point{color:#737b71;font-size:15px;margin-top:6px}
    .qr{width:320px;height:320px;margin:20px auto}.qr svg{width:100%;height:100%}
    .address{font-size:14px}.hint{margin-top:14px;font-size:12px;color:#737b71}
  </style></head><body>${sheets}</body></html>`;

  await Print.printAsync({ html });
}

export async function shareInvitation(record: ClientRecord): Promise<"shared" | "copied"> {
  const link = Platform.OS === "web" && typeof window !== "undefined" ? `\n${window.location.origin}` : "";
  const message = `Bonjour ${record.contact_name || record.business_name},\n\nVotre accès AgriFresh est prêt. Ouvrez l’application AgriFresh${link ? ` (${link.trim()})` : ""}, touchez « Activer mon accès » et utilisez l’adresse e-mail ${record.email ?? ""} pour choisir votre mot de passe.\n\nVous pourrez ensuite passer vos commandes directement.\n\nL’équipe AgriFresh`;
  if (Platform.OS === "web" && typeof navigator !== "undefined" && typeof navigator.share !== "function") {
    await navigator.clipboard.writeText(message);
    return "copied";
  }
  await Share.share({ message, title: "Invitation AgriFresh" });
  return "shared";
}
