import { Platform } from "react-native";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { balanceOf, paymentMethodLabel, type InvoiceWithOrders } from "./invoices";
import type { CreditNote } from "./returns";

// CSV for Excel (French settings: ";" separator, comma decimals, UTF-8 with BOM so accents display).
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "number" ? value.toFixed(3).replace(".", ",") : String(value);
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = (rows: unknown[][]) => "﻿" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
export const toCsv = csv;
const day = (value: string | null | undefined) => value ? value.slice(0, 10).split("-").reverse().join("/") : "";
const inPeriod = (value: string | null | undefined, from: string, to: string) => !!value && value.slice(0, 10) >= from && value.slice(0, 10) <= to;

// One line per invoice, VAT split by rate.
export function invoicesCsv(invoices: InvoiceWithOrders[], from: string, to: string) {
  const list = invoices.filter((invoice) => invoice.status !== "draft" && inPeriod(invoice.issued_at, from, to)).sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  const rates = [...new Set(list.flatMap((invoice) => invoice.vat_breakdown.map((item) => Number(item.rate))))].sort((a, b) => a - b);
  const header = ["N° facture", "Date", "Échéance", "Client", "N° client", "Matricule fiscal", "Total HT", ...rates.map((rate) => `TVA ${rate} %`), "Timbre", "Total TTC", "Payé", "Reste", "Statut", "Bons de livraison"];
  const rows = list.map((invoice) => [
    invoice.invoice_number, day(invoice.issued_at), day(invoice.due_date), invoice.client_snapshot.business_name, invoice.client_snapshot.client_number, invoice.client_snapshot.tax_id ?? "",
    Number(invoice.total_ht), ...rates.map((rate) => Number(invoice.vat_breakdown.find((item) => Number(item.rate) === rate)?.vat ?? 0)),
    Number(invoice.stamp_duty), Number(invoice.total_ttc), Number(invoice.amount_paid ?? 0), balanceOf(invoice),
    invoice.status === "paid" ? "Payée" : invoice.status === "cancelled" ? "Annulée" : "À encaisser",
    invoice.orders.map((order) => order.delivery_note_number ?? `BL-${order.order_number}`).join(" "),
  ]);
  return csv([header, ...rows]);
}

export function paymentsCsv(invoices: InvoiceWithOrders[], from: string, to: string) {
  const rows = invoices.flatMap((invoice) => (invoice.invoice_payments ?? []).filter((payment) => inPeriod(payment.paid_on, from, to)).map((payment) => [
    day(payment.paid_on), invoice.invoice_number, invoice.client_snapshot.business_name, paymentMethodLabel(payment.method), payment.reference ?? "", Number(payment.amount),
  ])).sort((a, b) => String(a[0]).split("/").reverse().join("").localeCompare(String(b[0]).split("/").reverse().join("")));
  return csv([["Date", "Facture", "Client", "Mode", "Référence", "Montant"], ...rows]);
}

// Sales journal for the accountant: one entry per invoice / credit note (411 client, 706 sales, 4457 VAT, stamp).
export function salesJournalCsv(invoices: InvoiceWithOrders[], credits: CreditNote[], from: string, to: string) {
  const rows: unknown[][] = [];
  for (const invoice of invoices.filter((item) => item.status !== "draft" && item.status !== "cancelled" && inPeriod(item.issued_at, from, to)).sort((a, b) => a.issued_at.localeCompare(b.issued_at))) {
    const ref = invoice.invoice_number ?? "";
    const label = `Facture ${ref} ${invoice.client_snapshot.business_name}`;
    rows.push(["VT", day(invoice.issued_at), ref, "411", label, Number(invoice.total_ttc), ""]);
    rows.push(["VT", day(invoice.issued_at), ref, "706", label, "", Number(invoice.total_ht)]);
    for (const item of invoice.vat_breakdown) if (Number(item.vat)) rows.push(["VT", day(invoice.issued_at), ref, "4457", `${label} TVA ${Number(item.rate)} %`, "", Number(item.vat)]);
    if (Number(invoice.stamp_duty)) rows.push(["VT", day(invoice.issued_at), ref, "4458", `${label} timbre`, "", Number(invoice.stamp_duty)]);
  }
  for (const credit of credits.filter((item) => item.status !== "draft" && item.status !== "cancelled" && inPeriod(item.issued_at, from, to))) {
    const ref = credit.credit_number ?? "";
    const label = `Avoir ${ref} ${credit.clients?.business_name ?? ""}`;
    rows.push(["VT", day(credit.issued_at), ref, "709", label, Number(credit.total_ht), ""]);
    if (Number(credit.total_vat)) rows.push(["VT", day(credit.issued_at), ref, "4457", `${label} TVA`, Number(credit.total_vat), ""]);
    rows.push(["VT", day(credit.issued_at), ref, "411", label, "", Number(credit.total_ttc)]);
  }
  return csv([["Journal", "Date", "Pièce", "Compte", "Libellé", "Débit", "Crédit"], ...rows]);
}

// Download on the web, share sheet (mail, Drive, WhatsApp…) on the phone.
export async function saveCsv(fileName: string, content: string) {
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return;
  }
  const file = new File(Paths.cache, fileName);
  file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType: "text/csv", dialogTitle: fileName, UTI: "public.comma-separated-values-text" });
}
