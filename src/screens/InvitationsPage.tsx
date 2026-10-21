import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "../ui/Text";
import { fetchInvitations, type InvitationRecord } from "../data/directory";
import { Chip, EmptyState, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Invitations, fully traced: who invited (and for which Pro), when, for whom, until when,
// and who accepted it and when. Appro+ sees every invitation; a Pro's administrator its own.
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr");
type Filter = "all" | "waiting" | "accepted" | "expired";

export function InvitationsPage({ header, scope }: { header: React.ReactNode; scope: "platform" | "mine" }) {
  const [rows, setRows] = useState<InvitationRecord[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setRows(await fetchInvitations(scope));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les invitations. La migration 20261126 est-elle exécutée ?"));
      setRows((current) => current ?? []);
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, [scope]);

  const now = Date.now();
  const stateOf = (row: InvitationRecord): Exclude<Filter, "all"> => row.acceptances.length ? "accepted"
    : row.expires_at && new Date(row.expires_at).getTime() < now ? "expired" : "waiting";
  const needle = fold(query.trim());
  const shown = (rows ?? []).filter((row) => (filter === "all" || stateOf(row) === filter)
    && (!needle || fold([row.org_name, row.invited_by, row.name, row.contact, row.client_name, ...row.acceptances.map((item) => `${item.name ?? ""} ${item.org_name ?? ""}`)].filter(Boolean).join(" ")).includes(needle)));
  const count = (value: Filter) => (rows ?? []).filter((row) => value === "all" || stateOf(row) === value).length;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={scope === "platform" ? "APPRO+" : "ADMINISTRATION"} title="Invitations" subtitle={rows ? `${rows.length} invitation(s)` : undefined} right={header} />
    {!rows ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} />}>
      <Text style={[ui.small, { marginTop: 8 }]}>{scope === "platform"
        ? "Chaque invitation de la plateforme : le Pro et la personne qui a invité, la date, le contact visé, puis qui l’a acceptée et quand. Un compte invité reste à valider : il n’est pas activé d’office."
        : "Les invitations envoyées par votre équipe : qui a invité, quand, qui les a acceptées et quand."}</Text>
      <TextInput value={query} onChangeText={setQuery} placeholder="Rechercher un Pro, une personne, un contact" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} autoCorrect={false} autoCapitalize="none" />
      <View style={[ui.wrapRow, { marginTop: 8 }]}>
        {([["all", "Toutes"], ["waiting", "En attente"], ["accepted", "Acceptées"], ["expired", "Expirées"]] as [Filter, string][])
          .map(([value, label]) => <Chip key={value} label={`${label} (${count(value)})`} selected={filter === value} onPress={() => setFilter(value)} />)}
      </View>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {!shown.length && !error ? <EmptyState title="Aucune invitation" body={query || filter !== "all" ? "Aucune invitation ne correspond." : "Les invitations envoyées apparaîtront ici."} /> : null}
      {shown.map((row) => {
        const state = stateOf(row);
        return <View key={row.code} style={ui.card}>
          <View style={ui.row}>
            <Ionicons name={state === "accepted" ? "checkmark-circle-outline" : state === "expired" ? "close-circle-outline" : "time-outline"} size={18}
              color={state === "accepted" ? colors.primary : state === "expired" ? colors.muted : colors.amber} />
            <Text style={[ui.strong, { flex: 1 }]}>{row.side === "client" ? "Invitation d’un client" : "Invitation d’un fournisseur"}{scope === "platform" ? ` · ${row.org_name}` : ""}</Text>
          </View>
          <Text style={ui.small}>Par {row.invited_by ?? "—"} · le {formatDateTime(row.created_at)}{row.expires_at ? ` · valable jusqu’au ${formatDateTime(row.expires_at)}` : ""}</Text>
          {row.name || row.contact || row.client_name ? <Text style={ui.small}>Pour {[row.client_name ?? row.name, row.contact].filter(Boolean).join(" · ")}</Text> : null}
          <Text style={[ui.small, { color: colors.muted }]}>Code {row.code}</Text>
          {row.acceptances.map((item, index) => <Text key={index} style={[ui.body, { marginTop: 4 }]}>
            ✓ Acceptée par {item.name ?? "—"}{item.org_name ? ` (${item.org_name})` : ""} le {formatDateTime(item.accepted_at)}{item.linked_at ? ` · relation créée le ${formatDateTime(item.linked_at)}` : " · relation à valider"}
          </Text>)}
          {state === "waiting" ? <Text style={[ui.small, { color: colors.amber, marginTop: 4 }]}>Pas encore acceptée.</Text> : null}
          {state === "expired" ? <Text style={[ui.small, { marginTop: 4 }]}>Expirée sans être acceptée.</Text> : null}
        </View>;
      })}
    </ScrollView>}
  </View>;
}
