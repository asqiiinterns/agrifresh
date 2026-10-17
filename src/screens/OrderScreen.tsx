import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Category, Product } from "../types/product";
import type { ClientSummary } from "../data/account";
import { fetchCatalog } from "../data/catalog";
import { fetchMyOrders, placeClientOrder } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ProductImage, ScreenHeader, formatDay, formatPrice, formatQuantity, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Filter = Category | "Nouveautés";
const categories: Category[] = ["Tous", "Jus frais", "Fruits", "Légumes", "Épicerie"];
const draftKey = (clientId: string) => `agrifresh-order-draft-${clientId}`;

const parseQuantity = (value: string) => {
  const quantity = Number(value.replace(",", ".").trim());
  return Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity * 1000) / 1000 : 0;
};

function nextDays(count: number) {
  const days: string[] = [];
  const today = new Date();
  for (let offset = 0; offset < count; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    days.push(toDayKey(day));
  }
  return days;
}

export function OrderScreen({ client, onPlaced }: { client: ClientSummary; onPlaced: () => void }) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Filter>("Tous");
  const [reviewVisible, setReviewVisible] = useState(false);
  const [repeating, setRepeating] = useState(false);

  async function loadCatalog() {
    setLoading(true);
    setLoadError("");
    try {
      setCatalog(await fetchCatalog());
    } catch (cause) {
      setLoadError(errorMessage(cause, "Impossible de charger les produits."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadCatalog(); }, []);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(draftKey(client.id))
      .then((stored) => {
        if (!active || !stored) return;
        const parsed = JSON.parse(stored) as Record<string, string>;
        if (parsed && typeof parsed === "object") setQuantities(parsed);
      })
      .catch(() => {})
      .finally(() => { if (active) setDraftLoaded(true); });
    return () => { active = false; };
  }, [client.id]);

  useEffect(() => {
    if (!draftLoaded) return;
    void AsyncStorage.setItem(draftKey(client.id), JSON.stringify(quantities)).catch(() => {});
  }, [quantities, draftLoaded, client.id]);

  const lines = useMemo(() => catalog
    .map((product) => ({ product, quantity: parseQuantity(quantities[product.id] ?? "") }))
    .filter((line) => line.quantity > 0), [catalog, quantities]);
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    const matches = catalog.filter((product) => (category === "Tous" || product.category === category || (category === "Nouveautés" && product.isNew))
      && `${product.name} ${product.description}`.toLocaleLowerCase("fr").includes(term));
    // New arrivals come first so clients discover them while ordering.
    return [...matches].sort((a, b) => Number(Boolean(b.isNew)) - Number(Boolean(a.isNew)));
  }, [catalog, category, search]);

  function setQuantity(productId: string, value: string) {
    setQuantities((current) => {
      const next = { ...current };
      if (value.trim() === "") delete next[productId];
      else next[productId] = value.replace(/[^0-9.,]/g, "");
      return next;
    });
  }

  function step(productId: string, delta: number) {
    const nextValue = Math.max(0, parseQuantity(quantities[productId] ?? "") + delta);
    setQuantity(productId, nextValue > 0 ? String(nextValue) : "");
  }

  async function repeatLastOrder() {
    setRepeating(true);
    try {
      const [last] = await fetchMyOrders();
      if (!last) {
        notify("Aucune commande précédente", "Votre première commande servira de modèle la prochaine fois.");
        return;
      }
      const available = new Set(catalog.map((product) => product.id));
      const next: Record<string, string> = {};
      let skipped = 0;
      for (const line of last.order_items) {
        if (line.product_id && available.has(line.product_id)) next[line.product_id] = String(Number(line.quantity));
        else skipped += 1;
      }
      setQuantities(next);
      if (skipped) notify("Commande reprise", `${skipped} produit(s) de la commande #${last.order_number} ne sont plus disponibles.`);
    } catch (cause) {
      notify("Commande précédente", errorMessage(cause, "Impossible de charger votre dernière commande."));
    } finally {
      setRepeating(false);
    }
  }

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={client.business_name.toLocaleUpperCase("fr")}
      title="Commander"
      subtitle="Saisissez les quantités souhaitées pour chaque produit."
    />
    <View style={styles.toolbar}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit" placeholderTextColor={colors.muted} style={[ui.input, { flex: 1 }]} />
      <Button label={repeating ? "…" : "REPRENDRE LA DERNIÈRE"} variant="secondary" onPress={() => void repeatLastOrder()} busy={repeating} disabled={loading} />
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
      {catalog.some((product) => product.isNew) ? <Chip label="✦ Nouveautés" selected={category === "Nouveautés"} onPress={() => setCategory("Nouveautés")} /> : null}
      {categories.map((item) => <Chip key={item} label={item} selected={category === item} onPress={() => setCategory(item)} />)}
    </ScrollView>

    {loading ? <Loading label="Chargement des produits…" /> : loadError ? <EmptyState title="Catalogue indisponible" body={loadError} action={<Button label="RÉESSAYER" onPress={() => void loadCatalog()} />} /> : <FlatList
      data={visibleProducts}
      keyExtractor={(product) => product.id}
      contentContainerStyle={[ui.content, { paddingTop: 4 }]}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<EmptyState title="Aucun produit" body="Essayez une autre recherche ou une autre catégorie." />}
      renderItem={({ item }) => {
        const value = quantities[item.id] ?? "";
        const selected = parseQuantity(value) > 0;
        return <View style={[styles.productRow, selected && styles.productRowSelected]}>
          <ProductImage uri={item.image} style={styles.productImage} />
          <View style={{ flex: 1 }}>
            {item.isNew ? <Text style={styles.newBadge}>✦ NOUVEAU</Text> : null}
            <Text style={ui.strong} numberOfLines={2}>{item.name}</Text>
            {item.isNew && item.description ? <Text style={ui.small} numberOfLines={2}>{item.description}</Text> : null}
            <Text style={ui.small}>{formatPrice(item.price)} / {item.unit}</Text>
          </View>
          <View style={styles.stepper}>
            <Pressable onPress={() => step(item.id, -1)} style={styles.stepButton} accessibilityLabel={`Retirer une unité de ${item.name}`}><Text style={styles.stepText}>−</Text></Pressable>
            <TextInput
              value={value}
              onChangeText={(text) => setQuantity(item.id, text)}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.muted}
              style={styles.quantityInput}
              accessibilityLabel={`Quantité de ${item.name}`}
              selectTextOnFocus
            />
            <Pressable onPress={() => step(item.id, 1)} style={styles.stepButton} accessibilityLabel={`Ajouter une unité de ${item.name}`}><Text style={styles.stepText}>+</Text></Pressable>
          </View>
        </View>;
      }}
    />}

    <View style={styles.footer}>
      <View style={{ flex: 1 }}>
        <Text style={ui.small}>{lines.length} produit{lines.length > 1 ? "s" : ""}</Text>
        <Text style={ui.amount}>{formatPrice(total)}</Text>
      </View>
      {lines.length ? <Pressable onPress={() => setQuantities({})} style={{ padding: 8 }}><Text style={[ui.small, { textDecorationLine: "underline" }]}>Vider</Text></Pressable> : null}
      <Button label="VÉRIFIER ET ENVOYER" onPress={() => setReviewVisible(true)} disabled={!lines.length} />
    </View>

    <ReviewModal
      visible={reviewVisible}
      client={client}
      lines={lines}
      total={total}
      onClose={() => setReviewVisible(false)}
      onPlaced={() => {
        setQuantities({});
        setReviewVisible(false);
        onPlaced();
      }}
    />
  </View>;
}

function ReviewModal({ visible, client, lines, total, onClose, onPlaced }: {
  visible: boolean;
  client: ClientSummary;
  lines: { product: Product; quantity: number }[];
  total: number;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const points = client.delivery_points;
  const days = useMemo(() => nextDays(14), [visible]);
  const [pointId, setPointId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setPointId(points.length === 1 ? points[0].id : null);
    setError("");
  }, [visible, points]);

  async function submit() {
    if (points.length > 1 && !pointId) {
      setError("Choisissez le point de livraison.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const order = await placeClientOrder({
        items: lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
        deliveryPointId: pointId,
        requestedDate: day,
        note,
      });
      setNote("");
      setDay(null);
      notify("Commande envoyée", `Commande #${order.order_number} transmise à AgriFresh (${formatPrice(order.total)}). Vous serez informé de son acceptation.`);
      onPlaced();
    } catch (cause) {
      setError(errorMessage(cause, "La commande n’a pas pu être envoyée."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader eyebrow="RÉCAPITULATIF" title="Ma commande" right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <View style={ui.card}>
            {lines.map((line) => <View key={line.product.id} style={[ui.row, { paddingVertical: 5 }]}>
              <Text style={[ui.body, { flex: 1 }]}>{formatQuantity(line.quantity)} {line.product.unit} · {line.product.name}</Text>
              <Text style={ui.body}>{formatPrice(line.product.price * line.quantity)}</Text>
            </View>)}
            <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Total estimé</Text><Text style={ui.amount}>{formatPrice(total)}</Text></View>
            <Text style={[ui.small, { marginTop: 6 }]}>Les prix et le stock sont confirmés par AgriFresh à la réception.</Text>
          </View>

          {points.length > 1 ? <View style={ui.card}>
            <Text style={ui.strong}>Point de livraison</Text>
            <View style={{ gap: 8, marginTop: 10 }}>
              {points.map((point) => <Pressable key={point.id} onPress={() => setPointId(point.id)} style={[styles.pointOption, pointId === point.id && styles.pointOptionSelected]}>
                <Text style={[ui.strong, pointId === point.id && { color: colors.green }]}>{point.label}</Text>
                <Text style={ui.small}>{point.address_line}, {point.city}</Text>
              </Pressable>)}
            </View>
          </View> : null}

          <View style={ui.card}>
            <Text style={ui.strong}>Livraison souhaitée</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[ui.wrapRow, { flexWrap: "nowrap", marginTop: 10 }]}>
              <Chip label="Dès que possible" selected={day === null} onPress={() => setDay(null)} />
              {days.map((key, index) => <Chip key={key} label={index === 0 ? "Aujourd’hui" : index === 1 ? "Demain" : formatDay(key)} selected={day === key} onPress={() => setDay(key)} />)}
            </ScrollView>
            <Field label="Remarque (facultatif)" value={note} onChangeText={setNote} multiline placeholder="Horaires, consignes…" />
          </View>

          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="ENVOYER LA COMMANDE" onPress={() => void submit()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingTop: 12, alignItems: "center" },
  categories: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  productRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, marginTop: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
  productRowSelected: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  productImage: { width: 54, height: 54, borderRadius: 8 },
  newBadge: { color: colors.orange, fontSize: 9, fontWeight: "800", letterSpacing: 0.8, marginBottom: 2 },
  stepper: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.white },
  stepButton: { width: 34, height: 40, alignItems: "center", justifyContent: "center" },
  stepText: { color: colors.green, fontSize: 20, fontWeight: "700" },
  quantityInput: { width: 54, height: 40, textAlign: "center", color: colors.text, fontSize: 14, fontWeight: "700", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line, paddingVertical: 0 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  pointOption: { padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 8 },
  pointOptionSelected: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
});
