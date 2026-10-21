import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { fetchPublicCatalog, orderFromPublic, type PublicProduct, type PublicSupplier } from "../data/directory";
import { Button, EmptyState, Field, Loading, ScreenHeader, formatPrice, formatQuantity } from "../ui/components";
import { htTtc, withVat } from "../ui/price";
import { useNav } from "../ui/navigation";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Découvrir: the products of the suppliers who show them to everyone (not yet my suppliers).
// The first order with one of them creates the relation and arrives "à décider" at the supplier.
// canOrder false: a new account browses (it orders once its space is active); `reason` says why.
export function PublicCatalogScreen({ canOrder, reason, onOrdered, header }: { canOrder: boolean; reason?: string; onOrdered?: () => void; header?: React.ReactNode }) {
  const [data, setData] = useState<{ suppliers: PublicSupplier[]; products: PublicProduct[] } | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const { navigate } = useNav();

  async function reload(text = search, refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setData(await fetchPublicCatalog(text));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger le catalogue. La migration 20261120 est-elle exécutée ?"));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { const timer = setTimeout(() => void reload(search), 250); return () => clearTimeout(timer); }, [search]);

  const sections = useMemo(() => (data?.suppliers ?? []).map((supplier) => ({
    supplier,
    key: supplier.org_id,
    data: (data?.products ?? []).filter((product) => product.org_id === supplier.org_id),
  })).filter((section) => section.data.length > 0), [data]);

  const step = (product: PublicProduct, delta: number) => setCart((current) => {
    const next = Math.max(0, Math.round(((current[product.id] ?? 0) + delta) * 1000) / 1000);
    const copy = { ...current };
    if (next > 0) copy[product.id] = next; else delete copy[product.id];
    return copy;
  });

  async function order(supplier: PublicSupplier, products: PublicProduct[]) {
    const items = products.filter((product) => cart[product.id] > 0).map((product) => ({ product_id: product.id, quantity: cart[product.id] }));
    if (!items.length) return;
    if (!canOrder) {
      notify("Commander", reason ?? "Votre compte doit être activé pour commander.");
      return;
    }
    notify("Commander", `Envoyer cette commande à ${supplier.name} ? C’est votre première commande chez ce fournisseur : il l’accepte ou la décline, puis vous le retrouvez dans « Commander ».`, [
      { text: "Annuler", style: "cancel" },
      { text: "Envoyer", onPress: () => void (async () => {
        setBusy(supplier.org_id);
        try {
          const result = await orderFromPublic(supplier.org_id, items);
          setCart((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !products.some((product) => product.id === id))));
          notify("Commande envoyée", `Commande #${result.order_number} envoyée à ${result.supplier_name}. Vous serez prévenu dès sa réponse.`);
          onOrdered?.();
          await reload();
        } catch (cause) {
          notify("Commander", errorMessage(cause, "La commande n’a pas pu être envoyée."));
        } finally {
          setBusy(null);
        }
      })() },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="DÉCOUVRIR" title="Catalogue des fournisseurs" subtitle="Les produits des fournisseurs ouverts à tous. Vos fournisseurs actuels sont dans « Commander »." right={header} />
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={ui.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(search, true)} tintColor={colors.primary} />}
      ListHeaderComponent={<View>
        <Field label="Rechercher" value={search} onChangeText={setSearch} placeholder="Produit, fournisseur, catégorie" />
        {!canOrder && reason ? <View style={[ui.card, styles.notice]}>
          <Ionicons name="information-circle-outline" size={18} color={colors.amber} />
          <Text style={[ui.small, { flex: 1, color: colors.text }]}>{reason}</Text>
        </View> : null}
        {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
      </View>}
      ListEmptyComponent={data === null && !error ? <Loading /> : <EmptyState title="Aucun produit" body={search ? "Essayez un autre mot." : "Aucun fournisseur ne montre encore ses produits à tous."} />}
      renderSectionHeader={({ section }) => <View style={styles.supplier}>
        <Text style={styles.supplierName}>{section.supplier.name}</Text>
        {section.supplier.address || section.supplier.tagline ? <Text style={ui.small}>{[section.supplier.tagline, section.supplier.address].filter(Boolean).join(" · ")}</Text> : null}
        {!section.supplier.show_prices ? <Text style={ui.small}>Prix communiqués par le fournisseur à l’acceptation de la commande.</Text> : null}
      </View>}
      renderItem={({ item }) => {
        const quantity = cart[item.id] ?? 0;
        return <View style={[styles.product, quantity > 0 && styles.chosen]}>
          {item.image_url ? <Image source={{ uri: item.image_url }} style={styles.image} /> : <View style={[styles.image, styles.noImage]}><Ionicons name="leaf-outline" size={20} color={colors.muted} /></View>}
          <View style={{ flex: 1 }}>
            <Text style={ui.strong} numberOfLines={2}>{item.name}</Text>
            <Text style={ui.small}>{[item.category, item.unit_label].filter(Boolean).join(" · ")}</Text>
            {item.price !== null && item.price !== undefined ? <Text style={[ui.small, { color: colors.text, fontWeight: "700" }]}>{htTtc(item.price, item.vat_rate)} / {item.unit_label}</Text> : null}
          </View>
          <View style={styles.stepper}>
            <Pressable onPress={() => step(item, -1)} style={styles.stepButton} hitSlop={6} accessibilityLabel={`Retirer ${item.name}`}><Text style={styles.stepText}>−</Text></Pressable>
            <Text style={styles.quantity}>{formatQuantity(quantity)}</Text>
            <Pressable onPress={() => step(item, 1)} style={styles.stepButton} hitSlop={6} accessibilityLabel={`Ajouter ${item.name}`}><Text style={styles.stepText}>+</Text></Pressable>
          </View>
        </View>;
      }}
      renderSectionFooter={({ section }) => {
        const chosen = section.data.filter((product) => (cart[product.id] ?? 0) > 0);
        if (!chosen.length) return null;
        const total = chosen.every((product) => product.price !== null) ? chosen.reduce((sum, product) => sum + withVat(Number(product.price) * cart[product.id], product.vat_rate), 0) : null;
        return <Button label={`COMMANDER CHEZ ${section.supplier.name.toLocaleUpperCase("fr")} · ${chosen.length} PRODUIT(S)${total !== null ? ` · ${formatPrice(total)} TTC` : ""}`}
          onPress={() => order(section.supplier, section.data)} busy={busy === section.supplier.org_id} style={{ marginTop: 6 }} />;
      }}
      ListFooterComponent={canOrder ? <Button label="MES FOURNISSEURS (COMMANDER)" variant="secondary" onPress={() => navigate("order")} style={{ marginTop: 16 }} /> : null}
    />
  </View>;
}

const styles = StyleSheet.create({
  notice: { flexDirection: "row", gap: 8, alignItems: "flex-start", borderColor: colors.amber, backgroundColor: "#fffbef" },
  supplier: { marginTop: 16, marginBottom: 2 },
  supplierName: { color: colors.text, fontSize: 16, fontWeight: "800" },
  product: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  chosen: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  image: { width: 48, height: 48, borderRadius: 8 },
  noImage: { backgroundColor: colors.cream, alignItems: "center", justifyContent: "center" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.primary, alignItems: "center", justifyContent: "center" },
  stepText: { color: colors.primary, fontSize: 18, fontWeight: "800", lineHeight: 20 },
  quantity: { minWidth: 26, textAlign: "center", color: colors.text, fontWeight: "800" },
});
