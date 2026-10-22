import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { fetchClientErrors, resolveClientError, type ClientError } from "../data/errors";
import { Button, Chip, EmptyState, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Appro+ → Paramétrage → Erreurs de l'application: every crash of a screen, with who, where and the technical
// message, grouped (the same error of the same person on the same screen is counted).
export function ClientErrorsPage({ header }: { header: React.ReactNode }) {
  const [rows, setRows] = useState<ClientError[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setRows(await fetchClientErrors(includeResolved));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les erreurs. La migration 20261206 est-elle exécutée ?"));
      setRows((current) => current ?? []);
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, [includeResolved]);

  async function resolve(id: string | null) {
    try {
      await resolveClientError(id);
      await reload();
    } catch (cause) {
      notify("Erreurs", errorMessage(cause, "L’opération a échoué."));
    }
  }

  const openCount = rows?.filter((row) => !row.resolved_at).length ?? 0;
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Erreurs de l’application" subtitle="Chaque écran qui plante est enregistré ici automatiquement, avec le compte, l’appareil et le message technique." right={header} />
    {rows === null ? <Loading /> : <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}>
      <View style={[ui.wrapRow, { marginTop: 8 }]}>
        <Chip label={`À traiter (${includeResolved ? openCount : rows.length})`} selected={!includeResolved} onPress={() => setIncludeResolved(false)} />
        <Chip label="Toutes" selected={includeResolved} onPress={() => setIncludeResolved(true)} />
        {openCount ? <Button label="TOUT MARQUER COMME TRAITÉ" variant="secondary" onPress={() => void resolve(null)} /> : null}
      </View>
      {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
      {!rows.length && !error ? <EmptyState title="Aucune erreur" body="Aucun écran n’a planté. Les erreurs apparaîtront ici dès qu’elles se produisent." /> : null}
      {rows.map((row) => <Pressable key={row.id} onPress={() => setOpen(open === row.id ? null : row.id)} style={[ui.card, row.resolved_at ? { opacity: 0.6 } : { borderColor: colors.danger }]}>
        <Text style={ui.strong} numberOfLines={open === row.id ? undefined : 2} selectable>{row.message}</Text>
        <Text style={ui.small}>{[row.screen ? `Écran ${row.screen}` : null, row.user ?? "sans compte", row.org_name, row.platform, row.app_version ? `v${row.app_version}` : null].filter(Boolean).join(" · ")}</Text>
        <Text style={ui.small}>{row.occurrences > 1 ? `${row.occurrences} fois, ` : ""}dernière le {formatDateTime(row.last_seen_at)}{row.resolved_at ? ` · traitée le ${formatDateTime(row.resolved_at)}` : ""}</Text>
        {open === row.id ? <>
          {row.url ? <Text style={[ui.small, { marginTop: 6 }]} selectable>{row.url}</Text> : null}
          {row.component_stack ? <Text style={[ui.small, { marginTop: 6, fontFamily: "monospace" }]} selectable>{row.component_stack.trim().split("\n").slice(0, 12).join("\n")}</Text> : null}
          {row.stack ? <Text style={[ui.small, { marginTop: 6, fontFamily: "monospace" }]} selectable>{row.stack.split("\n").slice(0, 12).join("\n")}</Text> : null}
          {!row.resolved_at ? <Button label="MARQUER COMME TRAITÉE" variant="secondary" onPress={() => void resolve(row.id)} style={{ marginTop: 8 }} /> : null}
        </> : <Text style={[ui.small, { color: colors.primary }]}>Toucher pour le détail technique</Text>}
      </Pressable>)}
    </ScrollView>}
  </View>;
}
