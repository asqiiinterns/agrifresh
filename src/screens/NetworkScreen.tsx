import { useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Switch, View } from "react-native";
import { Text } from "../ui/Text";
import {
  fetchDirectory, fetchMyLinks, requestLink, respondLink, setOpenToNew,
  type DirectoryPro, type LinkStatus, type MyLink, type MyLinks,
} from "../data/directory";
import { Button, EmptyState, Field, Loading, ScreenHeader, Sheets } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const statusWords: Record<LinkStatus, string> = {
  active: "En relation",
  requested_by_supplier: "Demande du fournisseur",
  requested_by_buyer: "Demande de l’acheteur",
  refused: "Refusée",
};

// Réseau: my clients and suppliers, requests to answer, and the directory of validated Pros.
// A supplier looks for clients, a buyer for suppliers; the other side accepts or refuses.
export function NetworkScreen({ onChanged }: { onChanged?: () => void }) {
  const [links, setLinks] = useState<MyLinks | null>(null);
  const [sheet, setSheet] = useState<"links" | "find">("links");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setLinks(await fetchMyLinks());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger votre réseau. La migration 20261113 est-elle exécutée ?"));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  async function answer(link: MyLink, accept: boolean) {
    try {
      await respondLink(link.client_id, accept);
      await reload();
      onChanged?.();
    } catch (cause) {
      notify("Réseau", errorMessage(cause, "La réponse n’a pas pu être enregistrée."));
    }
  }

  if (!links) return <View style={ui.screen}><ScreenHeader eyebrow="RÉSEAU" title="Mes relations" />{error ? <EmptyState title="Réseau indisponible" body={error} /> : <Loading />}</View>;
  const org = links.org;
  const toAnswer = [...links.clients, ...links.suppliers].filter((item) => item.to_answer).length;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="RÉSEAU" title="Mes relations" subtitle={toAnswer ? `${toAnswer} demande(s) à traiter` : "Clients et fournisseurs parmi les Pros validés par Appro+."} />
    <Sheets items={[{ key: "links", label: "Mes relations", count: toAnswer || undefined }, { key: "find", label: "Annuaire" }]} value={sheet} onChange={setSheet} />
    {sheet === "links" ? <FlatList
      data={[...(org?.is_supplier ? links.clients.map((item) => ({ ...item, side: "client" as const })) : []), ...(org?.is_buyer ? links.suppliers.map((item) => ({ ...item, side: "supplier" as const })) : [])]}
      keyExtractor={(item) => `${item.side}-${item.client_id}`}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={org?.is_buyer ? <View style={[ui.card, ui.row]}>
        <View style={{ flex: 1 }}>
          <Text style={ui.strong}>Ouvert à de nouveaux fournisseurs</Text>
          <Text style={ui.small}>Désactivé : seuls vos fournisseurs actuels peuvent vous proposer leurs produits.</Text>
        </View>
        <Switch value={org.open_to_new} onValueChange={(value) => void setOpenToNew(value).then(() => reload()).catch((cause: unknown) => notify("Réseau", errorMessage(cause, "Le réglage n’a pas pu être modifié.")))}
          trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
      </View> : null}
      ListEmptyComponent={<EmptyState title="Aucune relation" body="Cherchez vos clients ou vos fournisseurs dans l’annuaire." />}
      renderItem={({ item }) => <View style={[ui.card, item.to_answer && styles.toAnswer]}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.name}</Text>
          <Text style={[ui.small, { color: item.status === "active" ? colors.primary : colors.amber }]}>{item.side === "client" ? "Client" : "Fournisseur"} · {statusWords[item.status]}</Text>
        </View>
        {item.to_answer ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
          <Button label="ACCEPTER" onPress={() => answer(item, true)} />
          <Button label="REFUSER" variant="danger" onPress={() => answer(item, false)} />
        </View> : item.status !== "active" ? <Text style={[ui.small, { marginTop: 4 }]}>En attente de la réponse de l’autre Pro.</Text> : null}
      </View>}
    /> : <DirectoryList isSupplier={!!org?.is_supplier} isBuyer={!!org?.is_buyer} onRequested={() => void reload()} />}
  </View>;
}

function DirectoryList({ isSupplier, isBuyer, onRequested }: { isSupplier: boolean; isBuyer: boolean; onRequested: () => void }) {
  const [lookingFor, setLookingFor] = useState<"clients" | "suppliers">(isSupplier ? "clients" : "suppliers");
  const [search, setSearch] = useState("");
  const [pros, setPros] = useState<DirectoryPro[] | null>(null);
  const [error, setError] = useState("");

  async function reload(text = search) {
    try { setPros(await fetchDirectory(lookingFor, text)); setError(""); } catch (cause) { setError(errorMessage(cause, "Impossible de charger l’annuaire.")); }
  }
  useEffect(() => { const timer = setTimeout(() => void reload(search), 250); return () => clearTimeout(timer); }, [search, lookingFor]);

  function ask(pro: DirectoryPro) {
    const as = lookingFor === "clients" ? "supplier" : "buyer";
    notify("Mise en relation", as === "supplier" ? `Proposer à ${pro.name} de devenir votre client ?` : `Demander à ${pro.name} de devenir votre fournisseur ?`, [
      { text: "Annuler", style: "cancel" },
      { text: "Envoyer la demande", onPress: () => {
        void requestLink(pro.id, as).then(() => { void reload(); onRequested(); notify("Mise en relation", `Demande envoyée à ${pro.name}.`); })
          .catch((cause: unknown) => notify("Mise en relation", errorMessage(cause, "La demande n’a pas pu être envoyée.")));
      } },
    ]);
  }

  return <FlatList
    data={pros ?? []}
    keyExtractor={(item) => item.id}
    contentContainerStyle={ui.content}
    ListHeaderComponent={<View>
      {isSupplier && isBuyer ? <Sheets items={[{ key: "clients", label: "Trouver des clients" }, { key: "suppliers", label: "Trouver des fournisseurs" }]} value={lookingFor} onChange={setLookingFor} /> : null}
      <Field label={lookingFor === "clients" ? "Trouver des clients" : "Trouver des fournisseurs"} value={search} onChangeText={setSearch} placeholder="Nom, ville, activité" />
      <Text style={ui.small}>Seuls les Pros validés par Appro+ apparaissent. L’autre Pro accepte ou refuse votre demande.</Text>
      {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
    </View>}
    ListEmptyComponent={pros === null ? <Loading /> : <EmptyState title="Aucun Pro trouvé" body="Essayez un autre nom ou une autre ville." />}
    renderItem={({ item }) => <View style={ui.card}>
      <Text style={ui.strong}>{item.name}</Text>
      <Text style={ui.small}>{[item.kind === "person" ? "Particulier" : null, item.is_supplier ? "Fournisseur" : null, item.is_buyer ? "Acheteur" : null].filter(Boolean).join(" · ")}{item.address ? ` · ${item.address}` : ""}</Text>
      {item.tagline ? <Text style={[ui.body, { marginTop: 2 }]}>{item.tagline}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 8 }]}>
        {item.link?.status === "active" ? <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>Déjà en relation</Text>
          : item.link && item.link.status !== "refused" ? <Text style={[ui.small, { color: colors.amber, fontWeight: "800" }]}>Demande en cours</Text>
          : lookingFor === "clients" && !item.open_to_new ? <Text style={ui.small}>Ne cherche pas de nouveau fournisseur</Text>
          : <Button label={lookingFor === "clients" ? "PROPOSER D’ÊTRE SON FOURNISSEUR" : "DEMANDER À ÊTRE CLIENT"} variant="secondary" onPress={() => ask(item)} />}
      </View>
    </View>}
  />;
}

const styles = StyleSheet.create({
  toAnswer: { borderColor: colors.amber, backgroundColor: "#fffbef" },
});
