import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Platform, ScrollView, StyleSheet, Switch, View } from "react-native";
import { fetchPublicSettings, setPlatformSetting, type PlatformSettingKey, type PublicSettings } from "../data/directory";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "../ui/Text";
import { InvitationsPage } from "./InvitationsPage";
import {
  assistChanged, fetchPlatformAccounts, fetchProCard, fetchTemplates, saveProAsPlatform, setPlatformAccountStatus, setTemplatePermission, startAssist,
  type PlatformAccount, type ProCard, type ProInput, type RolePermission, type RoleTemplate,
} from "../data/pros";
import { deleteAccount, invitedByLabel } from "../data/admin";
import { confirmWithPassword } from "../ui/PasswordConfirm";
import { InviteModal } from "../ui/InviteModal";
import { setProStatus } from "../data/platform";
import { allModules } from "../data/modules";
import { BackButton, Button, Chip, CloseButton, EmptyState, Field, ListGroup, ListRow, Loading, MenuSearch, ScreenHeader, formatDay } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { RolesManager, rightLabel } from "./RolesManager";
import { ModulesPage } from "./ModulesPage";
import { AlertSettingsPanel } from "./NotificationSettings";
import { CategoriesPage } from "./CategoriesPage";

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
  const [plan, setPlan] = useState(false);
  const isNew = orgId === null;

  useEffect(() => {
    if (!visible) return;
    setError("");
    setRoles(false);
    setPlan(false);
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

  // Appro+ works in the Pro as its administrator for two hours: reading, or changes (password asked).
  const [inviting, setInviting] = useState(false);
  function assist(target: ProCard) {
    const begin = async (edit: boolean) => {
      if (edit && !(await confirmWithPassword(`Vous allez pouvoir modifier les réglages et les données de ${target.name} pendant 2 heures. Le Pro en est prévenu.`))) return;
      try {
        await startAssist(target.id, edit, edit ? "Assistance avec modifications" : "Assistance en lecture");
        onClose();
        assistChanged();
      } catch (cause) {
        notify("Assistance", errorMessage(cause, "L’assistance n’a pas pu commencer. La migration 20261124 est-elle exécutée ?"));
      }
    };
    notify(`Assister ${target.name}`, "Vous voyez l’espace comme son administrateur, pendant 2 heures. Ses Responsables sont prévenus, et chaque modification figure dans son journal à votre nom.", [
      { text: "Annuler", style: "cancel" },
      { text: "Lecture seule", onPress: () => void begin(false) },
      { text: "Lecture et modification", onPress: () => void begin(true) },
    ]);
  }

  function changeStatus(status: "active" | "suspended" | "refused") {
    if (!card) return;
    void setProStatus(card.id, status).then(async () => { onChanged(); setCard(await fetchProCard(card.id)); })
      .catch((cause: unknown) => notify("Pros", errorMessage(cause, "Le statut n’a pas pu être modifié.")));
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      {inviting && card ? <InviteModal visible side="client" forOrgId={card.id} forOrgName={card.name} onClose={() => setInviting(false)} /> : null}
      {plan && card ? <ModulesPage mode={{ kind: "plan", orgId: card.id, orgName: card.name }} header={<BackButton label="Fiche" onPress={() => setPlan(false)} />} />
      : roles && card ? <RolesManager orgId={card.id} header={<ScreenHeader eyebrow={card.name.toLocaleUpperCase("fr")} title="Rôles et accès" right={<BackButton label="Fiche" onPress={() => setRoles(false)} />} />} /> : <>
        <ScreenHeader eyebrow="APPRO+ · PROS" title={isNew ? "Nouveau Pro" : card?.name ?? "Pro"} subtitle={card ? `${statusLabels[card.status]} · ${card.products} produit(s) · ${card.clients} client(s) · ${card.suppliers} fournisseur(s)` : undefined} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          {card ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {card.status !== "active" ? <Button label={card.status === "pending" ? "VALIDER" : "RÉACTIVER"} onPress={() => changeStatus("active")} /> : null}
            {card.status === "active" && !card.legacy ? <Button label="SUSPENDRE" variant="danger" onPress={() => changeStatus("suspended")} /> : null}
            {card.status === "pending" ? <Button label="REFUSER" variant="danger" onPress={() => changeStatus("refused")} /> : null}
            <Button label="RÔLES ET ACCÈS" variant="secondary" onPress={() => setRoles(true)} />
            <Button label="MODULES (FORMULE)" variant="secondary" onPress={() => setPlan(true)} />
            <Button label="ASSISTER CE PRO" variant="secondary" onPress={() => assist(card)} />
            <Button label="INVITER UN CLIENT POUR CE PRO" variant="secondary" onPress={() => setInviting(true)} />
          </View> : null}
          <View style={ui.card}>
            <Text style={ui.strong}>Type et activités</Text>
            <View style={[ui.wrapRow, { marginTop: 8 }]}>
              <Chip label="Entreprise" selected={form.kind === "business"} onPress={() => set("kind", "business")} />
              <Chip label="Particulier" selected={form.kind === "person"} onPress={() => { set("kind", "person"); set("is_supplier", false); set("is_buyer", true); }} />
            </View>
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
              <Switch value={form.is_supplier} disabled={form.kind === "person"} onValueChange={(value) => set("is_supplier", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <Text style={[ui.body, { flex: 1 }]}>Fournisseur (vend, livre, facture)</Text>
            </View>
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 6 }]}>
              <Switch value={form.is_buyer} onValueChange={(value) => set("is_buyer", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <Text style={[ui.body, { flex: 1 }]}>Acheteur (commande à ses fournisseurs)</Text>
            </View>
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 6 }]}>
              <Switch value={!!form.roles_delegated} onValueChange={(value) => set("roles_delegated", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <Text style={[ui.body, { flex: 1 }]}>Le Pro peut modifier ses rôles</Text>
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
type SettingsPage = "menu" | "modules" | "templates" | "alerts" | "accounts" | "categories" | "signup" | "invitations";
const settingsPages: SettingsPage[] = ["modules", "templates", "alerts", "accounts", "categories", "signup", "invitations"];

export function PlatformSettingsScreen({ initialPage }: { initialPage?: string } = {}) {
  const [page, setPage] = useState<SettingsPage>(settingsPages.includes(initialPage as SettingsPage) ? initialPage as SettingsPage : "menu");
  // A notification opened while this screen is shown (e.g. a new invitation).
  useEffect(() => { if (settingsPages.includes(initialPage as SettingsPage)) setPage(initialPage as SettingsPage); }, [initialPage]);
  const back = <BackButton label="Paramétrage" onPress={() => setPage("menu")} />;
  if (page === "invitations") return <InvitationsPage scope="platform" header={back} />;
  if (page === "signup") return <SignupSettingsPage header={back} />;
  if (page === "modules") return <ModulesPage header={back} mode={{ kind: "platform" }} />;
  if (page === "templates") return <TemplatesPage header={back} />;
  if (page === "accounts") return <PlatformAccountsPage header={back} />;
  if (page === "categories") return <CategoriesPage header={back} />;
  if (page === "alerts") return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Notifications et e-mails" right={back} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled"><AlertSettingsPanel /></ScrollView>
  </View>;
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+" title="Paramétrage" subtitle="Réglages de toute la plateforme. Chaque Pro règle ensuite ses propres options." />
    <ScrollView contentContainerStyle={ui.content}>
      <MenuSearch>
      <ListGroup title="Comptes">
        <ListRow icon="people-outline" title="Tous les comptes" detail="Rechercher, valider les inscriptions, suspendre ou réactiver un compte." onPress={() => setPage("accounts")} />
        <ListRow icon="mail-open-outline" title="Invitations" detail="Toutes les invitations : qui a invité qui, pour quel Pro, quand, qui a accepté et quand." onPress={() => setPage("invitations")} />
        <ListRow icon="person-add-outline" title="Nouveaux inscrits et invitations" detail="Période d’essai des nouveaux espaces (commande possible avant validation) et adresse des liens d’invitation." onPress={() => setPage("signup")} />
      </ListGroup>
      <ListGroup title="Fonctions et droits">
        <ListRow icon="apps-outline" title="Modules par défaut" detail="La valeur par défaut de chaque fonction pour tous les Pros ; la formule de chaque Pro se règle dans sa fiche." onPress={() => setPage("modules")} />
        <ListRow icon="key-outline" title="Modèles de rôles" detail="Les droits par défaut de chaque rôle fournisseur et acheteur. Les rôles des Pros qui suivent un modèle changent avec lui." onPress={() => setPage("templates")} />
      </ListGroup>
      <ListGroup title="Catalogue">
        <ListRow icon="pricetags-outline" title="Catégories" detail="La liste commune où chaque Pro range ses produits ; elle rend les produits comparables entre fournisseurs." onPress={() => setPage("categories")} />
      </ListGroup>
      <ListGroup title="Communication">
        <ListRow icon="notifications-outline" title="Notifications et e-mails" detail="Événements notifiés (push, e-mail) et service d’envoi des e-mails." onPress={() => setPage("alerts")} />
      </ListGroup>
      </MenuSearch>
    </ScrollView>
  </View>;
}

// New sign-ups: active at once for N hours (then suspended until validated), or waiting for Appro+
// (they browse the public catalogue but cannot order). Plus the web address used in invitation links.
function SignupSettingsPage({ header }: { header: React.ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [hours, setHours] = useState("");
  const [invitedHours, setInvitedHours] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    const next = await fetchPublicSettings();
    setSettings(next);
    setHours(String(next.trial_hours));
    setInvitedHours(String(next.invited_trial_hours ?? 0));
    setUrl(next.app_url || (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : ""));
  }
  useEffect(() => { void reload(); }, []);
  async function save(key: PlatformSettingKey, value: number | string | boolean) {
    setBusy(true);
    try {
      await setPlatformSetting(key, value);
      await reload();
      notify("Paramétrage", "Réglage enregistré.");
    } catch (cause) {
      notify("Paramétrage", errorMessage(cause, "Le réglage n’a pas pu être enregistré. La migration 20261120 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }
  const trial = Number(hours) || 0;
  const invitedTrial = Number(invitedHours) || 0;
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Nouveaux inscrits" right={header} />
    {!settings ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <View style={ui.card}>
        <Text style={ui.strong}>Activation automatique des nouveaux espaces</Text>
        <Text style={ui.small}>Activé : un nouvel espace (entreprise ou particulier) peut commander tout de suite pendant la durée choisie ; sans validation de votre part, il est ensuite suspendu. Désactivé : il parcourt les produits mais ne peut valider une commande qu’après votre validation.</Text>
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          {[0, 24, 48, 72].map((value) => <Chip key={value} label={value === 0 ? "Désactivée" : `${value} h`} selected={trial === value} onPress={() => setHours(String(value))} />)}
        </View>
        <Field label="Durée de l’essai (heures, 0 = désactivée)" value={hours} onChangeText={setHours} keyboardType="number-pad" />
        <Button label="ENREGISTRER LA DURÉE" onPress={() => save("new_accounts_trial_hours", Math.max(0, Math.round(trial)))} busy={busy} disabled={trial === settings.trial_hours} style={{ marginTop: 8 }} />
        <Text style={[ui.small, { marginTop: 6 }]}>Actuellement : {settings.trial_hours > 0 ? `essai de ${settings.trial_hours} h` : "validation obligatoire avant la première commande"}. Les espaces en essai sont en tête de la liste des Pros.</Text>
      </View>
      <View style={ui.card}>
        <Text style={ui.strong}>Comptes invités</Text>
        <Text style={ui.small}>Une personne qui rejoint Appro+ par une invitation peut travailler pendant cette durée ; sans validation de votre part (ou de l’administrateur de l’espace), son compte est ensuite suspendu. 0 : validation obligatoire tout de suite. Dans tous les cas, l’e-mail doit d’abord être confirmé.</Text>
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          {[0, 24, 48, 72].map((value) => <Chip key={value} label={value === 0 ? "Validation immédiate" : `${value} h`} selected={invitedTrial === value} onPress={() => setInvitedHours(String(value))} />)}
        </View>
        <Field label="Période transitoire des invités (heures)" value={invitedHours} onChangeText={setInvitedHours} keyboardType="number-pad" />
        <Button label="ENREGISTRER" onPress={() => save("invited_trial_hours", Math.max(0, Math.round(invitedTrial)))} busy={busy} disabled={invitedTrial === (settings.invited_trial_hours ?? 0)} style={{ marginTop: 8 }} />
      </View>
      <View style={ui.card}>
        <View style={[ui.row, { justifyContent: "flex-start" }]}>
          <Switch value={!!settings.self_signup_business_trial} disabled={busy} onValueChange={(value) => void save("self_signup_business_trial", value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>Inscription spontanée d’une entreprise</Text>
            <Text style={ui.small}>{settings.self_signup_business_trial
              ? "Une personne qui s’inscrit seule peut créer un espace entreprise, en période d’essai selon la durée ci-dessus."
              : "Une personne qui s’inscrit seule obtient un compte personnel ; l’espace entreprise reste à valider par l’équipe Appro+."}</Text>
          </View>
        </View>
      </View>
      <View style={ui.card}>
        <Text style={ui.strong}>Adresse de l’application web</Text>
        <Text style={ui.small}>Utilisée dans les liens d’invitation envoyés par e-mail, WhatsApp, Messenger ou SMS. Sans adresse, la personne invitée saisit le code dans l’application.</Text>
        <Field label="Adresse (https://…)" value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" />
        <Button label="ENREGISTRER L’ADRESSE" onPress={() => save("app_url", url.trim())} busy={busy} disabled={url.trim() === settings.app_url} style={{ marginTop: 8 }} />
      </View>
    </ScrollView>}
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
  // Deleted accounts (soft delete) only show with this filter; unconfirmed e-mails can be singled out.
  const [view, setView] = useState<"live" | "pending" | "unconfirmed" | "deleted">("live");
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

  function remove(account: PlatformAccount, restore: boolean) {
    const act = () => void deleteAccount(account.id, restore).then(() => reload()).catch((cause: unknown) => notify("Comptes", errorMessage(cause, "Le compte n’a pas pu être modifié.")));
    if (restore) { act(); return; }
    notify("Supprimer ce compte", `${account.email} ne pourra plus se connecter. Le compte reste visible avec le filtre « Supprimés » et peut être restauré.`, [
      { text: "Annuler", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: act },
    ]);
  }
  const inView = (item: PlatformAccount) => view === "deleted" ? !!item.deleted_at
    : !item.deleted_at && (view === "live" || (view === "pending" ? item.status === "pending" : item.email_confirmed === false));
  const countOf = (value: typeof view) => (accounts ?? []).filter((item) => value === "deleted" ? !!item.deleted_at
    : !item.deleted_at && (value === "live" || (value === "pending" ? item.status === "pending" : item.email_confirmed === false))).length;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Tous les comptes" right={header} />
    <View style={{ paddingHorizontal: 14, paddingTop: 8 }}><Field label="Rechercher" value={search} onChangeText={setSearch} placeholder="E-mail, nom ou Pro" autoCapitalize="none" /></View>
    <View style={[ui.wrapRow, { paddingHorizontal: 14, marginTop: 6 }]}>
      {([["live", "Comptes"], ["pending", "À valider"], ["unconfirmed", "E-mail non confirmé"], ["deleted", "Supprimés"]] as [typeof view, string][])
        .map(([value, label]) => <Chip key={value} label={`${label} (${countOf(value)})`} selected={view === value} onPress={() => setView(value)} />)}
    </View>
    {error ? <Text style={[ui.error, { paddingHorizontal: 14 }]}>{error}</Text> : null}
    {!accounts ? <Loading /> : <FlatList data={accounts.filter(inView)} keyExtractor={(item) => item.id} contentContainerStyle={ui.content}
      ListEmptyComponent={<EmptyState title="Aucun compte" body="Aucun compte ne correspond à cette recherche." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.full_name || item.email}</Text>
          <Text style={[ui.small, { color: item.status === "active" ? colors.primary : colors.amber }]}>{statusLabels[item.status ?? "pending"] ?? item.status}</Text>
        </View>
        <Text style={ui.small}>{item.email} · {roleWords[item.role ?? "customer"] ?? item.role} · {item.org_name ?? (item.role === "platform" ? "Appro+" : "Sans Pro (inscription libre)")}</Text>
        <Text style={ui.small}>Créé le {formatDay(item.created_at, { day: "numeric", month: "short", year: "numeric" })}{item.last_sign_in_at ? ` · dernière connexion le ${formatDay(item.last_sign_in_at, { day: "numeric", month: "short" })}` : ""}</Text>
        {item.invited_by ? <Text style={ui.small}>Invité par {invitedByLabel(item.invited_by)}</Text> : null}
        {item.email_confirmed === false ? <Text style={[ui.small, { color: colors.amber }]}>E-mail pas encore confirmé : reste suspendu jusqu’à la confirmation.</Text> : null}
        {item.deleted_at ? <View style={[ui.wrapRow, { marginTop: 6 }]}>
          <Text style={[ui.small, { color: colors.danger, flex: 1 }]}>Supprimé le {formatDay(item.deleted_at, { day: "numeric", month: "short", year: "numeric" })}</Text>
          {item.role !== "platform" ? <Button label="RESTAURER" variant="secondary" onPress={() => remove(item, true)} /> : null}
        </View> : item.role !== "platform" ? <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {item.status !== "active" ? <Button label={item.status === "pending" ? "VALIDER" : "RÉACTIVER"} onPress={() => change(item, "active")} /> : null}
          {item.status === "active" ? <Button label="SUSPENDRE" variant="danger" onPress={() => change(item, "suspended")} /> : null}
          {item.status === "pending" ? <Button label="REFUSER" variant="danger" onPress={() => change(item, "refused")} /> : null}
          <Button label="SUPPRIMER" variant="secondary" onPress={() => remove(item, false)} />
        </View> : null}
      </View>}
    />}
  </View>;
}

const styles = StyleSheet.create({
  perm: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line },
});
