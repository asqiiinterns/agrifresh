import { supabase } from "../lib/supabase";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { CartLine } from "../types/order";

export type DeliveryAddress = {
  recipient_name: string;
  phone: string;
  address_line: string;
  city: string;
  notes?: string;
};

export type PlacedOrder = {
  id: string;
  order_number: number;
  subtotal: number;
  delivery_fee: number;
  total: number;
  currency: string;
  status: string;
  payment_method: string;
};

export type CustomerOrder = {
  id: string;
  order_number: number;
  status: string;
  total: number | string;
  currency: string;
  created_at: string;
  customer_note: string | null;
  address_snapshot: {
    recipient_name?: string;
    phone?: string;
    address_line?: string;
    city?: string;
  };
  invoices: InvoiceRecord | InvoiceRecord[] | null;
  order_items: {
    product_name_snapshot: string;
    quantity: number | string;
    unit_snapshot: string;
    line_total: number | string;
  }[];
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

export async function placeCustomerOrder(
  cart: CartLine[],
  address: DeliveryAddress,
  customerNote = ""
): Promise<PlacedOrder> {
  if (!supabase) throw new Error("La connexion au service de commande n’est pas configurée.");

  const { data, error } = await supabase.rpc("place_customer_order", {
    p_items: cart.map(({ product, quantity }) => ({ product_id: product.id, quantity })),
    p_address: address,
    p_customer_note: customerNote.trim() || null,
  });

  if (error) throw error;
  return data as PlacedOrder;
}

export async function fetchCustomerOrders(): Promise<CustomerOrder[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");

  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, total, currency, created_at, customer_note, address_snapshot, order_items(product_name_snapshot, quantity, unit_snapshot, line_total), invoices(invoice_number, issued_at, subtotal, tax_total, delivery_fee, total, currency)")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as CustomerOrder[];
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

export async function shareOrderInvoice(order: CustomerOrder): Promise<void> {
  const rawInvoice = Array.isArray(order.invoices) ? order.invoices[0] : order.invoices;
  const invoiceNumber = rawInvoice?.invoice_number ?? `AF-${order.order_number}`;
  const invoiceDate = rawInvoice?.issued_at ?? order.created_at;
  const address = order.address_snapshot ?? {};
  const lines = order.order_items.map((line) => `
    <tr>
      <td>${escapeHtml(line.product_name_snapshot)}</td>
      <td class="number">${escapeHtml(String(line.quantity))}</td>
      <td>${escapeHtml(line.unit_snapshot)}</td>
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
      <div class="top"><div><h1>AgriFresh</h1><div class="muted">Le goût du naturel</div></div><div><strong>REÇU DE COMMANDE</strong><br/><span class="muted">${escapeHtml(invoiceNumber)} · ${new Date(invoiceDate).toLocaleDateString("fr-TN")}</span></div></div>
      <h3>Livraison à</h3><div>${escapeHtml(address.recipient_name ?? "")}</div><div>${escapeHtml(address.address_line ?? "")}, ${escapeHtml(address.city ?? "")}</div><div>${escapeHtml(address.phone ?? "")}</div>
      <table><thead><tr><th>Produit</th><th class="number">Qté</th><th>Unité</th><th class="number">Montant</th></tr></thead><tbody>${lines}</tbody></table>
      <div class="total"><div class="row"><span>Sous-total</span><span>${formatInvoiceAmount(rawInvoice?.subtotal ?? order.total)}</span></div><div class="row"><span>Livraison</span><span>${formatInvoiceAmount(rawInvoice?.delivery_fee ?? 0)}</span></div><div class="row"><span>Taxes</span><span>${formatInvoiceAmount(rawInvoice?.tax_total ?? 0)}</span></div><div class="row grand"><span>Total</span><span>${formatInvoiceAmount(rawInvoice?.total ?? order.total)}</span></div></div>
      <div class="note"><strong>Paiement à la livraison</strong><br/>Document récapitulatif de commande. Ce reçu est informatif et ne constitue pas une facture fiscale.</div>
    </body></html>`;

  if (Platform.OS === "web") {
    // Browser print dialog lets the customer save the receipt as a PDF.
    await Print.printAsync({ html });
    return;
  }

  const { uri } = await Print.printToFileAsync({ html });
  if (!(await Sharing.isAvailableAsync())) throw new Error("Le partage de fichiers PDF n’est pas disponible sur cet appareil.");
  await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Reçu ${invoiceNumber}` });
}
