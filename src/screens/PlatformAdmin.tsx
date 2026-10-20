import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "../ui/Text";
import {
  fetchPlatformAccounts, fetchProCard, fetchTemplates, saveProAsPlatform, setPlatformAccountStatus, setTemplatePermission,
  type PlatformAccount, type ProCard, type ProInput, type RolePermission, type RoleTemplate,
} from "../data/pros";
import { setProStatus } from "../data/platform";
import { allModules } from "../data/modules";
import { BackButton, Button, Chip, CloseButton, EmptyState, Field, ListGroup, ListRow, Loading, ScreenHeader, formatDay } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { RolesManager, rightLabel } from "./RolesManager";
import { ModulesPage } from "./ModulesPage";
import { AlertSettingsPanel } from "./NotificationSettings";

const statusLabels: Record<string, string> = { pending: "En attente", active: "Actif", suspended: "Suspendu", refused: "Refusé" };
const roleWords: Record<string, string> = { admin: "Responsable", supervisor: "Superviseur", staff: "Superviseur", production: "Production", driver: "Livreur", customer: "Client", platform: "Équipe Appro+" };

// ---------------------------------------------------------------------------
// A Pro: create or edit (Appro+), with its team, status and roles.
// ---------------------------------------------------------------------------
const emptyPro: ProInput = { name: "", kind: "business", is_supplier: false, is_buyer: true, roles_delegated: false, tagline: "", address: "", phone: "", email: "", tax_id: "", rib: "", owner_email: "" };

export function ProDetailModal({ orgId, visible, onClose, onChanged }: { orgId: string | null; visible: boolean; onClose: () => void; onChanged: () => void }) {
  const [card, setCard] = useState<ProCard | null>(null);
  const [form, setForm] = useState<ProInput>(emptyPro);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [roles, setRoles] = useState(false);
  const isNew = orgId === null;

  useEffect(() => {
    if (!visible) return;
    setError("");
    setRoles(false);
    if (isNew) { setCard(null); setForm(emptyPro); return; }
    void fetchProCard(orgId).then((next) => {
      setCard(next);
      setForm({ name: next.name, kind: next.kind, is_supplier: next.is_supplier, is_buyer: next.is_buyer, roles_delegated: next.roles_delegated,
        tagline: next.tagline, address: next.address, phone: next.phone, email: next.email, tax_id: next.tax_id, rib: next.rib, owner_email: next.owner_email ?? "" });
    }).catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger ce Pro.")));
  }, [visible, orgId]);

  const set = <K extends keyof ProInput>(key: K, value: ProInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    setError("");
    try {
      const id = await saveProAsPlatform(orgId, form);
      onChanged();
      if (isNew) {
        notify("Pro créé", form.owner_email ? `${form.name} est créé. ${form.owner_email} en devient Responsable dès la création de son compte (ou tout de suite s’il existe).` : `${form.name} est créé.`);
        onClose();
      } else {
        setCard(await fetchProCard(id));
      }
    } catch (cause) {
      setError(errorMessage(cause, "Le Pro n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  function changeStatus(status: "active" | "suspended" | "refused") {
    if (!card) return;
    void setProStatus(card.id, status).then(async () => { onChanged(); setCard(await fetchProCard(card.id)); })
      .catch((cause: unknown) => notify("Pros", errorMessage(cause, "Le statut n’a pas pu être modifié.")));
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      {roles && card ? <RolesManager orgId={card.id} header={<ScreenHeader eyebrow={card.name.toLocaleUpperCase("fr")} title="Rôles et accès" right={<BackButton label="Fiche" onPress={() => setRoles(false)} />} />} /> : <>
        <ScreenHeader eyebrow="APPRO+ · PROS" title={isNew ? "Nouveau Pro" : card?.name ?? "Pro"} subtitle={card ? `${statusLabels[card.status]} · ${card.products} produit(s) · ${card.clients} client(s) · ${card.suppliers} fournisseur(s)` : undefined} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          {card ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {card.status !== "active" ? <Button label={card.status === "pending" ? "VALIDER" : "RÉACTIVER"} onPress={() => changeStatus("active")} /> : null}
            {card.status === "active" && !card.legacy ? <Button label="SUSPENDRE" variant="danger" onPress={() => changeStatus("suspended")} /> : null}
            {card.status === "pending" ? <Button label="REFUSER" variant="danger" onPress={() => changeStatus("refused")} /> : null}
            <Button label="RÔLES ET ACCÈS" variant="secondary" onPress={() => setRoles(true)} />
          </View> : null}
          <View style={ui.card}>
            <Text style={ui.strong}>Type et activités</Text>
            <View style={[ui.wrapRow, { marginTop: 8 }]}>
              <Chip label="Entreprise" selected={form.kind === "business"} onPress={() => set("kind", "business")} />
              <Chip label="Particulier" selected={form.kind === "person"} onPress={() => { set("kind", "person"); set("is_supplier", false); set("is_buyer", true); }} />
            </View>
            <View style={[ui.row, { marginTop: 10 }]}>
              <Text style={[ui.body, { flex: 1 }]}>Fournisseur (vend, livre, facture)</Text>
              <Switch value={form.is_supplier} disabled={form.kind === "person"} onValueChange={(value) => set("is_supplier", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
            </View>
            <View style={[ui.row, { marginTop: 6 }]}>
              <Text style={[ui.body, { flex: 1 }]}>Acheteur (commande à ses fournisseurs)</Text>
              <Switch value={form.is_buyer} onValueChange={(value) => set("is_buyer", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
            </View>
            <View style={[ui.row, { marginTop: 6 }]}>
              <Text style={[ui.body, { flex: 1 }]}>Le Pro peut modifier ses rôles</Text>
              <Switch value={!!form.roles_delegated} onValueChange={(value) => set("roles_delegated", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
            </View>
          </View>
          <View style={ui.card}>
            <Text style={ui.strong}>Coordonnées</Text>
            <Field label={form.kind === "person" ? "Nom et prénom" : "Raison sociale"} value={form.name} onChangeText={(value) => set("name", value)} />
            <Field label="Téléphone" value={form.phone ?? ""} onChangeText={(value) => set("phone", value)} keyboardType="phone-pad" />
            <Field label="E-mail de contact" value={form.email ?? ""} onChangeText={(value) => set("email", value)} autoCapitalize="none" keyboardType="email-address" />
            <Field label="Adresse" value={form.address ?? ""} onChangeText={(value) => set("address", value)} multiline />
            {form.kind === "business" ? <>
              <Field label="Matricule fiscal" value={form.tax_id ?? ""} onChangeText={(value) => set("tax_id", value)} autoCapitalize="characters" />
              {form.is_supplier ? <Field label="RIB" value={form.rib ?? ""} onChangeText={(value) => set("rib", value)} /> : null}
            </> : null}
          </View>
          <View style={ui.card}>
            <Text style={ui.strong}>Responsable</Text>
            <Field label="E-mail du Responsable" value={form.owner_email ?? ""} onChangeText={(value) => set("owner_email", value)} autoCapitalize="none" keyboardType="email-address" placeholder="Rattaché dès qu’il crée son compte" />
          </View>
          {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
          <Button label={isNew ? "CRÉER LE PRO" : "ENREGISTRER"} busy={busy} onPress={() => save()} style={{ marginTop: 12 }} />
          {card ? <ListGroup title={`Comptes (${card.members.length})`}>
            {card.members.length ? card.members.map((member) => <ListRow key={member.id} icon="person-outline" title={member.full_name || member.email}
              detail={`${member.email} · ${roleWords[member.role] ?? member.role} · ${statusLabels[member.status] ?? member.status}`} />)
              : <Text style={[ui.small, { padding: 12 }]}>Aucun compte rattaché pour l’instant.</Text>}
          </ListGroup> : null}
        </ScrollView>
      </>}
    </SafeAreaView>
  </Modal>;
}

// ---------------------------------------------------------------------------
// Appro+ → Paramétrage: everything that applies to the whole platform.
// ---------------------------------------------------------------------------
type SettingsPage = "menu" | "modules" | "templates" | "alerts" | "accounts";

export function PlatformSettingsScreen() {
  const [page, setPage] = useState<SettingsPage>("menu");
  const back = <BackButton label="Paramétrage" onPress={() => setPage("menu")} />;
  if (page === "modules") return <ModulesPage header={back} />;
  if (page === "templates") return <TemplatesPage header={back} />;
  if (page === "accounts") return <PlatformAccountsPage header={back} />;
  if (page === "alerts") return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Alertes et e-mails" right={back} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled"><AlertSettingsPanel /></ScrollView>
  </View>;
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+" title="Paramétrage" subtitle="Réglages de toute la plateforme. Chaque Pro règle ensuite ses propres options." />
    <ScrollView contentContainerStyle={ui.content}>
      <ListGroup title="Comptes">
        <ListRow icon="people-outline" title="Tous les comptes" detail="Rechercher, valider les inscriptions, suspendre ou réactiver un compte." onPress={() => setPage("accounts")} />
      </ListGroup>
      <ListGroup title="Fonctions et droits">
        <ListRow icon="apps-outline" title="Modules" detail="Activer ou masquer chaque fonction sur la plateforme." onPress={() => setPage("modules")} />
        <ListRow icon="key-outline" title="Modèles de rôles" detail="Les droits par défaut de chaque rôle fournisseur et acheteur. Les rôles des Pros qui suivent un modèle changent avec lui." onPress={() => setPage("templates")} />
      </ListGroup>
      <ListGroup title="Communication">
        <ListRow icon="notifications-outline" title="Alertes et e-mails" detail="Événements notifiés (push, e-mail) et service d’envoi des e-mails." onPress={() => setPage("alerts")} />
      </ListGroup>
    </ScrollView>
  </View>;
}

function TemplatesPage({ header }: { header: React.ReactNode }) {
  const [data, setData] = useState<{ permissions: RolePermission[]; templates: RoleTemplate[] } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function reload() {
    try { const next = await fetchTemplates(); setData(next); setKey((current) => current ?? next.templates[0]?.key ?? null); } catch (cause) { setError(errorMessage(cause, "Impossible de charger les modèles.")); }
  }
  useEffect(() => { void reload(); }, []);
  const template = data?.templates.find((item) => item.key === key);
  const perms = useMemo(() => data && template ? data.permissions.filter((perm) => perm.side === template.side) : [], [data, template]);
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Modèles de rôles" right={header} />
    {!data ? (error ? <EmptyState title="Modèles indisponibles" body={error} /> : <Loading />) : <ScrollView contentContainerStyle={ui.content}>
      {(["supplier", "buyer"] as const).map((side) => <View key={side}>
        <Text style={[ui.fieldLabel, { marginTop: 10 }]}>{side === "supplier" ? "Fournisseur" : "Acheteur"}</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {data.templates.filter((item) => item.side === side).map((item) => <Chip key={item.key} label={`${item.name} · ${item.roles}`} selected={item.key === key} onPress={() => setKey(item.key)} />)}
        </View>
      </View>)}
      {template ? <View style={ui.card}>
        <Text style={ui.strong}>{template.name}</Text>
        <Text style={ui.small}>{template.description} Utilisé par {template.roles} rôle(s) de Pros ; ceux qui ont leurs propres réglages les gardent.</Text>
        {perms.map((perm) => <View key={perm.key} style={styles.perm}>
          <View style={{ flex: 1 }}>
            <Text style={ui.body}>{rightLabel(perm.key)}</Text>
            <Text style={ui.small}>{perm.module ? allModules.find((item) => item.key === perm.module)?.label ?? perm.module : "Toujours disponible"}</Text>
          </View>
          <Switch value={template.granted.includes(perm.key)} onValueChange={(value) => void setTemplatePermission(template.key, perm.key, value).then(reload)
            .catch((cause: unknown) => notify("Modèles", errorMessage(cause, "Le modèle n’a pas pu être modifié.")))} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
        </View>)}
      </View> : null}
    </ScrollView>}
  </View>;
}

function PlatformAccountsPage({ header }: { header: React.ReactNode }) {
  const [search, setSearch] = useState("");
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null);
  const [error, setError] = useState("");
  async function reload(text = search) {
    try { setAccounts(await fetchPlatformAccounts(text)); setError(""); } catch (cause) { setError(errorMessage(cause, "Impossible de charger les comptes.")); }
  }
  useEffect(() => { const timer = setTimeout(() => void reload(search), 250); return () => clearTimeout(timer); }, [search]);

  function change(account: PlatformAccount, status: "active" | "suspended" | "refused") {
    const verb = status === "active" ? (account.status === "pending" ? "Valider" : "Réactiver") : status === "suspended" ? "Suspendre" : "Refuser";
    notify(`${verb} ce compte`, account.email, [
      { text: "Annuler", style: "cancel" },
      { text: verb, style: status === "active" ? "default" : "destructive", onPress: () => {
        void setPlatformAccountStatus(account.id, status).then(() => reload()).catch((cause: unknown) => notify("Comptes", errorMessage(cause, "Le compte n’a pas pu être modifié.")));
      } },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Tous les comptes" right={header} />
    <View style={{ paddingHorizontal: 14, paddingTop: 8 }}><Field label="Rechercher" value={search} onChangeText={setSearch} placeholder="E-mail, nom ou Pro" autoCapitalize="none" /></View>
    {error ? <Text style={[ui.error, { paddingHorizontal: 14 }]}>{error}</Text> : null}
    {!accounts ? <Loading /> : <FlatList data={accounts} keyExtractor={(item) => item.id} contentContainerStyle={ui.content}
      ListEmptyComponent={<EmptyState title="Aucun compte" body="Aucun compte ne correspond à cette recherche." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.full_name || item.email}</Text>
          <Text style={[ui.small, { color: item.status === "active" ? colors.primary : colors.amber }]}>{statusLabels[item.status ?? "pending"] ?? item.status}</Text>
        </View>
        <Text style={ui.small}>{item.email} · {roleWords[item.role ?? "customer"] ?? item.role} · {item.org_name ?? (item.role === "platform" ? "Appro+" : "Sans Pro (inscription libre)")}</Text>
        <Text style={ui.small}>Créé le {formatDay(item.created_at, { day: "numeric", month: "short", year: "numeric" })}{item.last_sign_in_at ? ` · dernière connexion le ${formatDay(item.last_sign_in_at, { day: "numeric", month: "short" })}` : ""}</Text>
        {item.role !== "platform" ? <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {item.status !== "active" ? <Button label={item.status === "pending" ? "VALIDER" : "RÉACTIVER"} onPress={() => change(item, "active")} /> : null}
          {item.status === "active" ? <Button label="SUSPENDRE" variant="danger" onPress={() => change(item, "suspended")} /> : null}
          {item.status === "pending" ? <Button label="REFUSER" variant="danger" onPress={() => change(item, "refused")} /> : null}
        </View> : null}
      </View>}
    />}
  </View>;
}

const styles = StyleSheet.create({
  perm: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line },
});
