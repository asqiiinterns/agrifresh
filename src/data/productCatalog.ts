import { supabase } from "../lib/supabase";
import { company } from "../config/company";
import { toCsv } from "./exports";
import { brandColor, escapeHtml, outputPdf, pdfAmount } from "./pdf";
import type { AdminProduct, Category, CategoryField } from "./productAdmin";

// Products: Excel/CSV export, import of a full or partial file with a preview (20261202 keeps every import with what
// it changed), and the catalogue PDF with its options and saved presets.

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
const number = (value: unknown) => Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));

// Columns of the file: French headers (also understood in English); "Fiche · <champ>" for the sheet's fields.
const COLUMNS: { key: string; header: string; aliases: string[] }[] = [
  { key: "id", header: "ID", aliases: ["id"] },
  { key: "sku", header: "Référence", aliases: ["reference", "ref", "sku"] },
  { key: "gtin", header: "Code-barres", aliases: ["code barres", "code-barres", "ean", "gtin", "barcode"] },
  { key: "platform_code", header: "Code Appro+", aliases: ["code appro+", "code appro"] },
  { key: "name", header: "Nom", aliases: ["nom", "name", "produit", "designation", "désignation"] },
  { key: "description", header: "Description", aliases: ["description"] },
  { key: "category", header: "Catégorie", aliases: ["categorie", "category"] },
  { key: "unit_label", header: "Unité", aliases: ["unite", "unit"] },
  { key: "price", header: "Prix HT", aliases: ["prix ht", "prix", "price"] },
  { key: "vat_rate", header: "TVA", aliases: ["tva", "vat", "tva %"] },
  { key: "stock_quantity", header: "Stock", aliases: ["stock", "quantite", "quantité"] },
  { key: "active", header: "Actif", aliases: ["actif", "active", "propose", "proposé"] },
  { key: "origin_producer", header: "Producteur", aliases: ["producteur", "producer"] },
  { key: "origin_region", header: "Région", aliases: ["region"] },
  { key: "origin_label", header: "Label", aliases: ["label"] },
  { key: "origin_note", header: "Note qualité", aliases: ["note qualite", "note"] },
];
const FIELD_PREFIX = "Fiche · ";

// Every sheet field known, by key (a field has the same key in every category that uses it).
export const allFields = (categories: Category[]) => {
  const map = new Map<string, CategoryField>();
  categories.forEach((category) => (category.fields ?? []).forEach((field) => { if (!map.has(field.key)) map.set(field.key, field); }));
  return [...map.values()];
};

export function productsCsv(products: AdminProduct[], categories: Category[]): string {
  const fields = allFields(categories);
  const categoryName = (id: string | null) => categories.find((item) => item.id === id)?.name.split(" › ").pop() ?? "";
  const header = [...COLUMNS.map((column) => column.header), ...fields.map((field) => `${FIELD_PREFIX}${field.label}`)];
  const rows = products.map((product) => [
    product.id, product.sku ?? "", product.gtin ?? "", product.platform_code ?? "", product.name, product.description, categoryName(product.category_id),
    product.unit_label, Number(product.price), Number(product.vat_rate), Number(product.stock_quantity), product.active ? "Oui" : "Non",
    product.origin_producer ?? "", product.origin_region ?? "", product.origin_label ?? "", product.origin_note ?? "",
    ...fields.map((field) => product.attributes?.[field.key] ?? ""),
  ]);
  return toCsv([header, ...rows]);
}

export type ImportChange = { label: string; from: string; to: string };
export type ImportLine = { line: number; kind: "new" | "update" | "same" | "ignored"; name: string; changes: ImportChange[]; reason?: string };
export type ImportPlan = { rows: Record<string, unknown>[]; lines: ImportLine[]; columns: string[]; unknownColumns: string[] };

// Reads the file and compares it with the current products: only the columns present are compared (partial file).
export function planImport(rowsOfFile: string[][], products: AdminProduct[], categories: Category[]): ImportPlan {
  const head = rowsOfFile[0] ?? [];
  const fields = allFields(categories);
  const mapping = head.map((title) => {
    const name = fold(title);
    if (name.startsWith(fold(FIELD_PREFIX)) || name.startsWith("fiche ")) {
      const label = fold(title.replace(/^fiche\s*[·:.-]?\s*/i, ""));
      const field = fields.find((item) => fold(item.label) === label || item.key === label);
      return field ? { key: `attr:${field.key}`, label: field.label } : null;
    }
    const column = COLUMNS.find((item) => fold(item.header) === name || item.aliases.includes(name));
    return column ? { key: column.key, label: column.header } : null;
  });
  const unknownColumns = head.filter((_, index) => !mapping[index]);
  const rows: Record<string, unknown>[] = [];
  const lines: ImportLine[] = [];
  const categoryName = (id: string | null) => categories.find((item) => item.id === id)?.name.split(" › ").pop() ?? "";
  rowsOfFile.slice(1).forEach((values, index) => {
    const row: Record<string, unknown> = {};
    const attributes: Record<string, string> = {};
    mapping.forEach((column, columnIndex) => {
      if (!column || column.key === "platform_code") return;
      const value = values[columnIndex] ?? "";
      if (column.key.startsWith("attr:")) { if (value !== "") attributes[column.key.slice(5)] = value; return; }
      // An empty cell of an identifier does not erase it; other empty cells do (partial files leave the column out).
      if (["id", "sku", "gtin", "category"].includes(column.key) && value === "") return;
      row[column.key] = value;
    });
    if (Object.keys(attributes).length) row.attributes = attributes;
    const product = products.find((item) => (row.id && item.id === row.id) || (row.sku && (item.sku ?? "").toLowerCase() === String(row.sku).toLowerCase())
      || (row.gtin && item.gtin === String(row.gtin).replace(/\s/g, "")));
    const name = String(row.name ?? product?.name ?? "—");
    if (!product && (!row.name || row.price === undefined || row.price === "")) {
      lines.push({ line: index + 2, kind: "ignored", name, changes: [], reason: "Produit introuvable : pour le créer, indiquez au moins le nom et le prix." });
      return;
    }
    const current: Record<string, string> = product ? {
      sku: product.sku ?? "", gtin: product.gtin ?? "", name: product.name, description: product.description, category: categoryName(product.category_id),
      unit_label: product.unit_label, price: String(Number(product.price)), vat_rate: String(Number(product.vat_rate)), stock_quantity: String(Number(product.stock_quantity)),
      active: product.active ? "oui" : "non", origin_producer: product.origin_producer ?? "", origin_region: product.origin_region ?? "",
      origin_label: product.origin_label ?? "", origin_note: product.origin_note ?? "",
    } : {};
    const changes: ImportChange[] = [];
    for (const [key, raw] of Object.entries(row)) {
      if (key === "id" || key === "attributes") continue;
      const label = COLUMNS.find((column) => column.key === key)?.header ?? key;
      let to = String(raw);
      let from = current[key] ?? "";
      if (["price", "vat_rate", "stock_quantity"].includes(key)) {
        if (!Number.isFinite(number(to))) { changes.push({ label, from, to: `${to} (invalide)` }); continue; }
        to = String(number(to));
        from = from === "" ? "" : String(number(from));
      }
      if (key === "active") { to = /^(oui|yes|1|x|vrai|true)$/i.test(to.trim()) ? "oui" : "non"; }
      if (key === "category") { to = to.split("›").pop()?.trim() ?? to; }
      if (fold(from) !== fold(to)) changes.push({ label, from, to });
    }
    for (const [key, value] of Object.entries(attributes)) {
      const from = product?.attributes?.[key] ?? "";
      if (from !== value) changes.push({ label: fields.find((field) => field.key === key)?.label ?? key, from, to: value });
    }
    rows.push(row);
    lines.push({ line: index + 2, kind: product ? (changes.length ? "update" : "same") : "new", name, changes });
  });
  return { rows, lines, columns: mapping.filter((item): item is { key: string; label: string } => !!item).map((item) => item.label), unknownColumns };
}

export type ImportResult = { import_id: string; created: number; updated: number; unchanged: number; ignored: { line: number; reason: string }[] };
export async function importProducts(fileName: string, rows: Record<string, unknown>[]): Promise<ImportResult> {
  const { data, error } = await client().rpc("products_import", { p_file: fileName, p_rows: rows });
  if (error) throw error;
  return data as ImportResult;
}

export type ImportRecord = { id: string; imported_at: string; by: string | null; file_name: string | null; created: number; updated: number; unchanged: number; ignored: number;
  changes: { product_id: string; name: string; created: boolean; before: Record<string, unknown>; after: Record<string, unknown> }[] };
export async function fetchImportHistory(): Promise<ImportRecord[]> {
  const { data, error } = await client().rpc("product_import_history");
  if (error) throw error;
  return (data ?? []) as ImportRecord[];
}

// ---- Catalogue PDF ----
export type CatalogOptions = { photo: boolean; description: boolean; price: boolean; priceTtc: boolean; vat: boolean; stock: boolean; origin: boolean; identifiers: boolean; sheet: boolean; inactive: boolean };
export const defaultCatalogOptions: CatalogOptions = { photo: true, description: true, price: true, priceTtc: false, vat: false, stock: false, origin: true, identifiers: false, sheet: true, inactive: false };
export const catalogOptionLabels: Record<keyof CatalogOptions, string> = {
  photo: "Photos", description: "Descriptions", price: "Prix HT", priceTtc: "Prix TTC", vat: "Taux de TVA", stock: "Stock disponible",
  origin: "Origine (producteur, région, label)", identifiers: "Références et codes-barres", sheet: "Fiche produit (variété, calibre…)", inactive: "Produits non proposés",
};
export type CatalogPreset = { name: string; options: CatalogOptions; default?: boolean };

export async function fetchCatalogPresets(): Promise<CatalogPreset[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("my_catalog_presets");
  if (error) return null;
  return ((data ?? []) as CatalogPreset[]).map((preset) => ({ ...preset, options: { ...defaultCatalogOptions, ...preset.options } }));
}
export async function saveCatalogPresets(presets: CatalogPreset[]): Promise<void> {
  const { error } = await client().rpc("set_catalog_presets", { p_presets: presets });
  if (error) throw error;
}

export async function shareCatalogPdf(products: AdminProduct[], categories: Category[], options: CatalogOptions, title = "Catalogue"): Promise<void> {
  const list = products.filter((product) => options.inactive || product.active);
  const groups = new Map<string, AdminProduct[]>();
  for (const product of list) {
    const name = categories.find((item) => item.id === product.category_id)?.name ?? "Autres produits";
    groups.set(name, [...(groups.get(name) ?? []), product]);
  }
  const fieldsOf = (product: AdminProduct) => categories.find((item) => item.id === product.category_id)?.fields ?? [];
  const card = (product: AdminProduct) => {
    const price = Number(product.price);
    const ttc = price * (1 + Number(product.vat_rate) / 100);
    const sheet = options.sheet ? fieldsOf(product).map((field) => product.attributes?.[field.key] ? `${escapeHtml(field.label)} : ${escapeHtml(product.attributes[field.key])}${field.unit ? ` ${escapeHtml(field.unit)}` : ""}` : "").filter(Boolean) : [];
    const origin = options.origin ? [product.origin_producer, product.origin_region, product.origin_label].filter(Boolean).join(" · ") : "";
    return `<div class="card">
      ${options.photo && product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt=""/>` : ""}
      <div class="info">
        <div class="name">${escapeHtml(product.name)}${product.active ? "" : ' <span class="muted">(non proposé)</span>'}</div>
        <div class="muted">${escapeHtml(product.unit_label)}${options.identifiers ? [product.sku ? ` · Réf. ${escapeHtml(product.sku)}` : "", product.gtin ? ` · EAN ${escapeHtml(product.gtin)}` : ""].join("") : ""}</div>
        ${options.description && product.description ? `<div class="desc">${escapeHtml(product.description)}</div>` : ""}
        ${sheet.length ? `<div class="sheet">${sheet.join(" · ")}</div>` : ""}
        ${origin ? `<div class="origin">${escapeHtml(origin)}</div>` : ""}
        ${options.stock ? `<div class="muted">Stock : ${escapeHtml(String(Number(product.stock_quantity)))}</div>` : ""}
      </div>
      ${options.price || options.priceTtc ? `<div class="price">${options.price ? `${pdfAmount(price)} HT` : ""}${options.price && options.priceTtc ? "<br/>" : ""}${options.priceTtc ? `${pdfAmount(ttc)} TTC` : ""}${options.vat ? `<br/><span class="muted">TVA ${Number(product.vat_rate)} %</span>` : ""}</div>` : ""}
    </div>`;
  };
  const color = brandColor();
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><style>
    body{font-family:Arial,sans-serif;color:#1d2939;padding:24px;max-width:820px;margin:auto;font-size:11px}
    h1{color:${color};margin:0;font-size:24px} h2{color:${color};font-size:15px;margin:22px 0 8px;border-bottom:2px solid ${color};padding-bottom:4px}
    .muted{color:#667085;font-size:10px} .top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid ${color};padding-bottom:12px}
    .card{display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #e2e6ec;page-break-inside:avoid}
    .card img{width:64px;height:64px;object-fit:cover;border-radius:6px} .info{flex:1} .name{font-weight:bold;font-size:13px}
    .desc{margin-top:3px} .sheet{margin-top:3px;color:#344054} .origin{margin-top:3px;color:${color}} .price{text-align:right;font-weight:bold;font-size:13px;white-space:nowrap}
  </style></head><body>
    <div class="top"><div><h1>${escapeHtml(company.name || "Catalogue")}</h1><div class="muted">${escapeHtml(company.tagline)}</div></div>
      <div class="muted" style="text-align:right">${escapeHtml(title)}<br/>${new Date().toLocaleDateString("fr-TN")}<br/>${list.length} produit(s)</div></div>
    ${[...groups.entries()].map(([name, items]) => `<h2>${escapeHtml(name)}</h2>${items.map(card).join("")}`).join("")}
    ${company.phone || company.email ? `<p class="muted" style="margin-top:20px">${escapeHtml([company.phone, company.email, company.address].filter(Boolean).join(" · "))}</p>` : ""}
  </body></html>`;
  await outputPdf(html, `${title}-${company.name || "catalogue"}`, title);
}
