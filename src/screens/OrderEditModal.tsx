import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, TextInput } from "../ui/Text";
import { fetchBuyerCatalog, type BuyerSupplier } from "../data/catalog";
import { modifyOrder } from "../data/buyer";
import type { Order } from "../data/orders";
import type { Product } from "../types/product";
import { Button, CloseButton, EmptyState, Field, Loading, ScreenHeader, formatPrice } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { htTtc } from "../ui/price";
import { colors, ui } from "../ui/theme";

const parse = (value: string) => {
  const quantity = Number(value.replace(",", ".").trim());
  return Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity * 1000) / 1000 : 0;
};

// Changes an order the supplier has not accepted yet: quantities, lines removed or added (same supplier).
export function OrderEditModal({ order, onClose, onSaved }: { order: Order | null; onClose: () => void; onSaved: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [supplier, setSupplier] = useState<BuyerSupplier | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!order) return;
    setLoading(true);
    setError("");
    setSearch("");
    setNote(order.customer_note ?? "");
    setQuantities(Object.fromEntries(order.order_items.filter((line) => line.product_id).map((line) => [line.product_id as string, String(Number(line.quantity))])));
    void fetchBuyerCatalog()
      .then((catalog) => {
        setSupplier(catalog?.suppliers.find((item) => item.client_id === order.client_id) ?? null);
        setProducts((catalog?.products ?? []).filter((product) => product.supplierId === order.client_id));
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger les produits.")))
      .finally(() => setLoading(false));
  }, [order]);

  const term = search.trim().toLocaleLowerCase("fr");
  // Lines already in the order first, then the rest of the catalogue.
  const visible = useMemo(() => [...products]
    .filter((product) => !term || product.name.toLocaleLowerCase("fr").includes(term))
    .sort((a, b) => Number(parse(quantities[b.id] ?? "") > 0) - Number(parse(quantities[a.id] ?? "") > 0)), [products, term, quantities]);
  const lines = products.map((product) => ({ product, quantity: parse(quantities[product.id] ?? "") })).filter((line) => line.quantity > 0);
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function set(productId: string, value: string) {
    setQuantities((current) => ({ ...current, [productId]: value.replace(/[^0-9.,]/g, "") }));
  }
  function step(productId: string, delta: number) {
    const next = Math.max(0, parse(quantities[productId] ?? "") + delta);
    set(productId, next > 0 ? String(next) : "");
  }

  async function save() {
    if (!order || sending.current) return;
    if (!lines.length) {
      setError("La commande est vide : annulez-la plutôt.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await modifyOrder(order.id, lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })), note);
      notify("Commande modifiée", `La commande #${order.order_number} a été mise à jour. Votre fournisseur est prévenu.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "La commande n’a pas pu être modifiée."));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return <Modal visible={order !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={order ? `COMMANDE #${order.order_number}` : ""} title="Modifier la commande" subtitle={supplier ? `Chez ${supplier.name}, tant qu’elle n’est pas acceptée.` : undefined} right={<CloseButton onPress={onClose} />} />
      <View style={{ paddingHorizontal: 18, paddingTop: 10 }}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit" placeholderTextColor={colors.muted} style={ui.input} />
      </View>
      {loading ? <Loading /> : <FlatList
        data={visible}
        keyExtractor={(product) => product.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={ui.content}
        ListEmptyComponent={<EmptyState title="Aucun produit" body={error || "Ce fournisseur ne propose plus de produit."} />}
        renderItem={({ item }) => {
          const value = quantities[item.id] ?? "";
          return <View style={[styles.row, parse(value) > 0 && styles.selected]}>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong} numberOfLines={2}>{item.name}</Text>
              <Text style={ui.small}>{supplier?.show_prices ? `${htTtc(item.price, item.vatRate)} / ${item.unit}` : item.unit}</Text>
            </View>
            <View style={styles.stepper}>
              <Pressable onPress={() => step(item.id, -1)} style={styles.stepButton} accessibilityLabel={`Retirer une unité de ${item.name}`}><Text style={styles.stepText}>−</Text></Pressable>
              <TextInput value={value} onChangeText={(text) => set(item.id, text)} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.muted} style={styles.quantity} selectTextOnFocus />
              <Pressable onPress={() => step(item.id, 1)} style={styles.stepButton} accessibilityLabel={`Ajouter une unité de ${item.name}`}><Text style={styles.stepText}>+</Text></Pressable>
            </View>
          </View>;
        }}
        ListFooterComponent={<View>
          <Field label="Remarque (facultatif)" value={note} onChangeText={setNote} multiline placeholder="Horaires, consignes…" />
          {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
        </View>}
      />}
      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          <Text style={ui.small}>{`${lines.length} produit(s)`}</Text>
          {supplier?.show_prices && lines.length ? <Text style={ui.amount}>{formatPrice(total)} HT</Text> : null}
        </View>
        <Button label="ENREGISTRER" onPress={() => save()} busy={busy} disabled={loading} />
      </View>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, marginTop: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
  selected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  stepper: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.white },
  stepButton: { width: 34, height: 40, alignItems: "center", justifyContent: "center" },
  stepText: { color: colors.primary, fontSize: 20, fontWeight: "700" },
  quantity: { width: 54, height: 40, textAlign: "center", color: colors.text, fontSize: 14, fontWeight: "700", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line, paddingVertical: 0 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
});
