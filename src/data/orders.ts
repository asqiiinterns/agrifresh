import { supabase } from "../lib/supabase";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

export type OrderLine = {
  product_id: string | null;
  product_name_snapshot: string;
  quantity: number | string;
  unit_snapshot: string;
  unit_price: number | string;
  line_total: number | string;
};

export type InvoiceRecord = {
  invoice_number: string;
  issued_at: string;
  subtotal: number | string;
  tax_total: number | string;
  delivery_fee: number | string;
  total: number | string;
  currency: string;
};

export type Order = {
  id: string;
  order_number: number;
  status: string;
  status_note: string | null;
  total: number | string;
  currency: string;
  created_at: string;
  requested_delivery_date: string | null;
  delivered_at: string | null;
  customer_note: string | null;
  client_id: string | null;
  delivery_point_id: string | null;
  address_snapshot: {
    business_name?: string;
    recipient_name?: string;
    phone?: string;
    point_label?: string;
    address_line?: string;
    city?: string;
    notes?: string | null;
  };
  invoices: InvoiceRecord | InvoiceRecord[] | null;
  order_items: OrderLine[];
};

export const ORDER_FIELDS = "id, order_number, status, status_note, total, currency, created_at, requested_delivery_date, delivered_at, customer_note, client_id, delivery_point_id, address_snapshot, order_items(product_id, product_name_snapshot, quantity, unit_snapshot, unit_price, line_total), invoices(invoice_number, issued_at, subtotal, tax_total, delivery_fee, total, currency)";

export type OrderDraftLine = { product_id: string; quantity: number };

export async function placeClientOrder(params: {
  items: OrderDraftLine[];
  deliveryPointId: string | null;
  requestedDate: string | null;
  note: string;
}): Promise<{ id: string; order_number: number; total: number }> {
  if (!supabase) throw new Error("La connexion au service de commande n’est pas configurée.");
  const { data, error } = await supabase.rpc("place_client_order", {
    p_items: params.items,
    p_delivery_point_id: params.deliveryPointId,
    p_requested_date: params.requestedDate,
    p_note: params.note.trim() || null,
  });
  if (error) throw error;
  return data as { id: string; order_number: number; total: number };
}

// RLS limits customers to their own orders.
export async function fetchMyOrders(): Promise<Order[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_FIELDS)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as Order[];
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character] ?? character));

const formatInvoiceAmount = (amount: number | string) =>
  `${new Intl.NumberFormat("fr-TN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(amount))} TND`;

export async function shareOrderReceipt(order: Order): Promise<void> {
  const rawInvoice = Array.isArray(order.invoices) ? order.invoices[0] : order.invoices;
  const invoiceNumber = rawInvoice?.invoice_number ?? `AF-${order.order_number}`;
  const invoiceDate = rawInvoice?.issued_at ?? order.created_at;
  const address = order.address_snapshot ?? {};
  const lines = order.order_items.map((line) => `
    <tr>
      <td>${escapeHtml(line.product_name_snapshot)}</td>
      <td class="number">${escapeHtml(String(Number(line.quantity)))}</td>
      <td>${escapeHtml(line.unit_snapshot)}</td>
      <td class="number">${formatInvoiceAmount(line.unit_price)}</td>
      <td class="number">${formatInvoiceAmount(line.line_total)}</td>
    </tr>`).join("");

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
    <style>
      body{font-family:Arial,sans-serif;color:#24372c;padding:32px;max-width:780px;margin:auto}
      h1{color:#24543b;margin-bottom:4px} .muted{color:#737b71;font-size:12px}
      .top{display:flex;justify-content:space-between;border-bottom:2px solid #24543b;padding-bottom:18px}
      table{width:100%;border-collapse:collapse;margin-top:28px} th,td{padding:11px 8px;border-bottom:1px solid #e8e7df;text-align:left;font-size:12px}
      th{color:#24543b;background:#f6f1e7}.number{text-align:right;white-space:nowrap}
      .total{margin:24px 0 0 auto;width:260px}.row{display:flex;justify-content:space-between;padding:6px 0}
      .grand{border-top:2px solid #24543b;color:#24543b;font-weight:bold;font-size:17px;padding-top:12px}
      .note{margin-top:35px;padding:14px;background:#f6f1e7;border-radius:8px;font-size:11px;line-height:1.6}
    </style></head><body>
      <div class="top"><div><h1>AgriFresh</h1><div class="muted">Le goût du naturel</div></div><div><strong>BON DE COMMANDE</strong><br/><span class="muted">${escapeHtml(invoiceNumber)} · ${new Date(invoiceDate).toLocaleDateString("fr-TN")}</span></div></div>
      <h3>Livraison à</h3>
      <div><strong>${escapeHtml(address.business_name ?? address.recipient_name ?? "")}</strong>${address.point_label ? ` · ${escapeHtml(address.point_label)}` : ""}</div>
      <div>${escapeHtml(address.address_line ?? "")}, ${escapeHtml(address.city ?? "")}</div>
      <div>${escapeHtml(address.phone ?? "")}</div>
      ${order.requested_delivery_date ? `<div class="muted">Livraison souhaitée : ${new Date(`${order.requested_delivery_date}T12:00:00`).toLocaleDateString("fr-TN")}</div>` : ""}
      <table><thead><tr><th>Produit</th><th class="number">Qté</th><th>Unité</th><th class="number">Prix unitaire</th><th class="number">Montant</th></tr></thead><tbody>${lines}</tbody></table>
      <div class="total"><div class="row"><span>Sous-total</span><span>${formatInvoiceAmount(rawInvoice?.subtotal ?? order.total)}</span></div><div class="row"><span>Livraison</span><span>${formatInvoiceAmount(rawInvoice?.delivery_fee ?? 0)}</span></div><div class="row"><span>Taxes</span><span>${formatInvoiceAmount(rawInvoice?.tax_total ?? 0)}</span></div><div class="row grand"><span>Total</span><span>${formatInvoiceAmount(rawInvoice?.total ?? order.total)}</span></div></div>
      <div class="note">Document récapitulatif de commande. Ce document est informatif et ne constitue pas une facture fiscale.</div>
    </body></html>`;

  if (Platform.OS === "web") {
    // Browser print dialog lets the user save the document as a PDF.
    await Print.printAsync({ html });
    return;
  }

  if (!(await Sharing.isAvailableAsync())) throw new Error("Le partage de fichiers PDF n’est pas disponible sur cet appareil.");
  // expo-print writes outside the app's readable folders in Expo Go, so Sharing refuses
  // its file; write the PDF ourselves into the app cache under a readable name instead.
  const { base64 } = await Print.printToFileAsync({ html, base64: true });
  if (!base64) throw new Error("Le PDF n’a pas pu être généré.");
  const file = new File(Paths.cache, `bon-commande-${order.order_number}.pdf`);
  file.write(base64, { encoding: "base64" });
  await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: `Commande ${invoiceNumber}`, UTI: "com.adobe.pdf" });
}
