import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { formatClientNumber, type ClientSummary } from "../data/account";
import { fetchClients, type ClientRecord } from "../data/clients";
import { fetchClientOrders, staffPlaceOrder } from "../data/orders";
import { EmptyState, Loading, ScreenHeader , formatPrice } from "../ui/components";
import { FilterBar } from "../ui/FilterBar";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { OrderScreen } from "./OrderScreen";
import { fetchStaffClientFigures } from "../data/buyer";
import { netBalance, overLimit, type AccountFigures } from "../data/accounts";

// Team order for a client (phone orders): pick the client, then the client's order screen.
export function StaffOrderEntryScreen({ onPlaced }: { onPlaced: () => void }) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ClientRecord | null>(null);
  // The client's outstanding (20261117): warned before entering an order beyond its limit.
  const [figures, setFigures] = useState<AccountFigures | null>(null);
  useEffect(() => {
    setFigures(null);
    if (selected) void fetchStaffClientFigures(selected.id).then(setFigures);
  }, [selected]);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setClients((await fetchClients()).filter((record) => record.active));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les clients."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return clients.filter((record) => `${record.business_name} ${record.contact_name} ${formatClientNumber(record.client_number)}`.toLocaleLowerCase("fr").includes(term));
  }, [clients, search]);

  if (selected) {
    // The team always sees prices, origin and stock while entering the order.
    const summary: ClientSummary = {
      id: selected.id,
      client_number: selected.client_number,
      business_name: selected.business_name,
      contact_name: selected.contact_name,
      phone: selected.phone,
      show_prices: true,
      show_origin: true,
      show_stock: true,
      stock_managed: selected.stock_managed,
      reception_qr: false,
      reception_token: null,
      delivery_points: selected.client_delivery_points.filter((point) => point.active).map(({ id, label, address_line, city }) => ({ id, label, address_line, city })),
    };
    return <OrderScreen
      key={selected.id}
      client={summary}
      placeOrder={(params) => staffPlaceOrder(selected.id, params)}
      loadHistory={() => fetchClientOrders(selected.id)}
      staffFor={{ onBack: () => setSelected(null), notice: figures && figures.credit_limit !== null ? <View style={[styles.notice, overLimit(figures) && styles.noticeDanger]}>
        <Text style={[ui.small, { color: overLimit(figures) ? colors.danger : colors.text, fontWeight: "700" }]}>{overLimit(figures)
          ? `Encours atteint : ${formatPrice(netBalance(figures))} dus pour ${formatPrice(figures.credit_limit)} autorisés. Le client ne peut plus commander lui-même ; vous pouvez enregistrer cette commande si vous l’acceptez.`
          : `Encours : ${formatPrice(Math.max(0, netBalance(figures)))} dus sur ${formatPrice(figures.credit_limit)} autorisés.`}</Text>
      </View> : null }}
      onPlaced={() => { setSelected(null); onPlaced(); }}
    />;
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="COMMANDE PAR TÉLÉPHONE" title="Commander pour un client" subtitle="Choisissez le client : vous saisissez ensuite les quantités comme lui." />
    <FilterBar search={search} onSearch={setSearch} placeholder="Nom, contact ou n° client" filters={[]} />
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(record) => record.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun client" body="Aucune fiche client active ne correspond." />}
      renderItem={({ item }) => {
        const points = item.client_delivery_points.filter((point) => point.active);
        return <Pressable onPress={() => setSelected(item)} style={[ui.card, styles.row]}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{item.business_name.slice(0, 1).toLocaleUpperCase("fr")}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>{item.business_name}</Text>
            <Text style={ui.small}>{formatClientNumber(item.client_number)}{item.contact_name ? ` · ${item.contact_name}` : ""} · {points.length} point(s) de livraison</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </Pressable>;
      }}
    />}
  </View>;
}

const styles = StyleSheet.create({
  notice: { marginHorizontal: 18, marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: colors.cream },
  noticeDanger: { backgroundColor: "#f8e5e1", borderWidth: 1, borderColor: colors.danger },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.primary, fontWeight: "800", fontSize: 16 },
});
