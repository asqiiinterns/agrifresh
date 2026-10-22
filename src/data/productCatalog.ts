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
// Layout, cover page, fields shown (including each field of the product sheet), categories, sorting: everything is a
// setting, and the settings can be saved as presets for the Pro (20261202).
export type CatalogLayout = "grid" | "list" | "table";
export type CatalogSort = "category" | "name" | "price" | "priceDesc";
export type CatalogOptions = {
  layout: CatalogLayout; columns: 2 | 3; cover: boolean; title: string; subtitle: string; validUntil: string; intro: string;
  groupByCategory: boolean; sort: CatalogSort; categories: string[] | null; inStockOnly: boolean; inactive: boolean;
  photo: boolean; description: boolean; unit: boolean; price: boolean; priceTtc: boolean; vat: boolean; stock: boolean;
  origin: boolean; originNote: boolean; reference: boolean; barcode: boolean; platformCode: boolean;
  sheet: boolean; sheetFields: string[] | null; contact: boolean; pageNumbers: boolean;
};
export const defaultCatalogOptions: CatalogOptions = {
  layout: "grid", columns: 2, cover: true, title: "Catalogue", subtitle: "", validUntil: "", intro: "",
  groupByCategory: true, sort: "category", categories: null, inStockOnly: false, inactive: false,
  photo: true, description: true, unit: true, price: true, priceTtc: false, vat: false, stock: false,
  origin: true, originNote: false, reference: false, barcode: false, platformCode: false,
  sheet: true, sheetFields: null, contact: true, pageNumbers: true,
};
// The fields a person may switch on or off, in the order of the settings page.
export const catalogFieldLabels: Partial<Record<keyof CatalogOptions, string>> = {
  photo: "Photo", description: "Description", unit: "Unité de vente", price: "Prix HT", priceTtc: "Prix TTC", vat: "Taux de TVA",
  stock: "Stock disponible", origin: "Origine (producteur, région, label)", originNote: "Note qualité", reference: "Référence",
  barcode: "Code-barres", platformCode: "Code Appro+", sheet: "Fiche produit",
};
// Kept for the former presets saved before the new settings.
export const catalogOptionLabels = catalogFieldLabels;
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

// The products the catalogue will show with these settings (also used to count them on the settings page).
export function catalogProducts(products: AdminProduct[], categories: Category[], options: CatalogOptions): AdminProduct[] {
  const order = new Map(categories.map((category, index) => [category.id, index]));
  const list = products.filter((product) => (options.inactive || product.active)
    && (!options.inStockOnly || Number(product.stock_quantity) > 0)
    && (!options.categories || options.categories.includes(product.category_id ?? "")));
  const byName = (a: AdminProduct, b: AdminProduct) => a.name.localeCompare(b.name, "fr");
  return list.sort((a, b) => options.sort === "price" ? Number(a.price) - Number(b.price) || byName(a, b)
    : options.sort === "priceDesc" ? Number(b.price) - Number(a.price) || byName(a, b)
    : options.sort === "category" ? (order.get(a.category_id ?? "") ?? 999) - (order.get(b.category_id ?? "") ?? 999) || byName(a, b)
    : byName(a, b));
}

export async function shareCatalogPdf(products: AdminProduct[], categories: Category[], options: CatalogOptions): Promise<void> {
  const o = { ...defaultCatalogOptions, ...options };
  const list = catalogProducts(products, categories, o);
  const color = brandColor();
  const categoryOf = (product: AdminProduct) => categories.find((item) => item.id === product.category_id);
  const groups: [string, AdminProduct[]][] = [];
  if (o.groupByCategory) {
    for (const product of list) {
      const name = categoryOf(product)?.name ?? "Autres produits";
      const group = groups.find(([title]) => title === name);
      if (group) group[1].push(product); else groups.push([name, [product]]);
    }
  } else groups.push(["", list]);

  const ttc = (product: AdminProduct) => Number(product.price) * (1 + Number(product.vat_rate) / 100);
  const sheetOf = (product: AdminProduct) => !o.sheet ? [] : (categoryOf(product)?.fields ?? [])
    .filter((field) => (!o.sheetFields || o.sheetFields.includes(field.key)) && product.attributes?.[field.key])
    .map((field) => ({ label: field.label, value: `${product.attributes![field.key]}${field.unit ? ` ${field.unit}` : ""}` }));
  const codes = (product: AdminProduct) => [o.reference && product.sku ? `Réf. ${product.sku}` : "", o.barcode && product.gtin ? `EAN ${product.gtin}` : "",
    o.platformCode && product.platform_code ? product.platform_code : ""].filter(Boolean);
  const origin = (product: AdminProduct) => o.origin ? [product.origin_producer, product.origin_region, product.origin_label].filter(Boolean).join(" · ") : "";
  const priceBlock = (product: AdminProduct) => !o.price && !o.priceTtc ? "" : `<div class="price">
      ${o.price ? `<span class="amount">${pdfAmount(Number(product.price))}</span><span class="tax"> HT</span>` : ""}
      ${o.priceTtc ? `<div class="${o.price ? "second" : "amount"}">${pdfAmount(ttc(product))}<span class="tax"> TTC</span></div>` : ""}
      ${o.unit ? `<div class="per">le ${escapeHtml(product.unit_label)}</div>` : ""}
      ${o.vat ? `<div class="per">TVA ${Number(product.vat_rate)} %</div>` : ""}
    </div>`;
  const details = (product: AdminProduct) => {
    const sheet = sheetOf(product);
    return `${o.description && product.description ? `<p class="desc">${escapeHtml(product.description)}</p>` : ""}
      ${sheet.length ? `<div class="chips">${sheet.map((item) => `<span class="chip"><b>${escapeHtml(item.label)}</b> ${escapeHtml(item.value)}</span>`).join("")}</div>` : ""}
      ${origin(product) ? `<div class="origin">● ${escapeHtml(origin(product))}</div>` : ""}
      ${o.originNote && product.origin_note ? `<div class="note">${escapeHtml(product.origin_note)}</div>` : ""}
      ${o.stock ? `<div class="meta">Stock : ${escapeHtml(String(Number(product.stock_quantity)))} ${escapeHtml(product.unit_label)}</div>` : ""}
      ${codes(product).length ? `<div class="meta">${codes(product).map(escapeHtml).join(" · ")}</div>` : ""}
      ${!product.active ? `<div class="meta">Non proposé actuellement</div>` : ""}`;
  };
  const photo = (product: AdminProduct, size: "big" | "small") => !o.photo ? "" : product.image_url
    ? `<div class="photo ${size}" style="background-image:url('${escapeHtml(product.image_url)}')"></div>`
    : `<div class="photo ${size} empty">${escapeHtml(product.name.slice(0, 1).toUpperCase())}</div>`;

  const card = (product: AdminProduct) => `<div class="card">${photo(product, "big")}
      <div class="body"><div class="head"><div class="name">${escapeHtml(product.name)}</div>${priceBlock(product)}</div>${details(product)}</div></div>`;
  const row = (product: AdminProduct) => `<div class="row">${photo(product, "small")}
      <div class="body"><div class="name">${escapeHtml(product.name)}</div>${details(product)}</div>${priceBlock(product)}</div>`;
  const tableHead = `<tr><th>Produit</th>${o.unit ? "<th>Unité</th>" : ""}${o.sheet ? "<th>Fiche</th>" : ""}${o.origin ? "<th>Origine</th>" : ""}${o.reference || o.barcode || o.platformCode ? "<th>Codes</th>" : ""}${o.stock ? "<th class=\"num\">Stock</th>" : ""}${o.price ? "<th class=\"num\">Prix HT</th>" : ""}${o.priceTtc ? "<th class=\"num\">Prix TTC</th>" : ""}${o.vat ? "<th class=\"num\">TVA</th>" : ""}</tr>`;
  const tableRow = (product: AdminProduct) => `<tr><td><b>${escapeHtml(product.name)}</b>${o.description && product.description ? `<div class="meta">${escapeHtml(product.description)}</div>` : ""}</td>
      ${o.unit ? `<td>${escapeHtml(product.unit_label)}</td>` : ""}${o.sheet ? `<td>${sheetOf(product).map((item) => `${escapeHtml(item.label)} : ${escapeHtml(item.value)}`).join("<br/>")}</td>` : ""}
      ${o.origin ? `<td>${escapeHtml(origin(product))}</td>` : ""}${o.reference || o.barcode || o.platformCode ? `<td>${codes(product).map(escapeHtml).join("<br/>")}</td>` : ""}
      ${o.stock ? `<td class="num">${escapeHtml(String(Number(product.stock_quantity)))}</td>` : ""}${o.price ? `<td class="num">${pdfAmount(Number(product.price))}</td>` : ""}
      ${o.priceTtc ? `<td class="num">${pdfAmount(ttc(product))}</td>` : ""}${o.vat ? `<td class="num">${Number(product.vat_rate)} %</td>` : ""}</tr>`;
  const section = ([title, items]: [string, AdminProduct[]]) => `<section>
      ${title ? `<h2><span>${escapeHtml(title)}</span><small>${items.length} produit(s)</small></h2>` : ""}
      ${o.layout === "grid" ? `<div class="grid cols${o.columns}">${items.map(card).join("")}</div>`
        : o.layout === "list" ? items.map(row).join("")
        : `<table>${tableHead}${items.map(tableRow).join("")}</table>`}
    </section>`;

  const contact = [company.address, company.phone, company.email].filter(Boolean).map((item) => escapeHtml(item)).join(" · ");
  const today = new Date().toLocaleDateString("fr-TN", { day: "numeric", month: "long", year: "numeric" });
  const cover = !o.cover ? "" : `<div class="cover">
      <div class="band"></div>
      <div class="brand">${escapeHtml(company.name || "Appro+")}</div>
      ${company.tagline ? `<div class="tagline">${escapeHtml(company.tagline)}</div>` : ""}
      <h1>${escapeHtml(o.title || "Catalogue")}</h1>
      ${o.subtitle ? `<div class="subtitle">${escapeHtml(o.subtitle)}</div>` : ""}
      ${o.intro ? `<p class="intro">${escapeHtml(o.intro)}</p>` : ""}
      <div class="facts"><div><b>${list.length}</b> produit(s)</div><div><b>${groups.filter(([title]) => title).length || 1}</b> catégorie(s)</div><div>Édité le <b>${escapeHtml(today)}</b></div>
        ${o.validUntil ? `<div>Prix valables jusqu’au <b>${escapeHtml(o.validUntil)}</b></div>` : ""}</div>
      ${o.contact && contact ? `<div class="contact">${contact}${company.taxId ? `<br/>MF ${escapeHtml(company.taxId)}` : ""}</div>` : ""}
    </div>`;

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><style>
    @page{margin:14mm 12mm 16mm}
    *{box-sizing:border-box} body{font-family:Helvetica,Arial,sans-serif;color:#1d2939;margin:0;font-size:10.5px;line-height:1.4}
    .cover{min-height:250mm;display:flex;flex-direction:column;justify-content:center;padding:0 10mm;page-break-after:always;position:relative}
    .cover .band{position:absolute;top:0;left:0;right:0;height:14mm;background:${color}}
    .cover .brand{font-size:30px;font-weight:800;color:${color};letter-spacing:.5px}
    .cover .tagline{color:#667085;font-size:13px;margin-top:4px}
    .cover h1{font-size:46px;margin:34px 0 6px;color:#101828;line-height:1.05}
    .cover .subtitle{font-size:17px;color:${color};font-weight:600}
    .cover .intro{font-size:12.5px;color:#344054;max-width:150mm;margin-top:18px}
    .cover .facts{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:28px;padding-top:14px;border-top:2px solid ${color};font-size:12px;color:#475467}
    .cover .contact{margin-top:auto;padding-top:20px;font-size:11px;color:#667085}
    header.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid ${color};padding-bottom:6px;margin-bottom:6px}
    header.top .brand{font-weight:800;color:${color};font-size:15px} header.top .title{color:#667085;font-size:10px}
    h2{display:flex;justify-content:space-between;align-items:baseline;margin:18px 0 10px;padding:7px 10px;background:${color};color:#fff;border-radius:6px;font-size:13px;page-break-after:avoid}
    h2 small{font-weight:400;opacity:.85;font-size:10px}
    .grid{display:flex;flex-wrap:wrap;gap:10px}
    .grid .card{width:calc(50% - 5px);border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;page-break-inside:avoid;background:#fff}
    .grid.cols3 .card{width:calc(33.333% - 7px)}
    .photo{background-size:cover;background-position:center;background-color:#f2f4f7}
    .photo.big{height:38mm} .grid.cols3 .photo.big{height:30mm}
    .photo.small{width:20mm;height:20mm;border-radius:8px;flex:none}
    .photo.empty{display:flex;align-items:center;justify-content:center;color:${color};font-size:22px;font-weight:800;opacity:.55}
    .card .body{padding:8px 10px 10px} .head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
    .name{font-weight:700;font-size:12.5px;color:#101828}
    .price{text-align:right;white-space:nowrap} .price .amount{font-size:14px;font-weight:800;color:${color}} .price .second{font-size:11px;font-weight:700;color:#344054}
    .tax{font-size:9px;color:#667085;font-weight:600} .per{font-size:9px;color:#667085}
    .desc{margin:4px 0 0;color:#475467}
    .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px} .chip{background:#f2f4f7;border-radius:10px;padding:2px 7px;font-size:9px;color:#344054} .chip b{color:${color};font-weight:700}
    .origin{margin-top:5px;color:${color};font-size:9.5px;font-weight:600} .note{margin-top:2px;font-style:italic;color:#475467;font-size:9.5px}
    .meta{margin-top:3px;color:#667085;font-size:9px}
    .row{display:flex;gap:10px;align-items:flex-start;padding:8px 2px;border-bottom:1px solid #eaecf0;page-break-inside:avoid} .row .body{flex:1}
    table{width:100%;border-collapse:collapse;font-size:9.5px} th{background:#f2f4f7;color:${color};text-align:left;padding:6px;font-size:9px;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px;border-bottom:1px solid #eaecf0;vertical-align:top} tr{page-break-inside:avoid} .num{text-align:right;white-space:nowrap}
    footer.bottom{margin-top:16px;padding-top:6px;border-top:1px solid #eaecf0;color:#98a2b3;font-size:9px;display:flex;justify-content:space-between}
    ${o.pageNumbers ? "@page{@bottom-right{content:counter(page) ' / ' counter(pages);font-size:9px;color:#98a2b3}}" : ""}
  </style></head><body>
    ${cover}
    <header class="top"><div class="brand">${escapeHtml(company.name || "Catalogue")}</div><div class="title">${escapeHtml(o.title || "Catalogue")}${o.validUntil ? ` · prix valables jusqu’au ${escapeHtml(o.validUntil)}` : ""}</div></header>
    ${list.length ? groups.map(section).join("") : `<p>Aucun produit ne correspond à ces réglages.</p>`}
    <footer class="bottom"><span>${o.contact ? contact : ""}</span><span>${escapeHtml(today)}${o.price || o.priceTtc ? " · prix en TND" : ""}</span></footer>
  </body></html>`;
  await outputPdf(html, `${o.title || "Catalogue"}-${company.name || "catalogue"}`, o.title || "Catalogue");
}
