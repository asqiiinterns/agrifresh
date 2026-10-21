import { isBuyerMode, rpcOr, shared } from "./shared";
import { supabase } from "../lib/supabase";
import { company } from "../config/company";
import { formatClientNumber } from "./account";
import { documentStyles, escapeHtml, outputPdf, pdfAmount, pdfDate, pdfQuantity, sellerBlock } from "./pdf";

export type ReturnStatus = "requested" | "approved" | "refused" | "received" | "credited";
export type ReturnReason = "quality" | "damaged" | "wrong" | "excess" | "other";
export type ReturnItem = { id: string; product_id: string | null; product_name: string; unit: string; quantity: number | string; unit_price: number | string; vat_rate: number | string };
export type ProductReturn = {
  id: string;
  return_number: string | null;
  client_id: string;
  order_id: string | null;
  status: ReturnStatus;
  reason: ReturnReason;
  description: string | null;
  staff_note: string | null;
  restocked: boolean;
  created_at: string;
  received_at: string | null;
  return_items: ReturnItem[];
  clients: { business_name: string } | null;
  orders: { order_number: number; delivery_note_number: string | null } | null;
  credit_notes: { id: string; credit_number: string | null; status: CreditStatus }[];
};

export type CreditStatus = "draft" | "issued" | "refunded" | "deducted" | "cancelled";
export type CreditItem = { id: string; label: string; quantity: number | string; unit: string; unit_price: number | string; vat_rate: number | string };
export type CreditNote = {
  id: string;
  credit_number: string | null;
  client_id: string;
  return_id: string | null;
  invoice_id: string | null;
  status: CreditStatus;
  reason: string | null;
  client_snapshot: { business_name: string; client_number: number; phone?: string; tax_id?: string | null; address?: string | null } | null;
  total_ht: number | string;
  total_vat: number | string;
  total_ttc: number | string;
  created_at: string;
  issued_at: string | null;
  settled_at: string | null;
  credit_note_items: CreditItem[];
  clients: { business_name: string; client_number: number } | null;
  client_invoices: { invoice_number: string | null } | null;
};
export type CreditLineInput = { label: string; quantity: number; unit: string; unit_price: number; vat_rate: number };

export const returnReasons: { key: ReturnReason; label: string }[] = [
  { key: "quality", label: "Qualité insuffisante" },
  { key: "damaged", label: "Produit abîmé" },
  { key: "wrong", label: "Erreur de produit" },
  { key: "excess", label: "Quantité en trop" },
  { key: "other", label: "Autre" },
];
export const returnReasonLabel = (reason: string) => returnReasons.find((item) => item.key === reason)?.label ?? reason;

export const returnStatusStyle: Record<ReturnStatus, { label: string; color: string; background: string }> = {
  requested: { label: "Demandé", color: "#7a5a12", background: "#fbefc9" },
  approved: { label: "Accepté", color: "#1e4f8f", background: "#dbe7f8" },
  refused: { label: "Refusé", color: "#a63d2f", background: "#f8e2dd" },
  received: { label: "Reçu", color: "#0f6b64", background: "#d3f0ec" },
  credited: { label: "Avoir fait", color: "#1d6b36", background: "#d6efdc" },
};
export const creditStatusStyle: Record<CreditStatus, { label: string; color: string; background: string }> = {
  draft: { label: "Brouillon", color: "#5f6560", background: "#e9eae7" },
  issued: { label: "Émis", color: "#1e4f8f", background: "#dbe7f8" },
  refunded: { label: "Remboursé", color: "#1d6b36", background: "#d6efdc" },
  deducted: { label: "Déduit", color: "#0f6b64", background: "#d3f0ec" },
  cancelled: { label: "Annulé", color: "#a63d2f", background: "#f8e2dd" },
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

async function loadReturns(): Promise<ProductReturn[]> {
  if (isBuyerMode()) return rpcOr<ProductReturn[]>("buyer_returns", {}, loadOwnReturns);
  return loadOwnReturns();
}

async function loadOwnReturns(): Promise<ProductReturn[]> {
  const { data, error } = await client()
    .from("returns")
    .select("id, return_number, client_id, order_id, status, reason, description, staff_note, restocked, created_at, received_at, return_items(id, product_id, product_name, unit, quantity, unit_price, vat_rate), clients(business_name), orders(order_number, delivery_note_number), credit_notes(id, credit_number, status)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as ProductReturn[];
}

async function loadCreditNotes(): Promise<CreditNote[]> {
  if (isBuyerMode()) return rpcOr<CreditNote[]>("buyer_credit_notes", {}, loadOwnCreditNotes);
  return loadOwnCreditNotes();
}

async function loadOwnCreditNotes(): Promise<CreditNote[]> {
  const { data, error } = await client()
    .from("credit_notes")
    .select("id, credit_number, client_id, return_id, invoice_id, status, reason, client_snapshot, total_ht, total_vat, total_ttc, created_at, issued_at, settled_at, credit_note_items(id, label, quantity, unit, unit_price, vat_rate), clients(business_name, client_number), client_invoices(invoice_number)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as CreditNote[];
}

export async function requestReturn(orderId: string, items: { product_id: string; quantity: number }[], reason: ReturnReason, description: string): Promise<string> {
  const args = { p_order_id: orderId, p_items: items, p_reason: reason, p_description: description.trim() || null };
  const own = async () => {
    const { data, error } = await client().rpc("client_request_return", args);
    if (error) throw error;
    return data as { return_number: string };
  };
  // A buyer asks the supplier of that order, whichever supplier is selected.
  const result = isBuyerMode() ? await rpcOr("buyer_request_return", args, own) : await own();
  return result.return_number;
}

export async function staffCreateReturn(orderId: string, items: { product_id: string; quantity: number }[], reason: ReturnReason, description: string): Promise<string> {
  const { data, error } = await client().rpc("staff_create_return", { p_order_id: orderId, p_items: items, p_reason: reason, p_description: description.trim() || null });
  if (error) throw error;
  return (data as { return_number: string }).return_number;
}

export async function updateReturn(returnId: string, action: "approve" | "refuse" | "receive", note?: string, restock = true): Promise<void> {
  const { error } = await client().rpc("staff_update_return", { p_return_id: returnId, p_action: action, p_note: note?.trim() || null, p_restock: restock });
  if (error) throw error;
}

export async function creditReturn(returnId: string, issue: boolean): Promise<{ credit_number: string | null; total_ttc: number }> {
  const { data, error } = await client().rpc("staff_credit_return", { p_return_id: returnId, p_issue: issue });
  if (error) throw error;
  return data as { credit_number: string | null; total_ttc: number };
}

export async function createCreditNote(clientId: string, invoiceId: string | null, reason: string, lines: CreditLineInput[], issue: boolean): Promise<{ credit_number: string | null }> {
  const { data, error } = await client().rpc("staff_create_credit_note", { p_client_id: clientId, p_invoice_id: invoiceId, p_reason: reason, p_lines: lines, p_issue: issue });
  if (error) throw error;
  return data as { credit_number: string | null };
}

export async function updateCreditNote(creditId: string, action: "issue" | "refunded" | "deducted" | "cancelled" | "delete"): Promise<void> {
  const { error } = await client().rpc("staff_update_credit_note", { p_credit_id: creditId, p_action: action });
  if (error) throw error;
}

export const creditLabel = (credit: Pick<CreditNote, "credit_number">) => credit.credit_number ?? "Brouillon";

export async function shareCreditNote(credit: CreditNote): Promise<void> {
  const buyer = credit.client_snapshot ?? { business_name: credit.clients?.business_name ?? "", client_number: credit.clients?.client_number ?? 0 };
  const rows = credit.credit_note_items.map((line) => {
    const total = Number(line.quantity) * Number(line.unit_price);
    return `<tr><td>${escapeHtml(line.label)}</td><td class="number">${pdfQuantity(line.quantity)} ${escapeHtml(line.unit)}</td>
      <td class="number">${pdfAmount(line.unit_price)}</td><td class="number">${Number(line.vat_rate)} %</td><td class="number">${pdfAmount(total)}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><style>${documentStyles()}
    .stamp{position:fixed;top:50%;left:50%;font-size:72px;color:rgba(166,61,47,.18);transform:translate(-50%,-50%) rotate(-24deg);font-weight:bold;white-space:nowrap;pointer-events:none;z-index:0}
  </style></head><body>
    ${credit.status === "cancelled" ? `<div class="stamp">ANNULÉ</div>` : credit.status === "draft" ? `<div class="stamp">BROUILLON</div>` : ""}
    <div class="top">
      <div><h1>${escapeHtml(company.name)}</h1><div class="muted">${escapeHtml(company.tagline)}</div></div>
      <div class="doc"><strong>AVOIR</strong><br/>${escapeHtml(creditLabel(credit))}<br/><span class="muted">Date : ${pdfDate(credit.issued_at ?? credit.created_at)}</span>
        ${credit.client_invoices?.invoice_number ? `<br/><span class="muted">Sur facture ${escapeHtml(credit.client_invoices.invoice_number)}</span>` : ""}</div>
    </div>
    <div class="parties">
      ${sellerBlock()}
      <div class="party"><strong>${escapeHtml(buyer.business_name)}</strong> · ${formatClientNumber(buyer.client_number)}
        ${"address" in buyer && buyer.address ? `<br/>${escapeHtml(buyer.address)}` : ""}${"tax_id" in buyer && buyer.tax_id ? `<br/>MF : ${escapeHtml(buyer.tax_id)}` : ""}</div>
    </div>
    ${credit.reason ? `<p><strong>Motif :</strong> ${escapeHtml(credit.reason)}</p>` : ""}
    <table><thead><tr><th>Désignation</th><th class="number">Quantité</th><th class="number">PU HT</th><th class="number">TVA</th><th class="number">Total HT</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      <div class="row"><span>Total HT</span><span>${pdfAmount(credit.total_ht)}</span></div>
      <div class="row"><span>TVA</span><span>${pdfAmount(credit.total_vat)}</span></div>
      <div class="row grand"><span>Montant de l’avoir TTC</span><span>${pdfAmount(credit.total_ttc)} TND</span></div>
    </div>
  </body></html>`;
  await outputPdf(html, credit.credit_number ?? `avoir-brouillon-${credit.id.slice(0, 8)}`, `Avoir ${creditLabel(credit)}`);
}

export const fetchReturns = () => shared("fetchReturns", loadReturns);

export const fetchCreditNotes = () => shared("fetchCreditNotes", loadCreditNotes);
