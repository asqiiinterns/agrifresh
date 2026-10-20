import { supabase } from "../lib/supabase";
import { company } from "../config/company";
import { formatClientNumber } from "./account";
import { ORDER_FIELDS, deliveryNoteNumber, discountText, type Order } from "./orders";
import { brandColor, documentStyles, escapeHtml, outputPdf, pdfAmount, pdfDate, pdfQuantity, sellerBlock } from "./pdf";

export type Invoice = {
  id: string;
  invoice_number: string | null;
  client_id: string;
  status: "draft" | "issued" | "paid" | "cancelled";
  issued_at: string;
  paid_at: string | null;
  client_snapshot: { business_name: string; contact_name?: string; client_number: number; email?: string | null; phone?: string; tax_id?: string | null; address?: string | null };
  total_ht: number | string;
  vat_breakdown: { rate: number | string; base: number | string; vat: number | string }[];
  total_vat: number | string;
  stamp_duty: number | string;
  total_ttc: number | string;
  // Payments (20261031_billing_decisions.sql).
  amount_paid?: number | string;
  due_date?: string | null;
  last_reminder_at?: string | null;
  reminder_count?: number;
  invoice_payments?: Payment[];
};

export type PaymentMethod = "cash" | "check" | "transfer" | "card" | "credit_note" | "other";
export type Payment = { id: string; amount: number | string; method: PaymentMethod; paid_on: string; reference: string | null; credit_note_id: string | null; created_at: string };
export const paymentMethods: { key: PaymentMethod; label: string }[] = [
  { key: "transfer", label: "Virement" },
  { key: "check", label: "Chèque" },
  { key: "cash", label: "Espèces" },
  { key: "card", label: "Carte" },
  { key: "credit_note", label: "Avoir" },
  { key: "other", label: "Autre" },
];
export const paymentMethodLabel = (method: string) => method === "deposit" ? "Acompte" : paymentMethods.find((item) => item.key === method)?.label ?? method;
export const balanceOf = (invoice: Pick<Invoice, "total_ttc" | "amount_paid">) => Math.max(0, Number(invoice.total_ttc) - Number(invoice.amount_paid ?? 0));
export const isOverdue = (invoice: Pick<Invoice, "status" | "due_date" | "total_ttc" | "amount_paid">) =>
  invoice.status === "issued" && !!invoice.due_date && invoice.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10) && balanceOf(invoice) > 0.0005;

export type InvoiceWithOrders = Invoice & { orders: Order[] };

const INVOICE_FIELDS = "*, invoice_payments(id, amount, method, paid_on, reference, credit_note_id, created_at)";

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchInvoices(): Promise<InvoiceWithOrders[]> {
  const { data, error } = await client()
    .from("client_invoices")
    .select(`${INVOICE_FIELDS}, orders(${ORDER_FIELDS})`)
    .order("issued_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as InvoiceWithOrders[];
}

// Accepted delivery notes of a client that are not on an invoice yet (or already on this draft).
export async function fetchUninvoicedOrders(clientId: string, draftId?: string): Promise<Order[]> {
  const { data, error } = await client()
    .from("orders")
    .select(ORDER_FIELDS)
    .eq("client_id", clientId)
    .or(draftId ? `client_invoice_id.is.null,client_invoice_id.eq.${draftId}` : "client_invoice_id.is.null")
    .in("status", ["confirmed", "preparing", "ready", "out_for_delivery", "delivered"])
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as unknown as Order[];
}

export async function addPayment(invoiceId: string, payment: { amount: number; method: PaymentMethod; paidOn: string; reference: string; creditNoteId?: string | null }): Promise<void> {
  const { error } = await client().rpc("staff_add_payment", {
    p_invoice_id: invoiceId, p_amount: payment.amount, p_method: payment.method, p_paid_on: payment.paidOn || null,
    p_reference: payment.reference.trim() || null, p_credit_note_id: payment.creditNoteId ?? null,
  });
  if (error) throw error;
}

export async function deletePayment(paymentId: string): Promise<void> {
  const { error } = await client().rpc("staff_delete_payment", { p_payment_id: paymentId });
  if (error) throw error;
}

// Sends the due reminders (one per overdue invoice, at most once per interval unless forced).
export async function sendReminders(clientId: string | null = null, force = false): Promise<number> {
  const { data, error } = await client().rpc("staff_send_payment_reminders", { p_client_id: clientId, p_force: force });
  if (error) throw error;
  return Number(data ?? 0);
}

export type BillingBoard = {
  due: { client_id: string; business_name: string; frequency: string; every_days: number; month_day: number; next_date: string; orders: number; amount: number }[];
  overdue: { invoice_id: string; invoice_number: string; client_id: string; business_name: string; balance: number; due_date: string; days_late: number; reminder_count: number; last_reminder_at: string | null; reminders: boolean }[];
};
export async function fetchBillingBoard(): Promise<BillingBoard> {
  const { data, error } = await client().rpc("billing_board");
  if (error) throw error;
  return data as BillingBoard;
}

export const invoiceLabel = (invoice: Pick<Invoice, "invoice_number">) => invoice.invoice_number ?? "Brouillon";

// A draft has no number and stays editable and hidden from the client until it is issued.
export async function createInvoice(clientId: string, orderIds: string[], draft: boolean): Promise<{ id: string; invoice_number: string | null }> {
  const { data, error } = await client().rpc("staff_create_invoice", { p_client_id: clientId, p_order_ids: orderIds, p_draft: draft });
  if (error) throw error;
  return data as { id: string; invoice_number: string | null };
}

export async function updateInvoiceDraft(invoiceId: string, orderIds: string[]): Promise<void> {
  const { error } = await client().rpc("staff_update_invoice_draft", { p_invoice_id: invoiceId, p_order_ids: orderIds });
  if (error) throw error;
}

export async function issueInvoice(invoiceId: string): Promise<string> {
  const { data, error } = await client().rpc("staff_issue_invoice", { p_invoice_id: invoiceId });
  if (error) throw error;
  return (data as { invoice_number: string }).invoice_number;
}

export async function deleteInvoiceDraft(invoiceId: string): Promise<void> {
  const { error } = await client().rpc("staff_delete_invoice_draft", { p_invoice_id: invoiceId });
  if (error) throw error;
}

export async function setInvoiceStatus(invoiceId: string, status: Invoice["status"]): Promise<void> {
  const { error } = await client().rpc("staff_set_invoice_status", { p_invoice_id: invoiceId, p_status: status });
  if (error) throw error;
}

// Same rules as the database, used to preview a draft invoice before creating it.
export function invoiceTotals(orders: Order[]) {
  const byRate = new Map<number, number>();
  for (const order of orders) {
    for (const line of order.order_items) {
      const rate = Number(line.vat_rate);
      byRate.set(rate, (byRate.get(rate) ?? 0) + Number(line.line_total));
    }
  }
  const breakdown = [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, base]) => ({ rate, base, vat: Math.round(base * rate * 10) / 1000 }));
  const ht = breakdown.reduce((sum, item) => sum + item.base, 0);
  const vat = breakdown.reduce((sum, item) => sum + item.vat, 0);
  const stamp = orders.length ? 1 : 0;
  return { breakdown, ht, vat, stamp, ttc: ht + vat + stamp };
}

export async function shareInvoice(invoice: InvoiceWithOrders): Promise<void> {
  const buyer = invoice.client_snapshot;
  const orders = [...invoice.orders].sort((a, b) => a.order_number - b.order_number);
  const rows = orders.map((order) => `
    <tr class="bl"><td colspan="5"><strong>${deliveryNoteNumber(order)}</strong> · commande #${order.order_number} du ${pdfDate(order.created_at)}${order.address_snapshot?.point_label ? ` · ${escapeHtml(order.address_snapshot.point_label)}` : ""}${order.delivered_at ? ` · livrée le ${pdfDate(order.delivered_at)}` : ""}</td></tr>
    ${order.order_items.map((line) => `<tr>
      <td>${escapeHtml(line.product_name_snapshot)}${line.discount_label ? `<div class="muted">${escapeHtml(discountText(line))}</div>` : ""}</td>
      <td class="number">${pdfQuantity(line.quantity)} ${escapeHtml(line.unit_snapshot)}</td>
      <td class="number">${pdfAmount(line.unit_price)}</td>
      <td class="number">${Number(line.vat_rate)} %</td>
      <td class="number">${pdfAmount(line.line_total)}</td>
    </tr>`).join("")}`).join("");

  const vatRows = invoice.vat_breakdown.map((item) => `<div class="row"><span>TVA ${Number(item.rate)} % sur ${pdfAmount(item.base)}</span><span>${pdfAmount(item.vat)}</span></div>`).join("");

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><style>${documentStyles()}
    tr.bl td{background:#f6f7f9;color:${brandColor()};font-size:11px;padding-top:12px}
    .stamp{position:fixed;top:50%;left:50%;font-size:72px;color:rgba(166,61,47,.18);transform:translate(-50%,-50%) rotate(-24deg);font-weight:bold;white-space:nowrap;pointer-events:none;z-index:0}
  </style></head><body>
    ${invoice.status === "cancelled" ? `<div class="stamp">ANNULÉE</div>` : invoice.status === "draft" ? `<div class="stamp">BROUILLON</div>` : ""}
    <div class="top">
      <div><h1>${escapeHtml(company.name)}</h1><div class="muted">${escapeHtml(company.tagline)}</div></div>
      <div class="doc"><strong>${invoice.status === "draft" ? "FACTURE (BROUILLON)" : "FACTURE"}</strong><br/>${escapeHtml(invoiceLabel(invoice))}<br/><span class="muted">Date : ${pdfDate(invoice.issued_at)}</span>
        ${invoice.status === "paid" && invoice.paid_at ? `<br/><span class="muted">Payée le ${pdfDate(invoice.paid_at)}</span>` : ""}</div>
    </div>
    <div class="parties">
      ${sellerBlock()}
      <div class="party"><strong>${escapeHtml(buyer.business_name)}</strong> · ${formatClientNumber(buyer.client_number)}
        ${buyer.address ? `<br/>${escapeHtml(buyer.address)}` : ""}${buyer.phone ? `<br/>${escapeHtml(buyer.phone)}` : ""}
        ${buyer.tax_id ? `<br/>MF : ${escapeHtml(buyer.tax_id)}` : ""}</div>
    </div>
    <table><thead><tr><th>Désignation</th><th class="number">Quantité</th><th class="number">PU HT</th><th class="number">TVA</th><th class="number">Total HT</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      <div class="row"><span>Total HT</span><span>${pdfAmount(invoice.total_ht)}</span></div>
      ${vatRows}
      <div class="row"><span>Timbre fiscal</span><span>${pdfAmount(invoice.stamp_duty)}</span></div>
      <div class="row grand"><span>Net à payer TTC</span><span>${pdfAmount(invoice.total_ttc)} TND</span></div>
    </div>
    ${company.rib ? `<div class="note">Règlement par virement : ${escapeHtml(company.rib)}</div>` : ""}
  </body></html>`;

  await outputPdf(html, invoice.invoice_number ?? `brouillon-${invoice.id.slice(0, 8)}`, `Facture ${invoiceLabel(invoice)}`);
}
