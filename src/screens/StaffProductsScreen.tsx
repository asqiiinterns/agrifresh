import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { VAT_RATES, fetchAdminProducts, fetchCategories, saveProduct, type AdminProduct, type Category, type ProductInput } from "../data/productAdmin";
import {
  allFields, catalogFieldLabels, catalogProducts, defaultCatalogOptions, fetchCatalogPresets, fetchImportHistory, importProducts, planImport, productsCsv, saveCatalogPresets, shareCatalogPdf,
  type CatalogOptions, type CatalogPreset, type ImportPlan, type ImportRecord,
} from "../data/productCatalog";
import { pickCsvText, parseCsv } from "../data/csvFile";
import { saveCsv } from "../data/exports";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ProductImage, ScreenHeader, formatDateTime, formatPrice, formatQuantity } from "../ui/components";
import { DocumentViewerHost } from "../ui/DocumentViewer";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Catalogue management for staff: prices, VAT, stock, availability, origin, identifiers and the product sheet;
// Excel/CSV export, import of a full or partial file with a preview and its history, catalogue PDF.
export function StaffProductsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AdminProduct | "new" | null>(null);
  const [plan, setPlan] = useState<{ file: string; plan: ImportPlan } | null>(null);
  const [history, setHistory] = useState(false);
  const [catalog, setCatalog] = useState(false);

  async function reload() {
    setError("");
    try {
      const [nextProducts, nextCategories] = await Promise.all([fetchAdminProducts(), fetchCategories()]);
      setProducts(nextProducts);
      setCategories(nextCategories);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les produits."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    void reload();
  }, [visible]);

  // Identifiers and sheets exist once 20261202 is run (the products then carry their Appro+ code).
  const extended = products.some((product) => product.platform_code);
  const visibleProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return products.filter((product) => `${product.name} ${product.origin_producer ?? ""} ${product.origin_region ?? ""} ${product.sku ?? ""} ${product.gtin ?? ""} ${product.platform_code ?? ""}`.toLocaleLowerCase("fr").includes(term));
  }, [products, search]);

  async function exportFile() {
    try { await saveCsv(`produits-${new Date().toISOString().slice(0, 10)}.csv`, productsCsv(products, categories)); }
    catch (cause) { notify("Export", errorMessage(cause, "Le fichier n’a pas pu être créé.")); }
  }
  async function importFile() {
    const file = await pickCsvText();
    if (!file) return;
    const rows = parseCsv(file.text);
    if (rows.length < 2) { notify("Import", "Le fichier est vide : partez d’un fichier exporté (EXPORTER)."); return; }
    setPlan({ file: file.name, plan: planImport(rows, products, categories) });
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={`${products.length} PRODUITS`} title="Produits" right={<View style={[ui.row, { gap: 8 }]}><Button label="+ NOUVEAU" onPress={() => setEditing("new")} /><CloseButton onPress={onClose} /></View>} />
      <View style={[ui.wrapRow, { paddingHorizontal: 18, paddingTop: 10 }]}>
        <Button label="EXPORTER (EXCEL)" variant="secondary" onPress={exportFile} disabled={!products.length} />
        <Button label="IMPORTER" variant="secondary" onPress={importFile} />
        {extended ? <Button label="HISTORIQUE DES IMPORTS" variant="secondary" onPress={() => setHistory(true)} /> : null}
        <Button label="CATALOGUE PDF" variant="secondary" onPress={() => setCatalog(true)} disabled={!products.length} />
      </View>
      <View style={{ paddingHorizontal: 18, paddingTop: 10 }}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit, une référence, un producteur" placeholderTextColor={colors.muted} style={ui.input} />
      </View>
      {loading ? <Loading /> : <FlatList
        data={visibleProducts}
        keyExtractor={(product) => product.id}
        contentContainerStyle={ui.content}
        ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        ListEmptyComponent={error ? null : <EmptyState title="Aucun produit" />}
        renderItem={({ item }) => <Pressable style={[ui.card, ui.row, !item.active && ui.disabled]} onPress={() => setEditing(item)}>
          <ProductImage uri={item.image_url ?? ""} style={{ width: 48, height: 48, borderRadius: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>{item.name}{item.active ? "" : " (inactif)"}</Text>
            <Text style={ui.small}>{formatPrice(item.price)} HT / {item.unit_label} · TVA {Number(item.vat_rate)} % · stock {formatQuantity(item.stock_quantity)}</Text>
            {item.sku || item.platform_code ? <Text style={ui.small}>{[item.sku ? `Réf. ${item.sku}` : "", item.gtin ? `EAN ${item.gtin}` : "", item.platform_code ?? ""].filter(Boolean).join(" · ")}</Text> : null}
            {item.origin_producer || item.origin_region ? <Text style={[ui.small, { color: colors.primary }]}>Origine : {[item.origin_producer, item.origin_region, item.origin_label].filter(Boolean).join(" · ")}</Text> : <Text style={[ui.small, { color: colors.amber }]}>Origine non renseignée</Text>}
          </View>
        </Pressable>}
      />}
      <ProductEditor product={editing === "new" ? null : editing} visible={editing !== null} categories={categories} extended={extended} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
      <ImportModal target={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); void reload(); }} />
      <HistoryModal visible={history} onClose={() => setHistory(false)} />
      <CatalogModal visible={catalog} products={products} categories={categories} onClose={() => setCatalog(false)} />
      <DocumentViewerHost />
    </SafeAreaView>
  </Modal>;
}

const toNumber = (value: string) => Number(value.replace(",", ".").trim());
type TextFields = "name" | "description" | "image_url" | "unit_label" | "price" | "stock_quantity" | "origin_producer" | "origin_region" | "origin_label" | "origin_note" | "sku" | "gtin";

function ProductEditor({ product, visible, categories, extended, onClose, onSaved }: {
  product: AdminProduct | null;
  visible: boolean;
  categories: Category[];
  extended: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<TextFields, string>>({
    name: "", description: "", image_url: "", unit_label: "", price: "", stock_quantity: "",
    origin_producer: "", origin_region: "", origin_label: "", origin_note: "", sku: "", gtin: "",
  });
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [vatRate, setVatRate] = useState(0);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setForm({
      name: product?.name ?? "",
      description: product?.description ?? "",
      image_url: product?.image_url ?? "",
      unit_label: product?.unit_label ?? "kg",
      price: product ? String(Number(product.price)) : "",
      stock_quantity: product ? String(Number(product.stock_quantity)) : "0",
      origin_producer: product?.origin_producer ?? "",
      origin_region: product?.origin_region ?? "",
      origin_label: product?.origin_label ?? "",
      origin_note: product?.origin_note ?? "",
      sku: product?.sku ?? "",
      gtin: product?.gtin ?? "",
    });
    setAttributes(product?.attributes ?? {});
    setCategoryId(product?.category_id ?? categories[0]?.id ?? null);
    setVatRate(Number(product?.vat_rate ?? 0));
    setActive(product?.active ?? true);
    setError("");
  }, [visible, product?.id]);

  const set = (key: TextFields) => (text: string) => setForm((current) => ({ ...current, [key]: text }));
  // The product sheet of the chosen category (Appro+ template): choices from a list, numbers or text.
  const fields = categories.find((item) => item.id === categoryId)?.fields ?? [];
  const setAttribute = (key: string, value: string) => setAttributes((current) => ({ ...current, [key]: value }));

  async function save() {
    const price = toNumber(form.price);
    const stock = toNumber(form.stock_quantity);
    if (!form.name.trim() || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
      setError("Renseignez le nom, un prix et un stock valides.");
      return;
    }
    const gtin = form.gtin.replace(/\s/g, "");
    if (gtin && !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin)) {
      setError("Code-barres invalide : 8, 12, 13 ou 14 chiffres.");
      return;
    }
    const sheet = Object.fromEntries(Object.entries(attributes).filter(([, value]) => value.trim() !== "").map(([key, value]) => [key, value.trim()]));
    setBusy(true);
    setError("");
    try {
      const { sku, gtin: _gtin, ...rest } = form;
      const input: ProductInput = { ...rest, category_id: categoryId, vat_rate: vatRate, active, price, stock_quantity: stock, ...(extended ? { sku, gtin, attributes: sheet } : {}) };
      await saveProduct(product?.id ?? null, input);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Le produit n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader eyebrow={product ? "MODIFIER" : "NOUVEAU PRODUIT"} title={product?.name ?? "Produit"} subtitle={product?.platform_code ? `Code Appro+ ${product.platform_code}` : undefined} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <View style={ui.card}>
            <Text style={ui.strong}>Produit</Text>
            <Field label="Nom" value={form.name} onChangeText={set("name")} />
            <Field label="Description" value={form.description} onChangeText={set("description")} multiline />
            <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Catégorie</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>{categories.map((category) => <Chip key={category.id} label={category.name} selected={categoryId === category.id} onPress={() => setCategoryId(category.id)} />)}</View>
            <Field label="Unité de vente (kg, caisse 10 kg, bouteille 1 L…)" value={form.unit_label} onChangeText={set("unit_label")} />
            <Field label="Prix HT (TND)" value={form.price} onChangeText={set("price")} keyboardType="decimal-pad" />
            <Text style={[ui.fieldLabel, { marginTop: 12 }]}>TVA</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>{VAT_RATES.map((rate) => <Chip key={rate} label={`${rate} %`} selected={vatRate === rate} onPress={() => setVatRate(rate)} />)}</View>
            <Field label="Stock disponible" value={form.stock_quantity} onChangeText={set("stock_quantity")} keyboardType="decimal-pad" />
            <Field label="Lien de la photo (facultatif)" value={form.image_url} onChangeText={set("image_url")} autoCapitalize="none" />
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 12 }]}>
              <Switch value={active} onValueChange={setActive} trackColor={{ true: colors.primary, false: colors.line }} />
              <Text style={ui.body}>Proposé à la commande</Text>
            </View>
          </View>

          {extended ? <View style={ui.card}>
            <Text style={ui.strong}>Identifiants</Text>
            <Text style={ui.small}>Votre référence (unique dans votre catalogue) et le code-barres retrouvent le produit lors d’un import. Le code Appro+ est attribué automatiquement.</Text>
            <Field label="Référence (facultatif)" value={form.sku} onChangeText={set("sku")} autoCapitalize="characters" maxLength={40} />
            <Field label="Code-barres EAN / GTIN (facultatif)" value={form.gtin} onChangeText={set("gtin")} keyboardType="number-pad" maxLength={14} />
          </View> : null}

          {extended && fields.length ? <View style={ui.card}>
            <Text style={ui.strong}>Fiche produit</Text>
            <Text style={ui.small}>Les champs de cette catégorie, proposés par Appro+ pour que les produits soient comparables entre fournisseurs.</Text>
            {fields.map((field) => field.type === "list" ? <View key={field.key}>
              <Text style={[ui.fieldLabel, { marginTop: 12 }]}>{field.label}</Text>
              <View style={[ui.wrapRow, { marginTop: 6 }]}>
                {(field.options ?? []).map((option) => <Chip key={option} label={option} selected={attributes[field.key] === option} onPress={() => setAttribute(field.key, attributes[field.key] === option ? "" : option)} />)}
              </View>
            </View> : <Field key={field.key} label={`${field.label}${field.unit ? ` (${field.unit})` : ""}`} value={attributes[field.key] ?? ""} onChangeText={(value) => setAttribute(field.key, value)}
              keyboardType={field.type === "number" ? "decimal-pad" : "default"} />)}
          </View> : null}

          <View style={ui.card}>
            <Text style={ui.strong}>Origine et qualité</Text>
            <Text style={ui.small}>Affichée aux clients dont la fiche active « Afficher l’origine des produits », et figée sur chaque commande pour la traçabilité.</Text>
            <Field label="Producteur / exploitation" value={form.origin_producer} onChangeText={set("origin_producer")} />
            <Field label="Région" value={form.origin_region} onChangeText={set("origin_region")} />
            <Field label="Label ou démarche (Bio, AOP, agriculture raisonnée…)" value={form.origin_label} onChangeText={set("origin_label")} />
            <Field label="Note qualité (récolte, variété, savoir-faire…)" value={form.origin_note} onChangeText={set("origin_note")} multiline />
          </View>

          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="ENREGISTRER" onPress={() => save()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

// Preview of an import: what each line changes (before → after), lines ignored and why; nothing is saved before « Appliquer ».
function ImportModal({ target, onClose, onDone }: { target: { file: string; plan: ImportPlan } | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); }, [target?.file]);
  if (!target) return null;
  const { plan } = target;
  const count = (kind: string) => plan.lines.filter((line) => line.kind === kind).length;
  const applicable = count("new") + count("update");
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await importProducts(target!.file, plan.rows);
      notify("Import", `${result.created} produit(s) créé(s), ${result.updated} mis à jour, ${result.unchanged} inchangé(s)${result.ignored.length ? `, ${result.ignored.length} ligne(s) ignorée(s) :\n${result.ignored.slice(0, 5).map((item) => `ligne ${item.line} : ${item.reason}`).join("\n")}` : "."}`);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "L’import n’a pas pu être appliqué. La migration 20261202 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="IMPORT · APERÇU" title={target.file} subtitle={`${count("new")} nouveau(x) · ${count("update")} modifié(s) · ${count("same")} inchangé(s) · ${count("ignored")} ignoré(s)`} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content}>
        <Text style={[ui.small, { marginTop: 8 }]}>Colonnes lues : {plan.columns.join(", ") || "aucune"}. Seules ces colonnes changent ; les autres informations des produits sont conservées.{plan.unknownColumns.length ? ` Colonnes ignorées : ${plan.unknownColumns.join(", ")}.` : ""}</Text>
        {plan.lines.filter((line) => line.kind !== "same").map((line) => <View key={line.line} style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>{line.name}</Text>
            <Text style={[ui.small, { fontWeight: "800", color: line.kind === "new" ? colors.primary : line.kind === "ignored" ? colors.danger : colors.amber }]}>
              {line.kind === "new" ? "NOUVEAU" : line.kind === "ignored" ? "IGNORÉ" : "MODIFIÉ"} · ligne {line.line}
            </Text>
          </View>
          {line.reason ? <Text style={[ui.small, { color: colors.danger }]}>{line.reason}</Text> : null}
          {line.changes.map((change, index) => <Text key={index} style={ui.small}>{change.label} : {change.from || "—"} → <Text style={{ fontWeight: "800", color: colors.text }}>{change.to || "—"}</Text></Text>)}
        </View>)}
        {!applicable ? <Text style={[ui.body, { marginTop: 12 }]}>Le fichier ne change rien.</Text> : null}
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <View style={[ui.wrapRow, { marginTop: 14 }]}>
          <Button label={`APPLIQUER (${applicable})`} onPress={apply} busy={busy} disabled={!applicable} />
          <Button label="ANNULER" variant="secondary" onPress={onClose} disabled={busy} />
        </View>
        <Text style={[ui.small, { marginTop: 6 }]}>L’import est conservé dans l’historique avec chaque modification (avant / après).</Text>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const historyLabels: Record<string, string> = { name: "Nom", price: "Prix HT", vat_rate: "TVA", stock_quantity: "Stock", active: "Actif", unit_label: "Unité", description: "Description",
  category_id: "Catégorie", sku: "Référence", gtin: "Code-barres", origin_producer: "Producteur", origin_region: "Région", origin_label: "Label", origin_note: "Note qualité", attributes: "Fiche produit" };
const show = (value: unknown) => value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? Object.values(value as Record<string, unknown>).join(", ") : String(value);

function HistoryModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [list, setList] = useState<ImportRecord[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    setList(null);
    void fetchImportHistory().then(setList).catch((cause: unknown) => { setError(errorMessage(cause, "Historique indisponible.")); setList([]); });
  }, [visible]);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="PRODUITS" title="Historique des imports" right={<CloseButton onPress={onClose} />} />
      {!list ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
        {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
        {!list.length && !error ? <EmptyState title="Aucun import" body="Chaque import de fichier apparaîtra ici avec ce qu’il a changé." /> : null}
        {list.map((item) => <Pressable key={item.id} onPress={() => setOpen(open === item.id ? null : item.id)} style={ui.card}>
          <Text style={ui.strong}>{item.file_name || "Fichier"}</Text>
          <Text style={ui.small}>{formatDateTime(item.imported_at)} · {item.by ?? "—"} · {item.created} créé(s), {item.updated} modifié(s), {item.unchanged} inchangé(s), {item.ignored} ignoré(s)</Text>
          {open === item.id ? item.changes.map((change, index) => <View key={index} style={{ marginTop: 6 }}>
            <Text style={ui.body}>{change.created ? "＋ " : "✎ "}{change.name}</Text>
            {Object.keys(change.after).filter((key) => historyLabels[key]).map((key) => <Text key={key} style={ui.small}>
              {historyLabels[key]} : {change.created ? "" : `${show(change.before[key])} → `}{show(change.after[key])}
            </Text>)}
          </View>) : <Text style={[ui.small, { color: colors.primary }]}>Touchez pour voir le détail</Text>}
        </Pressable>)}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

// The catalogue PDF: layout, cover page, fields shown (each field of the product sheet too), categories and sorting;
// presets saved for the Pro, one marked as the default.
function CatalogModal({ visible, products, categories, onClose }: { visible: boolean; products: AdminProduct[]; categories: Category[]; onClose: () => void }) {
  const [options, setOptions] = useState<CatalogOptions>(defaultCatalogOptions);
  const [presets, setPresets] = useState<CatalogPreset[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    void fetchCatalogPresets().then((list) => {
      setPresets(list);
      const preferred = list?.find((item) => item.default);
      setOptions(preferred ? { ...defaultCatalogOptions, ...preferred.options } : defaultCatalogOptions);
    });
  }, [visible]);
  const set = <K extends keyof CatalogOptions>(key: K, value: CatalogOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));
  const usedCategories = categories.filter((category) => products.some((product) => product.category_id === category.id));
  const fields = allFields(usedCategories);
  const count = catalogProducts(products, categories, options).length;
  const toggleIn = (list: string[] | null, all: string[], key: string) => {
    const current = list ?? all;
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
    return next.length === all.length ? null : next;
  };

  async function storePresets(next: CatalogPreset[]) {
    try { await saveCatalogPresets(next); setPresets(next); } catch (cause) { notify("Catalogue", errorMessage(cause, "Le modèle n’a pas pu être enregistré.")); }
  }
  async function generate() {
    setBusy(true);
    try { await shareCatalogPdf(products, categories, options); } catch (cause) { notify("Catalogue", errorMessage(cause, "Impossible de générer le PDF.")); } finally { setBusy(false); }
  }
  const toggleRow = (key: keyof CatalogOptions, label: string, hint?: string) => <View key={key} style={[ui.row, { justifyContent: "flex-start", marginTop: 8 }]}>
    <Switch value={!!options[key]} onValueChange={(value) => set(key, value as never)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
    <View style={{ flex: 1 }}>
      <Text style={ui.body}>{label}</Text>
      {hint ? <Text style={ui.small}>{hint}</Text> : null}
    </View>
  </View>;

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="PRODUITS" title="Catalogue PDF" subtitle={`${count} produit(s) avec ces réglages`} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {presets?.length ? <View style={ui.card}>
          <Text style={ui.strong}>Modèles enregistrés</Text>
          {presets.map((preset) => <View key={preset.name} style={[ui.row, { marginTop: 6 }]}>
            <Chip label={`${preset.default ? "★ " : ""}${preset.name}`} selected={JSON.stringify({ ...defaultCatalogOptions, ...preset.options }) === JSON.stringify(options)} onPress={() => setOptions({ ...defaultCatalogOptions, ...preset.options })} />
            <View style={{ flex: 1 }} />
            {!preset.default ? <Button label="PAR DÉFAUT" variant="secondary" onPress={() => void storePresets(presets.map((item) => ({ ...item, default: item.name === preset.name })))} /> : null}
            <Button label="SUPPRIMER" variant="secondary" onPress={() => void storePresets(presets.filter((item) => item.name !== preset.name))} />
          </View>)}
        </View> : null}

        <View style={ui.card}>
          <Text style={ui.strong}>Mise en page</Text>
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            <Chip label="Fiches illustrées (grille)" selected={options.layout === "grid"} onPress={() => set("layout", "grid")} />
            <Chip label="Liste détaillée" selected={options.layout === "list"} onPress={() => set("layout", "list")} />
            <Chip label="Tarif compact (tableau)" selected={options.layout === "table"} onPress={() => set("layout", "table")} />
          </View>
          {options.layout === "grid" ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
            <Chip label="2 par ligne" selected={options.columns === 2} onPress={() => set("columns", 2)} />
            <Chip label="3 par ligne" selected={options.columns === 3} onPress={() => set("columns", 3)} />
          </View> : null}
          {toggleRow("groupByCategory", "Classer par catégorie", "Un bandeau de couleur par catégorie.")}
          <Text style={[ui.fieldLabel, { marginTop: 10 }]}>Ordre</Text>
          <View style={[ui.wrapRow, { marginTop: 6 }]}>
            <Chip label="Catégories" selected={options.sort === "category"} onPress={() => set("sort", "category")} />
            <Chip label="Nom" selected={options.sort === "name"} onPress={() => set("sort", "name")} />
            <Chip label="Prix croissant" selected={options.sort === "price"} onPress={() => set("sort", "price")} />
            <Chip label="Prix décroissant" selected={options.sort === "priceDesc"} onPress={() => set("sort", "priceDesc")} />
          </View>
          <Text style={[ui.small, { marginTop: 8 }]}>Les couleurs et le nom viennent de Paramétrage → Entreprise.</Text>
        </View>

        <View style={ui.card}>
          <Text style={ui.strong}>Page de garde et en-tête</Text>
          {toggleRow("cover", "Page de garde")}
          <Field label="Titre" value={options.title} onChangeText={(value) => set("title", value)} placeholder="Catalogue printemps 2026" maxLength={60} />
          {options.cover ? <>
            <Field label="Sous-titre (facultatif)" value={options.subtitle} onChangeText={(value) => set("subtitle", value)} placeholder="Fruits et légumes de saison" maxLength={80} />
            <Field label="Texte de présentation (facultatif)" value={options.intro} onChangeText={(value) => set("intro", value)} multiline maxLength={600} />
          </> : null}
          <Field label="Prix valables jusqu’au (facultatif)" value={options.validUntil} onChangeText={(value) => set("validUntil", value)} placeholder="30/11/2026" maxLength={30} />
          {toggleRow("contact", "Coordonnées de l’entreprise", "Adresse, téléphone, e-mail, matricule fiscal.")}
          {toggleRow("pageNumbers", "Numéros de page")}
        </View>

        <View style={ui.card}>
          <Text style={ui.strong}>Champs à inclure</Text>
          {(Object.keys(catalogFieldLabels) as (keyof CatalogOptions)[]).map((key) => toggleRow(key, catalogFieldLabels[key] ?? key))}
          {options.sheet && fields.length ? <>
            <Text style={[ui.fieldLabel, { marginTop: 10 }]}>Champs de la fiche produit</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              {fields.map((field) => <Chip key={field.key} label={field.label} selected={!options.sheetFields || options.sheetFields.includes(field.key)}
                onPress={() => set("sheetFields", toggleIn(options.sheetFields, fields.map((item) => item.key), field.key))} />)}
            </View>
          </> : null}
        </View>

        <View style={ui.card}>
          <Text style={ui.strong}>Produits</Text>
          {usedCategories.length > 1 ? <>
            <Text style={[ui.fieldLabel, { marginTop: 8 }]}>Catégories</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              {usedCategories.map((category) => <Chip key={category.id} label={category.name} selected={!options.categories || options.categories.includes(category.id)}
                onPress={() => set("categories", toggleIn(options.categories, usedCategories.map((item) => item.id), category.id))} />)}
            </View>
          </> : null}
          {toggleRow("inStockOnly", "Seulement les produits en stock")}
          {toggleRow("inactive", "Inclure les produits non proposés")}
        </View>

        <Button label={`GÉNÉRER LE CATALOGUE (${count})`} onPress={generate} busy={busy} disabled={!count} style={{ marginTop: 14 }} />
        {presets !== null ? <View style={[ui.card, { marginTop: 14 }]}>
          <Text style={ui.strong}>Enregistrer ces réglages comme modèle</Text>
          <Field label="Nom du modèle" value={name} onChangeText={setName} placeholder="Clients restaurants" maxLength={40} />
          <Button label="ENREGISTRER LE MODÈLE" variant="secondary" disabled={!name.trim() || presets.length >= 10} style={{ marginTop: 8 }}
            onPress={() => { void storePresets([...presets.filter((item) => item.name !== name.trim()), { name: name.trim(), options, default: presets.length === 0 }]); setName(""); }} />
        </View> : null}
      </ScrollView>
      <DocumentViewerHost />
    </SafeAreaView>
  </Modal>;
}
