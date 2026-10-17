import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { VAT_RATES, fetchAdminProducts, fetchCategories, saveProduct, type AdminProduct, type Category, type ProductInput } from "../data/productAdmin";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ProductImage, ScreenHeader, formatPrice, formatQuantity } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Catalogue management for staff: prices, VAT, stock, availability and origin (traceability).
export function StaffProductsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AdminProduct | "new" | null>(null);

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

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return products.filter((product) => `${product.name} ${product.origin_producer ?? ""} ${product.origin_region ?? ""}`.toLocaleLowerCase("fr").includes(term));
  }, [products, search]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={`${products.length} PRODUITS`} title="Produits" right={<View style={[ui.row, { gap: 8 }]}><Button label="+ NOUVEAU" onPress={() => setEditing("new")} /><CloseButton onPress={onClose} /></View>} />
      <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit, producteur, région" placeholderTextColor={colors.muted} style={ui.input} />
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
            {item.origin_producer || item.origin_region ? <Text style={[ui.small, { color: colors.green }]}>Origine : {[item.origin_producer, item.origin_region, item.origin_label].filter(Boolean).join(" · ")}</Text> : <Text style={[ui.small, { color: colors.amber }]}>Origine non renseignée</Text>}
          </View>
        </Pressable>}
      />}
      <ProductEditor product={editing === "new" ? null : editing} visible={editing !== null} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
    </SafeAreaView>
  </Modal>;
}

const toNumber = (value: string) => Number(value.replace(",", ".").trim());

function ProductEditor({ product, visible, categories, onClose, onSaved }: {
  product: AdminProduct | null;
  visible: boolean;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<keyof Omit<ProductInput, "category_id" | "vat_rate" | "active">, string>>({
    name: "", description: "", image_url: "", unit_label: "", price: "", stock_quantity: "",
    origin_producer: "", origin_region: "", origin_label: "", origin_note: "",
  });
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
    });
    setCategoryId(product?.category_id ?? categories[0]?.id ?? null);
    setVatRate(Number(product?.vat_rate ?? 0));
    setActive(product?.active ?? true);
    setError("");
  }, [visible, product?.id]);

  const set = (key: keyof typeof form) => (text: string) => setForm((current) => ({ ...current, [key]: text }));

  async function save() {
    const price = toNumber(form.price);
    const stock = toNumber(form.stock_quantity);
    if (!form.name.trim() || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
      setError("Renseignez le nom, un prix et un stock valides.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveProduct(product?.id ?? null, { ...form, category_id: categoryId, vat_rate: vatRate, active, price, stock_quantity: stock });
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
        <ScreenHeader eyebrow={product ? "MODIFIER" : "NOUVEAU PRODUIT"} title={product?.name ?? "Produit"} right={<CloseButton onPress={onClose} />} />
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
            <View style={[ui.row, { marginTop: 12 }]}>
              <Text style={ui.body}>Proposé à la commande</Text>
              <Switch value={active} onValueChange={setActive} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Origine et qualité</Text>
            <Text style={ui.small}>Affichée aux clients dont la fiche active « Afficher l’origine des produits », et figée sur chaque commande pour la traçabilité.</Text>
            <Field label="Producteur / exploitation" value={form.origin_producer} onChangeText={set("origin_producer")} />
            <Field label="Région" value={form.origin_region} onChangeText={set("origin_region")} />
            <Field label="Label ou démarche (Bio, AOP, agriculture raisonnée…)" value={form.origin_label} onChangeText={set("origin_label")} />
            <Field label="Note qualité (récolte, variété, savoir-faire…)" value={form.origin_note} onChangeText={set("origin_note")} multiline />
          </View>

          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="ENREGISTRER" onPress={() => void save()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
