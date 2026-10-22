import { useEffect, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, TextInput } from "../ui/Text";
import {
  fetchDirectory, fetchMyLinks, fetchOrgInbox, fetchOrgThread, fetchProCard, fetchProfileVisibility, requestLink, respondLink, sendOrgMessage, setOpenToNew,
  setProfileVisibility, setProVisibility,
  type DirectoryPro, type InvitationSide, type LinkStatus, type MyLink, type MyLinks, type OrgConversation, type OrgThread, type ProCard, type ProfileVisibility,
} from "../data/directory";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, Sheets, formatDateTime, formatDay } from "../ui/components";
import { InviteModal } from "../ui/InviteModal";
import { useNav } from "../ui/navigation";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const statusWords: Record<LinkStatus, string> = {
  active: "En relation",
  requested_by_supplier: "Demande du fournisseur",
  requested_by_buyer: "Demande de l’acheteur",
  refused: "Refusée",
};

type Sheet = "links" | "find" | "messages";

// Réseau: my clients and suppliers, requests to answer, the directory of validated Pros, invitations,
// the conversations with Pros outside my network, and what I show to others.
export function NetworkScreen({ onChanged, initialSection }: { onChanged?: () => void; initialSection?: string }) {
  const [links, setLinks] = useState<MyLinks | null>(null);
  const sheets: Sheet[] = ["links", "find", "messages"];
  const [sheet, setSheet] = useState<Sheet>(sheets.includes(initialSection as Sheet) ? initialSection as Sheet : "links");
  // Opened from a notification while already on Réseau (contact request, message from outside the network).
  useEffect(() => { if (sheets.includes(initialSection as Sheet)) setSheet(initialSection as Sheet); }, [initialSection]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [inviting, setInviting] = useState<InvitationSide | null>(null);
  const [conversations, setConversations] = useState<OrgConversation[]>([]);
  const [openThread, setOpenThread] = useState<{ conversationId?: string; orgId: string; name: string; open?: boolean } | null>(null);
  // A Pro's card, seen before accepting its request or from the directory.
  const [card, setCard] = useState<{ orgId: string; link?: MyLink } | null>(null);
  const [visibility, setVisibility] = useState<ProfileVisibility | null>(null);
  useEffect(() => { void fetchProfileVisibility().then(setVisibility).catch(() => undefined); }, []);
  async function changeVisibility(input: Partial<ProfileVisibility>) {
    setVisibility((current) => current ? { ...current, ...input } : current);
    try { await setProfileVisibility(input); } catch (cause) {
      notify("Réseau", errorMessage(cause, "Le réglage n’a pas pu être modifié. La migration 20261126 est-elle exécutée ?"));
      void fetchProfileVisibility().then(setVisibility).catch(() => undefined);
    }
  }

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const [next, inbox] = await Promise.all([fetchMyLinks(), fetchOrgInbox().catch(() => [] as OrgConversation[])]);
      setLinks(next);
      setConversations(inbox);
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

  async function change(input: Parameters<typeof setProVisibility>[0]) {
    try {
      await setProVisibility(input);
      await reload();
    } catch (cause) {
      notify("Réseau", errorMessage(cause, "Le réglage n’a pas pu être modifié. La migration 20261120 est-elle exécutée ?"));
    }
  }

  if (!links) return <View style={ui.screen}><ScreenHeader eyebrow="RÉSEAU" title="Mes relations" />{error ? <EmptyState title="Réseau indisponible" body={error} /> : <Loading />}</View>;
  const org = links.org;
  const toAnswer = [...links.clients, ...links.suppliers].filter((item) => item.to_answer).length;
  const unread = conversations.reduce((sum, item) => sum + Number(item.unread), 0);
  const inviteSides: InvitationSide[] = [...(org?.is_supplier ? ["client" as const] : []), ...(org?.is_buyer ? ["supplier" as const] : [])];

  function invite() {
    if (inviteSides.length === 1) { setInviting(inviteSides[0]); return; }
    notify("Inviter", "Qui invitez-vous à rejoindre Appro+ ?", [
      { text: "Annuler", style: "cancel" },
      { text: "Un client", onPress: () => setInviting("client") },
      { text: "Un fournisseur", onPress: () => setInviting("supplier") },
    ]);
  }

  const settings = org ? <View style={ui.card}>
    <Text style={ui.strong}>Ce que je montre aux autres</Text>
    {org.is_supplier ? <View style={{ marginTop: 6 }}>
      <Text style={ui.body}>Mes produits sont visibles par</Text>
      <View style={[ui.wrapRow, { marginTop: 4 }]}>
        <Chip label="Mon réseau uniquement" selected={(org.catalog_visibility ?? "network") === "network"} onPress={() => void change({ catalog: "network" })} />
        <Chip label="Tout le monde" selected={org.catalog_visibility === "public"} onPress={() => void change({ catalog: "public" })} />
      </View>
      <Text style={ui.small}>{org.catalog_visibility === "public"
        ? "Tous les comptes Appro+ voient vos produits et peuvent vous commander : leur première commande arrive « à décider » et crée la relation."
        : "Seuls vos clients voient vos produits."}</Text>
    </View> : null}
    <SettingRow label="Visible dans l’annuaire" hint="Les autres Pros vous trouvent et peuvent vous proposer une relation." value={org.listed_in_directory ?? true} onChange={(value) => void change({ listed: value })} />
    <SettingRow label="Recevoir des messages hors de mon réseau" hint="Les Pros qui ne sont pas encore en relation avec vous peuvent vous écrire." value={org.open_to_messages ?? false} onChange={(value) => void change({ messages: value })} />
    {org.is_buyer ? <SettingRow label="Ouvert à de nouveaux fournisseurs" hint="Désactivé : seuls vos fournisseurs actuels peuvent vous proposer leurs produits." value={org.open_to_new}
      onChange={(value) => void setOpenToNew(value).then(() => reload()).catch((cause: unknown) => notify("Réseau", errorMessage(cause, "Le réglage n’a pas pu être modifié.")))} /> : null}
    {visibility ? <View style={[ui.divider, { marginTop: 10 }]}>
      <Text style={ui.strong}>Sur ma fiche</Text>
      <Text style={ui.small}>Ce que voient les autres Pros quand ils ouvrent votre fiche (annuaire, demande de mise en relation). Le nom et l’activité sont toujours visibles.</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        {([["address", "Adresse"], ["phone", "Téléphone"], ["email", "E-mail"], ["tax_id", "Matricule fiscal"], ["relations", "Nombre de clients et fournisseurs"]] as [keyof ProfileVisibility, string][])
          .map(([key, label]) => <Chip key={key} label={label} selected={visibility[key]} onPress={() => void changeVisibility({ [key]: !visibility[key] })} />)}
      </View>
    </View> : null}
  </View> : null;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="RÉSEAU" title="Mes relations" subtitle={toAnswer ? `${toAnswer} demande(s) à traiter` : "Clients et fournisseurs parmi les Pros validés par Appro+."}
      right={inviteSides.length ? <Button label="INVITER" onPress={invite} /> : undefined} />
    <Sheets items={[{ key: "links", label: "Mes relations", count: toAnswer || undefined }, { key: "find", label: "Annuaire" }, { key: "messages", label: "Hors réseau", count: unread || undefined }]} value={sheet} onChange={setSheet} />
    {sheet === "links" ? <FlatList
      data={[...(org?.is_supplier ? links.clients.map((item) => ({ ...item, side: "client" as const })) : []), ...(org?.is_buyer ? links.suppliers.map((item) => ({ ...item, side: "supplier" as const })) : [])]}
      keyExtractor={(item) => `${item.side}-${item.client_id}`}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={settings}
      ListEmptyComponent={<EmptyState title="Aucune relation" body="Cherchez vos clients ou vos fournisseurs dans l’annuaire, ou invitez-les à rejoindre Appro+." />}
      renderItem={({ item }) => <View style={[ui.card, item.to_answer && styles.toAnswer]}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.name}</Text>
          <Text style={[ui.small, { color: item.status === "active" ? colors.primary : colors.amber }]}>{item.side === "client" ? "Client" : "Fournisseur"} · {statusWords[item.status]}</Text>
        </View>
        {item.to_answer ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
          <Button label="VOIR LA FICHE" variant="secondary" onPress={() => setCard({ orgId: item.org_id, link: item })} />
          <Button label="ACCEPTER" onPress={() => answer(item, true)} />
          <Button label="REFUSER" variant="danger" onPress={() => answer(item, false)} />
        </View> : <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {item.status !== "active" ? <Text style={[ui.small, { flex: 1 }]}>En attente de la réponse de l’autre Pro.</Text> : null}
          <Button label="FICHE" variant="secondary" onPress={() => setCard({ orgId: item.org_id })} />
        </View>}
      </View>}
    /> : sheet === "find" ? <DirectoryList isSupplier={!!org?.is_supplier} isBuyer={!!org?.is_buyer} onRequested={() => void reload()}
      onWrite={(pro) => setOpenThread({ orgId: pro.id, name: pro.name, open: pro.open_to_messages !== false, conversationId: conversations.find((item) => item.org_id === pro.id)?.conversation_id })}
      onCard={(pro) => setCard({ orgId: pro.id })} />
    : <FlatList
      data={conversations}
      keyExtractor={(item) => item.conversation_id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>Vos échanges avec des Pros qui ne sont pas encore vos clients ou fournisseurs. Pour écrire à un nouveau Pro, touchez « Écrire » dans l’annuaire.</Text>}
      ListEmptyComponent={<EmptyState title="Aucun échange" body="Les messages des Pros hors de votre réseau apparaîtront ici." />}
      renderItem={({ item }) => <Pressable onPress={() => setOpenThread({ conversationId: item.conversation_id, orgId: item.org_id, name: item.name })} style={[ui.card, Number(item.unread) > 0 && styles.unread]}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.name}</Text>
          {Number(item.unread) > 0 ? <Text style={styles.badge}>{item.unread}</Text> : null}
        </View>
        <Text style={ui.small} numberOfLines={2}>{item.last_body ?? ""}</Text>
        <Text style={ui.small}>{formatDateTime(item.last_at)}{item.related ? " · en relation" : ""}</Text>
        {item.held ? <Text style={[ui.small, { color: colors.amber }]}>En attente : ce Pro n’accepte pas encore les messages hors réseau ; il les recevra dès qu’il les ouvrira.</Text> : null}
      </Pressable>}
    />}
    {inviting ? <InviteModal visible side={inviting} onClose={() => setInviting(null)} /> : null}
    <OrgThreadModal target={openThread} onClose={() => { setOpenThread(null); void reload(); }} />
    <ProCardModal target={card} onClose={() => setCard(null)}
      onAnswer={card?.link ? (accept) => { const link = card.link!; setCard(null); void answer(link, accept); } : undefined}
      onWrite={(pro) => { setCard(null); setOpenThread({ orgId: pro.id, name: pro.name, conversationId: conversations.find((item) => item.org_id === pro.id)?.conversation_id }); }} />
  </View>;
}

function SettingRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (value: boolean) => void }) {
  return <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
    <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
    <View style={{ flex: 1 }}>
      <Text style={ui.body}>{label}</Text>
      <Text style={ui.small}>{hint}</Text>
    </View>
  </View>;
}

function DirectoryList({ isSupplier, isBuyer, onRequested, onWrite, onCard }: { isSupplier: boolean; isBuyer: boolean; onRequested: () => void; onWrite: (pro: DirectoryPro) => void; onCard: (pro: DirectoryPro) => void }) {
  const [lookingFor, setLookingFor] = useState<"clients" | "suppliers">(isSupplier ? "clients" : "suppliers");
  const [search, setSearch] = useState("");
  const [pros, setPros] = useState<DirectoryPro[] | null>(null);
  const [error, setError] = useState("");
  const { navigate } = useNav();

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
      <Text style={ui.small}>Seuls les Pros validés par Appro+ qui ont choisi d’apparaître dans l’annuaire sont listés. L’autre Pro accepte ou refuse votre demande.</Text>
      {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
    </View>}
    ListEmptyComponent={pros === null ? <Loading /> : <EmptyState title="Aucun Pro trouvé" body="Essayez un autre nom ou une autre ville, ou invitez ce Pro à rejoindre Appro+." />}
    renderItem={({ item }) => <View style={ui.card}>
      <Text style={ui.strong}>{item.name}</Text>
      <Text style={ui.small}>{[item.kind === "person" ? "Particulier" : null, item.is_supplier ? "Fournisseur" : null, item.is_buyer ? "Acheteur" : null].filter(Boolean).join(" · ")}{item.address ? ` · ${item.address}` : ""}</Text>
      {item.tagline ? <Text style={[ui.body, { marginTop: 2 }]}>{item.tagline}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 8 }]}>
        {item.link?.status === "active" ? <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>Déjà en relation</Text>
          : item.link && item.link.status !== "refused" ? <Text style={[ui.small, { color: colors.amber, fontWeight: "800" }]}>Demande en cours</Text>
          : lookingFor === "clients" && !item.open_to_new ? <Text style={ui.small}>Ne cherche pas de nouveau fournisseur</Text>
          : <Button label={lookingFor === "clients" ? "PROPOSER D’ÊTRE SON FOURNISSEUR" : "DEMANDER À ÊTRE CLIENT"} variant="secondary" onPress={() => ask(item)} />}
        <Button label="FICHE" variant="secondary" onPress={() => onCard(item)} />
        {/* Every listed Pro can be written to; if it does not accept messages yet, the message waits until it opens them. */}
        {item.link?.status === "active" ? <Button label="MESSAGES" variant="secondary" onPress={() => navigate("messages")} />
          : <Button label="ÉCRIRE" variant="secondary" onPress={() => onWrite(item)} />}
        {lookingFor === "suppliers" && item.catalog_visibility === "public" && item.link?.status !== "active" ? <Button label="VOIR SES PRODUITS" variant="secondary" onPress={() => navigate("discover")} /> : null}
      </View>
    </View>}
  />;
}

// One conversation with a Pro outside my network (started from the directory or from the list).
function OrgThreadModal({ target, onClose }: { target: { conversationId?: string; orgId: string; name: string; open?: boolean } | null; onClose: () => void }) {
  const [thread, setThread] = useState<OrgThread | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(id: string) {
    try { setThread(await fetchOrgThread(id)); setError(""); } catch (cause) { setError(errorMessage(cause, "Impossible de charger la conversation.")); }
  }
  useEffect(() => {
    setThread(null); setBody(""); setError("");
    setConversationId(target?.conversationId);
    if (target?.conversationId) void load(target.conversationId);
  }, [target?.orgId, target?.conversationId]);

  async function send() {
    if (!target || !body.trim()) return;
    setBusy(true);
    try {
      const id = await sendOrgMessage(target.orgId, body);
      setBody("");
      setConversationId(id);
      await load(id);
    } catch (cause) {
      setError(errorMessage(cause, "Le message n’a pas pu être envoyé."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={target !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="MESSAGE HORS RÉSEAU" title={target?.name ?? ""} right={<CloseButton onPress={onClose} />} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          inverted
          data={thread?.messages ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={ui.content}
          ListEmptyComponent={conversationId && !thread ? <Loading /> : <Text style={[ui.small, { marginVertical: 12, transform: [{ scaleY: -1 }] }]}>Présentez-vous : votre message arrive chez le Responsable de ce Pro.</Text>}
          renderItem={({ item }) => <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
            <Text style={ui.body}>{item.body}</Text>
            <Text style={ui.small}>{item.mine ? "Vous" : item.sender_name ?? target?.name}{" · "}{formatDateTime(item.created_at)}</Text>
          </View>}
        />
        {target?.open === false ? <Text style={[ui.small, { paddingHorizontal: 14, color: colors.amber }]}>Ce Pro n’accepte pas encore les messages hors réseau : votre message restera en attente et lui sera remis dès qu’il les ouvrira.</Text> : null}
        {error ? <Text style={[ui.error, { paddingHorizontal: 14 }]}>{error}</Text> : null}
        <View style={styles.composer}>
          <TextInput style={[ui.input, { flex: 1, marginTop: 0 }]} value={body} onChangeText={setBody} placeholder="Votre message" placeholderTextColor={colors.muted} multiline />
          <Button label="ENVOYER" onPress={send} busy={busy} disabled={!body.trim()} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

// The card of a Pro: only what it chose to show (Réseau → Sur ma fiche).
export function ProCardModal({ target, onClose, onAnswer, onWrite }: {
  target: { orgId: string } | null;
  onClose: () => void;
  onAnswer?: (accept: boolean) => void;
  onWrite?: (pro: ProCard) => void;
}) {
  const [card, setCard] = useState<ProCard | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setCard(null); setError("");
    if (target) void fetchProCard(target.orgId).then(setCard).catch((cause: unknown) => setError(errorMessage(cause, "Fiche non disponible. La migration 20261126 est-elle exécutée ?")));
  }, [target?.orgId]);
  const line = (label: string, value: string | number | null | undefined) => value === null || value === undefined || value === "" ? null
    : <View style={[ui.row, { marginTop: 6 }]}><Text style={[ui.small, { width: 130 }]}>{label}</Text><Text style={[ui.body, { flex: 1 }]}>{String(value)}</Text></View>;
  return <Modal visible={target !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="FICHE DU PRO" title={card?.name ?? ""} subtitle={card ? [card.kind === "person" ? "Particulier" : "Entreprise", card.is_supplier ? "Fournisseur" : null, card.is_buyer ? "Acheteur" : null].filter(Boolean).join(" · ") : undefined} right={<CloseButton onPress={onClose} />} />
      {!card ? (error ? <EmptyState title="Fiche indisponible" body={error} /> : <Loading />) : <View style={ui.content}>
        <View style={ui.card}>
          {card.tagline ? <Text style={ui.body}>{card.tagline}</Text> : null}
          {line("Sur Appro+ depuis", formatDay(card.since, { day: "numeric", month: "long", year: "numeric" }))}
          {line("Adresse", card.address)}
          {line("Téléphone", card.phone)}
          {line("E-mail", card.email)}
          {line("Matricule fiscal", card.tax_id)}
          {card.is_supplier ? line("Clients", card.clients) : null}
          {card.is_buyer ? line("Fournisseurs", card.suppliers) : null}
          {card.is_supplier ? line("Produits visibles", card.catalog_visibility === "public" ? "par tout le monde" : "par ses clients") : null}
          <Text style={[ui.small, { marginTop: 8 }]}>Seules les informations que ce Pro a choisi de montrer apparaissent.</Text>
        </View>
        <View style={[ui.wrapRow, { marginTop: 12 }]}>
          {onAnswer ? <>
            <Button label="ACCEPTER LA RELATION" onPress={() => onAnswer(true)} />
            <Button label="REFUSER" variant="danger" onPress={() => onAnswer(false)} />
          </> : null}
          {onWrite ? <Button label="ÉCRIRE" variant="secondary" onPress={() => onWrite(card)} /> : null}
        </View>
      </View>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  toAnswer: { borderColor: colors.amber, backgroundColor: "#fffbef" },
  unread: { borderColor: colors.primary },
  badge: { minWidth: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: colors.primary, color: colors.white, textAlign: "center", fontWeight: "800", fontSize: 12, lineHeight: 22 },
  bubble: { maxWidth: "85%", borderRadius: 12, padding: 10, marginTop: 8 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.primarySoft },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
});
