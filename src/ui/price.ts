import { formatPrice } from "./components";

// Prices are kept excl. VAT (HT); they are shown with their incl. VAT (TTC) amount everywhere.
export const withVat = (ht: number | string, vatRate?: number | string | null) =>
  Math.round(Number(ht) * (1 + Number(vatRate ?? 0) / 100) * 1000) / 1000;

// Unknown VAT rate (older data): the excl. VAT price alone rather than a wrong incl. VAT one.
export const htTtc = (ht: number | string, vatRate?: number | string | null) =>
  vatRate === undefined || vatRate === null ? `${formatPrice(Number(ht))} HT` : `${formatPrice(Number(ht))} HT · ${formatPrice(withVat(ht, vatRate))} TTC`;

// TTC of lines that each carry their own VAT rate.
export const linesTtc = (lines: { line_total: number | string | null; vat_rate?: number | string | null }[]) =>
  Math.round(lines.reduce((sum, line) => sum + withVat(line.line_total ?? 0, line.vat_rate), 0) * 1000) / 1000;
