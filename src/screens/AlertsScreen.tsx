import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { alertKinds, fetchAlerts, markAlertsRead, type AppAlert } from "../data/alerts";
import { Button, EmptyState, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Everything that concerns the signed-in person: orders, claims, messages, invoices, accounts.
export function AlertsScreen({ userId, onRead }: { userId: string; onRead: () => void }) {
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

  const kinds = useMemo(() => [...new Set(alerts.map((alert) => alertKinds[alert.event] ?? "Autres"))].sort(), [alerts]);
  const unread = alerts.filter((alert) => !alert.read_at).length;
  const visible = alerts.filter((alert) => (state === "all" || !alert.read_at)
    && (kind === "all" || (alertKinds[alert.event] ?? "Autres") === kind)
    && matchesDate(alert.created_at, period));

  const filters: Filter[] = [
    { kind: "choice", title: "Afficher", options: [{ key: "all", label: "Toutes", count: alerts.length }, { key: "unread", label: "Non lues", count: unread }], value: state, defaultValue: "all", onChange: setState },
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
      renderItem={({ item }) => <Pressable onPress={() => { if (!item.read_at) void read([item.id]); }} style={[ui.card, !item.read_at && styles.unread]}>
        <View style={ui.row}>
          {!item.read_at ? <View style={styles.dot} /> : null}
          <Text style={[ui.strong, { flex: 1 }, item.read_at && { fontWeight: "600" }]}>{item.title}</Text>
          <Text style={ui.small}>{alertKinds[item.event] ?? ""}</Text>
        </View>
        {item.body ? <Text style={[ui.body, { marginTop: 4 }]}>{item.body}</Text> : null}
        <Text style={[ui.small, { marginTop: 4 }]}>{formatDateTime(item.created_at)}</Text>
      </Pressable>}
    />}
  </View>;
}

const styles = StyleSheet.create({
  unread: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.orange },
});
