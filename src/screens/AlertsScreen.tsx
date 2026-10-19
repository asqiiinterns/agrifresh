import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { alertKinds, alertTarget, fetchAlerts, markAlertsRead, setAlertImportant, type AppAlert } from "../data/alerts";
import { useNav } from "../ui/navigation";
import { Ionicons } from "@expo/vector-icons";
import { Button, EmptyState, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Everything that concerns the signed-in person: orders, claims, messages, invoices, accounts.
export function AlertsScreen({ userId, team, onRead }: { userId: string; team: boolean; onRead: () => void }) {
  const { navigate } = useNav();
  const [alerts, setAlerts] = useState<AppAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState("all");
  const [kind, setKind] = useState("all");
  const [period, setPeriod] = useState<DateFilterValue>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setAlerts(await fetchAlerts());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les alertes."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime
      .channel(`alerts-screen-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, [userId]);

  async function read(ids?: string[]) {
    try {
      await markAlertsRead(ids);
      const now = new Date().toISOString();
      setAlerts((current) => current.map((alert) => !ids || ids.includes(alert.id) ? { ...alert, read_at: alert.read_at ?? now } : alert));
      onRead();
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de marquer les alertes comme lues."));
    }
  }

  async function toggleImportant(alert: AppAlert) {
    const next = !alert.important;
    setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, important: next } : item));
    try {
      await setAlertImportant(alert.id, next);
    } catch (cause) {
      setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, important: !next } : item));
      setError(errorMessage(cause, "Impossible de marquer l’alerte. La migration 20261028 est-elle exécutée ?"));
    }
  }

  const kinds = useMemo(() => [...new Set(alerts.map((alert) => alertKinds[alert.event] ?? "Autres"))].sort(), [alerts]);
  const unread = alerts.filter((alert) => !alert.read_at).length;
  const important = alerts.filter((alert) => alert.important).length;
  // Unread important alerts come first, then the rest by date.
  const visible = alerts.filter((alert) => (state === "all" || (state === "unread" && !alert.read_at) || (state === "important" && alert.important))
    && (kind === "all" || (alertKinds[alert.event] ?? "Autres") === kind)
    && matchesDate(alert.created_at, period))
    .sort((a, b) => Number(!!b.important && !b.read_at) - Number(!!a.important && !a.read_at) || b.created_at.localeCompare(a.created_at));

  const filters: Filter[] = [
    { kind: "choice", title: "Afficher", options: [{ key: "all", label: "Toutes", count: alerts.length }, { key: "unread", label: "Non lues", count: unread }, { key: "important", label: "Importantes", count: important }], value: state, defaultValue: "all", onChange: setState },
    { kind: "choice", title: "Type", options: [{ key: "all", label: "Tous" }, ...kinds.map((item) => ({ key: item, label: item }))], value: kind, defaultValue: "all", onChange: setKind },
    { kind: "date", title: "Date", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: period, onChange: setPeriod },
  ];

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${unread} NON LUE(S)`} title="Alertes" right={unread ? <Button label="TOUT LIRE" variant="secondary" onPress={() => void read()} /> : undefined} />
    <FilterBar filters={filters} />
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(alert) => alert.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune alerte" body="Les nouvelles commandes, changements de statut, messages et factures apparaîtront ici." />}
      renderItem={({ item }) => <Pressable onPress={() => {
        // Opening an alert marks it read and goes straight to what it is about.
        if (!item.read_at) void read([item.id]);
        const target = alertTarget(item.event, item.order_id, team, item.conversation_id);
        if (target.tab !== "alerts") navigate(target.tab, target.params);
      }} style={[ui.card, !item.read_at && styles.unread, item.important && styles.important]}>
        <View style={ui.row}>
          {!item.read_at ? <View style={styles.dot} /> : null}
          <Text style={[ui.strong, { flex: 1 }, item.read_at && { fontWeight: "600" }]}>{item.title}</Text>
          <Text style={ui.small}>{alertKinds[item.event] ?? ""}</Text>
          <Pressable onPress={() => void toggleImportant(item)} hitSlop={10} accessibilityLabel={item.important ? "Retirer des importantes" : "Marquer comme importante"}>
            <Ionicons name={item.important ? "star" : "star-outline"} size={20} color={item.important ? colors.amber : colors.muted} />
          </Pressable>
        </View>
        {item.body ? <Text style={[ui.body, { marginTop: 4 }]}>{item.body}</Text> : null}
        <View style={[ui.row, { marginTop: 4 }]}>
          <Text style={ui.small}>{formatDateTime(item.created_at)}</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.muted} />
        </View>
      </Pressable>}
    />}
  </View>;
}

const styles = StyleSheet.create({
  unread: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  important: { borderColor: "#e3c46f", borderLeftWidth: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.orange },
});
