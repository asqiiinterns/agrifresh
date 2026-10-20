import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { company } from "../config/company";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character] ?? character));

export const pdfAmount = (amount: number | string) =>
  new Intl.NumberFormat("fr-TN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(amount));

export const pdfQuantity = (quantity: number | string) =>
  new Intl.NumberFormat("fr-TN", { maximumFractionDigits: 3 }).format(Number(quantity));

export const pdfDate = (value: string) =>
  new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value).toLocaleDateString("fr-TN");

// Documents wear the seller's colour (Paramétrage → Entreprise), navy by default.
export const brandColor = () => /^#[0-9a-fA-F]{6}$/.test(company.brandColor) ? company.brandColor : "#1f3b63";

export const documentStyles = () => `
  body{font-family:Arial,sans-serif;color:#1d2939;padding:28px;max-width:800px;margin:auto;font-size:12px}
  h1{color:${brandColor()};margin:0;font-size:26px} .muted{color:#667085;font-size:11px}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${brandColor()};padding-bottom:16px;gap:20px}
  .doc{text-align:right} .doc strong{font-size:16px;color:${brandColor()}}
  .parties{display:flex;justify-content:space-between;gap:24px;margin-top:20px}
  .party{flex:1;padding:12px;background:#eef1f5;border-radius:8px;line-height:1.5}
  table{width:100%;border-collapse:collapse;margin-top:22px} th,td{padding:9px 7px;border-bottom:1px solid #e2e6ec;text-align:left}
  th{color:${brandColor()};background:#eef1f5;font-size:11px}.number{text-align:right;white-space:nowrap}
  .totals{margin:18px 0 0 auto;width:300px}.row{display:flex;justify-content:space-between;padding:5px 0}
  .grand{border-top:2px solid ${brandColor()};color:${brandColor()};font-weight:bold;font-size:16px;padding-top:10px;margin-top:4px}
  .note{margin-top:28px;padding:12px;background:#eef1f5;border-radius:8px;font-size:10px;line-height:1.6}
  .qr{width:130px;height:130px}.qr svg{width:100%;height:100%}
  .signatures{display:flex;gap:24px;margin-top:34px}.signatures div{flex:1;border-top:1px solid #c4cad4;padding-top:6px;height:60px;font-size:10px;color:#667085}
`;

export const sellerBlock = () => `<div class="party"><strong>${escapeHtml(company.name || "—")}</strong><br/>
  ${escapeHtml(company.address)}${company.phone ? `<br/>${escapeHtml(company.phone)}` : ""}${company.email ? `<br/>${escapeHtml(company.email)}` : ""}
  ${company.taxId ? `<br/>MF : ${escapeHtml(company.taxId)}` : ""}</div>`;

export type PendingDocument = { html: string; fileName: string; title: string };

// One preview host per open window (app root, and each modal that makes documents):
// the most recently opened one shows the preview, so it is never hidden behind a modal.
type Listener = (document: PendingDocument | null) => void;
const documentListeners: Listener[] = [];

export function subscribeToDocuments(listener: Listener) {
  documentListeners.push(listener);
  return () => {
    const index = documentListeners.lastIndexOf(listener);
    if (index >= 0) documentListeners.splice(index, 1);
  };
}

// Opens the in-app preview (DocumentViewerHost) on web and mobile; the browser print
// dialog is only a fallback when the preview is not mounted.
export async function outputPdf(html: string, fileName: string, title: string): Promise<void> {
  const listener = documentListeners.at(-1);
  if (!listener) {
    await Print.printAsync({ html });
    return;
  }
  listener({ html, fileName, title });
}

// expo-print's own file lives outside the folders Sharing may read in Expo Go,
// so the PDF is written into the app cache first.
export async function sharePdf({ html, fileName, title }: PendingDocument): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Le partage de fichiers PDF n’est pas disponible sur cet appareil.");
  const { base64 } = await Print.printToFileAsync({ html, base64: true });
  if (!base64) throw new Error("Le PDF n’a pas pu être généré.");
  const file = new File(Paths.cache, `${fileName.replace(/[^\w-]+/g, "-")}.pdf`);
  file.write(base64, { encoding: "base64" });
  await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: title, UTI: "com.adobe.pdf" });
}
