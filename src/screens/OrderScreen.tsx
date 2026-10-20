import { useEffect, useMemo, useState, useRef } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Category, Product } from "../types/product";
import type { ClientSummary } from "../data/account";
import { fetchBuyerCatalog, fetchCatalog, type BuyerSupplier } from "../data/catalog";
import { fetchMyOrders, formatOrigin, placeClientOrder, placeMultiOrder, type Order } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ProductImage, ScreenHeader, formatDay, formatPrice, formatQuantity, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { useDisplay } from "../ui/display";

type Filter = Category | "Nouveautés";
const categories: Category[] = ["Tous", "Jus frais", "Fruits", "Légumes", "Épicerie"];
const draftKey = (clientId: string) => `agrifresh-order-draft-${clientId}`;
// One cart for all the suppliers of the buyer's Pro.
const cartKey = (buyerOrgId: string) => `appro-cart-${buyerOrgId}`;
type DisplayRules = Pick<ClientSummary, "show_prices" | "show_stock" | "show_origin">;

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

type PlaceOrder = typeof placeClientOrder;

// The client's own order screen; the team reuses it to order for a client (staffFor set):
// same catalogue and quantities, sent with the team's function, history of that client.
export function OrderScreen({ client, onPlaced, placeOrder = placeClientOrder, loadHistory = fetchMyOrders, staffFor }: {
  client: ClientSummary;
  onPlaced: () => void;
  placeOrder?: PlaceOrder;
  loadHistory?: () => Promise<Order[]>;
  staffFor?: { onBack: () => void };
}) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Filter>("Tous");
  const [reviewVisible, setReviewVisible] = useState(false);
  const [repeatVisible, setRepeatVisible] = useState(false);
  const { compactProducts } = useDisplay();
  // Buyer side: every supplier of the Pro on the same screen (empty: single-supplier catalogue).
  const [suppliers, setSuppliers] = useState<BuyerSupplier[]>([]);
  const [buyerOrgId, setBuyerOrgId] = useState<string | null>(null);
  const [supplierFilter, setSupplierFilter] = useState<string>("all");

  async function loadCatalog() {
    setLoading(true);
    setLoadError("");
    try {
      const buyer = staffFor ? null : await fetchBuyerCatalog();
      if (buyer && buyer.suppliers.length && buyer.buyerOrgId) {
        setSuppliers(buyer.suppliers);
        setBuyerOrgId(buyer.buyerOrgId);
        setCatalog(buyer.products);
        return;
      }
      setSuppliers([]);
      setCatalog(await fetchCatalog());
    } catch (cause) {
      setLoadError(errorMessage(cause, "Impossible de charger les produits."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadCatalog(); }, []);

  const storageKey = suppliers.length && buyerOrgId ? cartKey(buyerOrgId) : draftKey(client.id);
  useEffect(() => {
    if (loading) return;
    let active = true;
    setDraftLoaded(false);
    void AsyncStorage.getItem(storageKey)
      .then((stored) => {
        if (!active || !stored) return;
        const parsed = JSON.parse(stored) as Record<string, string>;
        if (parsed && typeof parsed === "object") setQuantities(parsed);
      })
      .catch(() => {})
      .finally(() => { if (active) setDraftLoaded(true); });
    return () => { active = false; };
  }, [storageKey, loading]);

  useEffect(() => {
    if (!draftLoaded) return;
    void AsyncStorage.setItem(storageKey, JSON.stringify(quantities)).catch(() => {});
  }, [quantities, draftLoaded, storageKey]);

  const multi = suppliers.length > 1;
  const supplierById = useMemo(() => new Map(suppliers.map((supplier) => [supplier.client_id, supplier])), [suppliers]);
  // What each supplier lets this client see (prices, stock, origin).
  const rulesOf = (product: Product): DisplayRules => (product.supplierId ? supplierById.get(product.supplierId) : undefined) ?? client;

  const lines = useMemo(() => catalog
    .map((product) => ({ product, quantity: parseQuantity(quantities[product.id] ?? "") }))
    .filter((line) => line.quantity > 0), [catalog, quantities]);
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const priced = lines.every((line) => rulesOf(line.product).show_prices);
  const cartSuppliers = new Set(lines.map((line) => line.product.supplierId)).size;
  const inCart = (supplierId: string) => lines.filter((line) => line.product.supplierId === supplierId).length;

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    const matches = catalog.filter((product) => (supplierFilter === "all" || product.supplierId === supplierFilter)
      && (category === "Tous" || product.category === category || (category === "Nouveautés" && product.isNew))
      && `${product.name} ${product.description}`.toLocaleLowerCase("fr").includes(term));
    // New arrivals come first so clients discover them while ordering.
    return [...matches].sort((a, b) => Number(Boolean(b.isNew)) - Number(Boolean(a.isNew)));
  }, [catalog, category, search, supplierFilter]);

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

  // Fills the cart from one or several previous orders (quantities are added up).
  function fillFromOrders(orders: Order[]) {
    const available = new Set(catalog.map((product) => product.id));
    const totals: Record<string, number> = {};
    let skipped = 0;
    for (const order of orders) {
      for (const line of order.order_items) {
        if (line.product_id && available.has(line.product_id)) totals[line.product_id] = (totals[line.product_id] ?? 0) + Number(line.quantity);
        else skipped += 1;
      }
    }
    setQuantities(Object.fromEntries(Object.entries(totals).map(([id, quantity]) => [id, String(Math.round(quantity * 1000) / 1000)])));
    setRepeatVisible(false);
    if (skipped) notify("Panier rempli", `${skipped} ligne(s) ne sont plus disponibles et n’ont pas été reprises.`);
  }

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={staffFor ? "COMMANDE POUR LE CLIENT" : client.business_name.toLocaleUpperCase("fr")}
      title={staffFor ? client.business_name : "Commander"}
      subtitle={multi ? "Tous vos fournisseurs dans un seul panier : chacun reçoit sa propre commande." : "Saisissez les quantités souhaitées pour chaque produit."}
      right={staffFor ? <Button label="‹ CLIENTS" variant="secondary" onPress={staffFor.onBack} /> : undefined}
    />
    <View style={styles.toolbar}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit" placeholderTextColor={colors.muted} style={[ui.input, { flex: 1 }]} />
      <Button label="REPRENDRE" variant="secondary" onPress={() => setRepeatVisible(true)} disabled={loading} />
    </View>
    {multi ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suppliers} style={{ flexGrow: 0 }}>
      <Chip label="Tous les fournisseurs" selected={supplierFilter === "all"} onPress={() => setSupplierFilter("all")} />
      {suppliers.map((supplier) => <Chip key={supplier.client_id} label={inCart(supplier.client_id) ? `${supplier.name} (${inCart(supplier.client_id)})` : supplier.name} selected={supplierFilter === supplier.client_id} onPress={() => setSupplierFilter(supplier.client_id)} />)}
    </ScrollView> : null}
    <View style={styles.categories}>
      {catalog.some((product) => product.isNew) ? <Chip label="✦ Nouveautés" selected={category === "Nouveautés"} onPress={() => setCategory("Nouveautés")} /> : null}
      {categories.map((item) => <Chip key={item} label={item} selected={category === item} onPress={() => setCategory(item)} />)}
    </View>

    {loading ? <Loading label="Chargement des produits…" /> : loadError ? <EmptyState title="Catalogue indisponible" body={loadError} action={<Button label="RÉESSAYER" onPress={() => loadCatalog()} />} /> : <FlatList
      data={visibleProducts}
      keyExtractor={(product) => product.id}
      contentContainerStyle={[ui.content, { paddingTop: 4 }]}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<EmptyState title="Aucun produit" body="Essayez une autre recherche ou une autre catégorie." />}
      renderItem={({ item }) => {
        const value = quantities[item.id] ?? "";
        const selected = parseQuantity(value) > 0;
        const rules = rulesOf(item);
        return <View style={[styles.productRow, compactProducts && styles.productRowCompact, selected && styles.productRowSelected]}>
          {compactProducts ? null : <ProductImage uri={item.image} style={styles.productImage} />}
          <View style={{ flex: 1 }}>
            {item.isNew ? <Text style={styles.newBadge}>✦ NOUVEAU</Text> : null}
            <Text style={ui.strong} numberOfLines={2}>{item.name}</Text>
            {multi && item.supplierId ? <Text style={styles.supplierName} numberOfLines={1}>{supplierById.get(item.supplierId)?.name}</Text> : null}
            {item.isNew && item.description ? <Text style={ui.small} numberOfLines={2}>{item.description}</Text> : null}
            {rules.show_origin && item.origin ? <Text style={styles.origin} numberOfLines={2}>Origine : {[formatOrigin(item.origin), item.origin.label].filter(Boolean).join(" · ")}{item.origin.note ? ` — ${item.origin.note}` : ""}</Text> : null}
            <Text style={ui.small}>{rules.show_prices ? `${formatPrice(item.price)} HT / ${item.unit}` : item.unit}</Text>
            {rules.show_stock && item.stock !== undefined ? <Text style={[ui.small, { color: item.stock > 0 ? colors.primary : colors.danger, fontWeight: "700" }]}>{item.stock > 0 ? `Stock : ${formatQuantity(item.stock)} ${item.unit}` : "Rupture de stock"}</Text> : null}
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
        {cartSuppliers > 1 ? <Text style={ui.small}>{`${cartSuppliers} fournisseurs`}</Text> : null}
        {priced && lines.length ? <Text style={ui.amount}>{formatPrice(total)} HT</Text> : null}
      </View>
      {lines.length ? <Pressable onPress={() => setQuantities({})} style={{ padding: 8 }}><Text style={[ui.small, { textDecorationLine: "underline" }]}>Vider</Text></Pressable> : null}
      <Button label="VÉRIFIER ET ENVOYER" onPress={() => setReviewVisible(true)} disabled={!lines.length} />
    </View>

    {suppliers.length ? <CartReviewModal
      visible={reviewVisible}
      suppliers={suppliers}
      lines={lines}
      onClose={() => setReviewVisible(false)}
      onPlaced={() => {
        void AsyncStorage.removeItem(storageKey).catch(() => {});
        setQuantities({});
        setReviewVisible(false);
        onPlaced();
      }}
    /> : <ReviewModal
      visible={reviewVisible}
      client={client}
      lines={lines}
      total={total}
      placeOrder={placeOrder}
      staff={!!staffFor}
      onClose={() => setReviewVisible(false)}
      onPlaced={() => {
        // Clear the saved cart right away: the screen unmounts when switching to the orders tab.
        void AsyncStorage.removeItem(storageKey).catch(() => {});
        setQuantities({});
        setReviewVisible(false);
        onPlaced();
      }}
    />}

    <RepeatModal
      visible={repeatVisible}
      showPrices={client.show_prices}
      loadHistory={loadHistory}
      onClose={() => setRepeatVisible(false)}
      onFill={fillFromOrders}
    />
  </View>;
}

function ReviewModal({ visible, client, lines, total, placeOrder, staff, onClose, onPlaced }: {
  visible: boolean;
  placeOrder: PlaceOrder;
  staff: boolean;
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
  const sending = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setPointId(points.length === 1 ? points[0].id : null);
    setError("");
  }, [visible, points]);

  async function submit() {
    // A quick double tap must not send the order twice (the button only greys out after re-render).
    if (sending.current) return;
    if (points.length > 1 && !pointId) {
      setError("Choisissez le point de livraison.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const order = await placeOrder({
        items: lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
        deliveryPointId: pointId,
        requestedDate: day,
        note,
      });
      setNote("");
      setDay(null);
      notify("Commande envoyée", staff
        ? `Commande #${order.order_number} enregistrée pour ${client.business_name} (${formatPrice(order.total)} HT). Elle attend la décision dans Commandes.`
        : `Commande #${order.order_number} transmise à votre fournisseur${client.show_prices ? ` (${formatPrice(order.total)} HT)` : ""}. Vous serez informé de son acceptation.`);
      onPlaced();
    } catch (cause) {
      setError(errorMessage(cause, "La commande n’a pas pu être envoyée."));
    } finally {
      sending.current = false;
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
              {client.show_prices ? <Text style={ui.body}>{formatPrice(line.product.price * line.quantity)}</Text> : null}
            </View>)}
            {client.show_prices ? <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Total estimé HT</Text><Text style={ui.amount}>{formatPrice(total)}</Text></View> : null}
            <Text style={[ui.small, { marginTop: 6 }]}>{client.show_prices ? "Les prix et le stock sont confirmés par votre fournisseur à la réception." : "Le stock est confirmé par votre fournisseur à la réception."}</Text>
          </View>

          {points.length > 1 ? <View style={ui.card}>
            <Text style={ui.strong}>Point de livraison</Text>
            <View style={{ gap: 8, marginTop: 10 }}>
              {points.map((point) => <Pressable key={point.id} onPress={() => setPointId(point.id)} style={[styles.pointOption, pointId === point.id && styles.pointOptionSelected]}>
                <Text style={[ui.strong, pointId === point.id && { color: colors.primary }]}>{point.label}</Text>
                <Text style={ui.small}>{point.address_line}, {point.city}</Text>
              </Pressable>)}
            </View>
          </View> : null}

          <View style={ui.card}>
            <Text style={ui.strong}>Livraison souhaitée</Text>
            <View style={[ui.wrapRow, { marginTop: 10 }]}>
              <Chip label="Dès que possible" selected={day === null} onPress={() => setDay(null)} />
              {days.map((key, index) => <Chip key={key} label={index === 0 ? "Aujourd’hui" : index === 1 ? "Demain" : formatDay(key)} selected={day === key} onPress={() => setDay(key)} />)}
            </View>
            <Field label="Remarque (facultatif)" value={note} onChangeText={setNote} multiline placeholder="Horaires, consignes…" />
          </View>

          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="ENVOYER LA COMMANDE" onPress={() => submit()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

// Buyer cart: one block per supplier (its own delivery point), a shared date and note, all sent at once.
function CartReviewModal({ visible, suppliers, lines, onClose, onPlaced }: {
  visible: boolean;
  suppliers: BuyerSupplier[];
  lines: { product: Product; quantity: number }[];
  onClose: () => void;
  onPlaced: () => void;
}) {
  const groups = useMemo(() => suppliers
    .map((supplier) => ({ supplier, lines: lines.filter((line) => line.product.supplierId === supplier.client_id) }))
    .filter((group) => group.lines.length), [suppliers, lines]);
  const days = useMemo(() => nextDays(14), [visible]);
  const [points, setPoints] = useState<Record<string, string | null>>({});
  const [day, setDay] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setPoints(Object.fromEntries(groups.map((group) => [group.supplier.client_id, group.supplier.delivery_points.length === 1 ? group.supplier.delivery_points[0].id : null])));
    setError("");
  }, [visible]);

  async function submit() {
    // A quick double tap must not send the orders twice.
    if (sending.current) return;
    const none = groups.find((group) => group.supplier.delivery_points.length === 0);
    if (none) {
      setError(`Aucun point de livraison n’est configuré chez ${none.supplier.name}. Contactez ce fournisseur.`);
      return;
    }
    const missing = groups.find((group) => !points[group.supplier.client_id]);
    if (missing) {
      setError(`Choisissez le point de livraison pour ${missing.supplier.name}.`);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const placed = await placeMultiOrder({
        orders: groups.map((group) => ({
          client_id: group.supplier.client_id,
          delivery_point_id: points[group.supplier.client_id] ?? null,
          items: group.lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
        })),
        requestedDate: day,
        note,
      });
      setNote("");
      setDay(null);
      if (placed.length > 1) notify("Commandes envoyées", `${placed.length} commandes transmises : ${placed.map((order) => `#${order.order_number} ${order.supplier_name}`).join(", ")}. Chaque fournisseur vous informera de son acceptation.`);
      else notify("Commande envoyée", `Commande #${placed[0].order_number} transmise à ${placed[0].supplier_name}. Vous serez informé de son acceptation.`);
      onPlaced();
    } catch (cause) {
      setError(errorMessage(cause, "La commande n’a pas pu être envoyée."));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader eyebrow="RÉCAPITULATIF" title="Mon panier" subtitle={groups.length > 1 ? `${groups.length} commandes séparées, une par fournisseur.` : undefined} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          {groups.map(({ supplier, lines: supplierLines }) => {
            const subtotal = supplierLines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
            const chosen = points[supplier.client_id] ?? null;
            return <View key={supplier.client_id} style={ui.card}>
              <Text style={ui.strong}>{supplier.name}</Text>
              {supplierLines.map((line) => <View key={line.product.id} style={[ui.row, { paddingVertical: 5 }]}>
                <Text style={[ui.body, { flex: 1 }]}>{formatQuantity(line.quantity)} {line.product.unit} · {line.product.name}</Text>
                {supplier.show_prices ? <Text style={ui.body}>{formatPrice(line.product.price * line.quantity)}</Text> : null}
              </View>)}
              {supplier.show_prices ? <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Total estimé HT</Text><Text style={ui.amount}>{formatPrice(subtotal)}</Text></View> : null}
              {supplier.delivery_points.length > 1 ? <View style={{ gap: 8, marginTop: 10 }}>
                <Text style={ui.fieldLabel}>Point de livraison</Text>
                {supplier.delivery_points.map((point) => <Pressable key={point.id} onPress={() => setPoints((current) => ({ ...current, [supplier.client_id]: point.id }))} style={[styles.pointOption, chosen === point.id && styles.pointOptionSelected]}>
                  <Text style={[ui.strong, chosen === point.id && { color: colors.primary }]}>{point.label}</Text>
                  <Text style={ui.small}>{point.address_line}, {point.city}</Text>
                </Pressable>)}
              </View> : supplier.delivery_points[0] ? <Text style={[ui.small, { marginTop: 6 }]}>{`Livraison : ${supplier.delivery_points[0].label}`}</Text> : null}
            </View>;
          })}
          <Text style={[ui.small, { marginTop: 6 }]}>Les prix et le stock sont confirmés par chaque fournisseur à la réception.</Text>

          <View style={ui.card}>
            <Text style={ui.strong}>Livraison souhaitée</Text>
            <View style={[ui.wrapRow, { marginTop: 10 }]}>
              <Chip label="Dès que possible" selected={day === null} onPress={() => setDay(null)} />
              {days.map((key, index) => <Chip key={key} label={index === 0 ? "Aujourd’hui" : index === 1 ? "Demain" : formatDay(key)} selected={day === key} onPress={() => setDay(key)} />)}
            </View>
            <Field label="Remarque (facultatif)" value={note} onChangeText={setNote} multiline placeholder="Horaires, consignes…" />
            {groups.length > 1 ? <Text style={ui.small}>La date et la remarque valent pour toutes les commandes du panier.</Text> : null}
          </View>

          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label={groups.length > 1 ? `ENVOYER LES ${groups.length} COMMANDES` : "ENVOYER LA COMMANDE"} onPress={() => submit()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function RepeatModal({ visible, showPrices, loadHistory, onClose, onFill }: { visible: boolean; showPrices: boolean; loadHistory: () => Promise<Order[]>; onClose: () => void; onFill: (orders: Order[]) => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError("");
    void loadHistory()
      .then((all) => {
        const recent = all.filter((order) => order.status !== "cancelled").slice(0, 12);
        setOrders(recent);
        setSelected(recent[0] ? [recent[0].id] : []);
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger vos commandes.")))
      .finally(() => setLoading(false));
  }, [visible]);

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="REMPLIR LE PANIER" title="Reprendre" subtitle="Cochez une ou plusieurs commandes : leurs quantités sont additionnées." right={<CloseButton onPress={onClose} />} />
      {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
        {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        {orders.length === 0 && !error ? <EmptyState title="Aucune commande précédente" body="Votre première commande servira de modèle la prochaine fois." /> : null}
        {orders.map((order) => {
          const checked = selected.includes(order.id);
          return <Pressable key={order.id} onPress={() => toggle(order.id)} style={[ui.card, checked && styles.productRowSelected]}>
            <View style={ui.row}>
              <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked ? <Text style={styles.checkmark}>✓</Text> : null}</View>
              <Text style={[ui.strong, { flex: 1 }]}>Commande #{order.order_number}</Text>
              <Text style={ui.small}>{formatDay(order.created_at)}</Text>
            </View>
            <Text style={[ui.small, { marginLeft: 34 }]} numberOfLines={2}>{order.order_items.map((line) => `${formatQuantity(line.quantity)} ${line.unit_snapshot} ${line.product_name_snapshot}`).join(" · ")}</Text>
            {showPrices ? <Text style={[ui.small, { marginLeft: 34 }]}>{formatPrice(order.total)} HT</Text> : null}
          </Pressable>;
        })}
        {orders.length ? <Button label={`REMPLIR LE PANIER (${selected.length})`} onPress={() => onFill(orders.filter((order) => selected.includes(order.id)))} disabled={selected.length === 0} style={{ marginTop: 16 }} /> : null}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.white, fontWeight: "800" },
  toolbar: { flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingTop: 12, alignItems: "center" },
  categories: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  suppliers: { flexDirection: "row", paddingHorizontal: 18, paddingTop: 10, gap: 7 },
  supplierName: { color: colors.textSoft, fontSize: 11, fontWeight: "700" },
  productRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, marginTop: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
  productRowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  productImage: { width: 54, height: 54, borderRadius: 8 },
  productRowCompact: { paddingVertical: 6, marginTop: 4 },
  origin: { color: colors.primary, fontSize: 10, marginTop: 1 },
  newBadge: { color: colors.orange, fontSize: 9, fontWeight: "800", letterSpacing: 0.8, marginBottom: 2 },
  stepper: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.white },
  stepButton: { width: 34, height: 40, alignItems: "center", justifyContent: "center" },
  stepText: { color: colors.primary, fontSize: 20, fontWeight: "700" },
  quantityInput: { width: 54, height: 40, textAlign: "center", color: colors.text, fontSize: 14, fontWeight: "700", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line, paddingVertical: 0 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  pointOption: { padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 8 },
  pointOptionSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
});
