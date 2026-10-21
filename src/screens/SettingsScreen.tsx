import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { fetchRoleHomeLayouts, roleLabels, setRoleHomeLayout, type HomeLayout, type Role } from "../data/account";
import { fetchAccounts, type AdminAccount } from "../data/admin";
import { fetchClients, updateClientOptions, type ClientRecord } from "../data/clients";
import {
  boolToOption, configurableRoles, fetchClientDefaults, fetchRolePermissions, fetchUserPermissions,
  optionToBool, setClientDefault, setRolePermission, setUserPermission,
  type ClientOptionKey, type Feature, type SettingsBlock,
} from "../data/permissions";
import { BackButton, Button, Chip, Field, ListGroup, ListRow, Loading, MenuSearch, ScreenHeader, Sheets, TriState } from "../ui/components";
import { supabase } from "../lib/supabase";
import { docTypeLabels, fetchNumbering, previewNumber, saveNumbering, type Numbering } from "../data/numbering";
import { defaultLayout, homeShortcuts, homeTiles } from "../ui/homeCatalog";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { HomeEditor } from "./HomeEditor";
import { CompanyPage } from "./CompanyPage";
import { ModulesPage } from "./ModulesPage";
import { useVisibleSettings } from "../data/modules";
import { AlertSettingsPanel } from "./NotificationSettings";
import type { IconName } from "../ui/navigation";

type Page = { kind: "menu" } | { kind: "block"; block: SettingsBlock } | { kind: "clientOptions"; theme?: string } | { kind: "home" } | { kind: "numbering" } | { kind: "alerts" } | { kind: "company" } | { kind: "modules" } | { kind: "autoDeliver" };

// Admin settings, by theme: each theme is set per role, then per user (and per client record).
// initialPage: opened straight from the home search (e.g. "company", "modules").
const directPages = ["home", "numbering", "alerts", "company", "modules", "autoDeliver", "clientOptions"] as const;
export function SettingsScreen({ onBack, onRoles, initialPage }: { onBack: () => void; onRoles?: () => void; initialPage?: string }) {
  const { featureBlocks, clientOptionBlocks } = useVisibleSettings();
  const [page, setPage] = useState<Page>(() => directPages.includes(initialPage as typeof directPages[number]) ? { kind: initialPage as typeof directPages[number] } as Page : { kind: "menu" });
  const [rolePerms, setRolePerms] = useState<Record<string, boolean>>({});
  const [userPerms, setUserPerms] = useState<Record<string, boolean>>({});
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [defaults, setDefaults] = useState<Partial<Record<ClientOptionKey, unknown>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([fetchRolePermissions(), fetchUserPermissions(), fetchAccounts(), fetchClients(), fetchClientDefaults()])
      .then(([roles, users, nextAccounts, nextClients, nextDefaults]) => {
        setRolePerms(Object.fromEntries(roles.map((row) => [`${row.role}|${row.feature}`, row.allowed])));
        setUserPerms(Object.fromEntries(users.map((row) => [`${row.user_id}|${row.feature}`, row.allowed])));
        setAccounts(nextAccounts);
        setClients(nextClients);
        setDefaults(nextDefaults);
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger le paramétrage. La migration 20261027 est-elle exécutée ?")))
      .finally(() => setLoading(false));
  }, []);

  // Optimistic update, rolled back if the database refuses.
  async function save<T>(apply: (value: T) => void, next: T, previous: T, task: () => Promise<void>) {
    apply(next);
    try {
      await task();
    } catch (cause) {
      apply(previous);
      notify("Paramétrage", errorMessage(cause, "Le réglage n’a pas pu être enregistré."));
    }
  }

  const roleValue = (role: Role, feature: Feature) => rolePerms[`${role === "staff" ? "supervisor" : role}|${feature}`] ?? false;
  const setRole = (role: Role, feature: Feature, value: boolean) => {
    const key = `${role}|${feature}`;
    void save((v: boolean) => setRolePerms((current) => ({ ...current, [key]: v })), value, !value, () => setRolePermission(role, feature, value));
  };
  const userValue = (userId: string, feature: Feature): boolean | null => userPerms[`${userId}|${feature}`] ?? null;
  const setUser = (userId: string, feature: Feature, value: boolean | null) => {
    const key = `${userId}|${feature}`;
    const previous = userValue(userId, feature);
    const apply = (v: boolean | null) => setUserPerms((current) => {
      const next = { ...current };
      if (v === null) delete next[key]; else next[key] = v;
      return next;
    });
    void save(apply, value, previous, () => setUserPermission(userId, feature, value));
  };
  const patchClient = (id: string, patch: Partial<ClientRecord>) => setClients((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));

  const back = <BackButton label="Paramétrage" onPress={() => setPage({ kind: "menu" })} />;

  if (page.kind === "block") {
    return <BlockPage
      block={page.block}
      header={back}
      accounts={accounts}
      clients={clients}
      roleValue={roleValue}
      setRole={setRole}
      userValue={userValue}
      setUser={setUser}
      setClientFeature={(record, feature, value) => {
        const overrides = { ...record.feature_overrides };
        if (value === null) delete overrides[feature]; else overrides[feature] = value;
        void save((v: Record<string, boolean>) => patchClient(record.id, { feature_overrides: v }), overrides, record.feature_overrides, () => updateClientOptions(record.id, { feature_overrides: overrides }));
      }}
    />;
  }
  if (page.kind === "clientOptions") {
    return <ClientOptionsPage
      theme={page.theme}
      header={back}
      clients={clients}
      defaults={defaults}
      setDefault={(key, value) => {
        const previous = defaults[key];
        void save((v: unknown) => {
          setDefaults((current) => ({ ...current, [key]: v }));
          // Clients without their own value follow the new default.
          setClients((current) => current.map((item) => item.custom_settings.includes(key) ? item : { ...item, [key]: v }));
        }, boolToOption(key, value), previous, () => setClientDefault(key, boolToOption(key, value)));
      }}
      setClientOption={(record, key, value) => {
        const custom = value === null ? record.custom_settings.filter((item) => item !== key) : [...new Set([...record.custom_settings, key])];
        const effective = value === null ? defaults[key] : boolToOption(key, value);
        const patch = { custom_settings: custom, [key]: effective } as Partial<ClientRecord>;
        const previous = { custom_settings: record.custom_settings, [key]: record[key] } as Partial<ClientRecord>;
        void save((v: Partial<ClientRecord>) => patchClient(record.id, v), patch, previous, () => updateClientOptions(record.id, patch));
      }}
    />;
  }
  if (page.kind === "home") return <HomeRolesPage header={back} />;
  if (page.kind === "numbering") return <NumberingPage header={back} />;
  if (page.kind === "company") return <CompanyPage header={back} />;
  if (page.kind === "modules") return <ModulesPage header={back} />;
  if (page.kind === "autoDeliver") return <AutoDeliverPage header={back} />;
  if (page.kind === "alerts") return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Notifications et e-mails" right={back} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled"><AlertSettingsPanel /></ScrollView>
  </View>;

  const exceptionCount = (block: SettingsBlock) => Object.keys(userPerms).filter((key) => block.items.some((item) => key.endsWith(`|${item.key}`))).length
    + (block.audience === "customer" ? clients.reduce((sum, record) => sum + Object.keys(record.feature_overrides ?? {}).length, 0) : 0);
  const customClients = clients.filter((record) => record.custom_settings?.length).length;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ADMINISTRATION" title="Paramétrage" right={<BackButton label="Admin" onPress={onBack} />} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
      {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
      <Text style={[ui.small, { marginTop: 8 }]}>Chaque thème se règle par profil, puis par utilisateur (exception). Les clients suivent un réglage commun, que chaque fiche peut adapter. L’administrateur garde tous les droits.</Text>
      <MenuSearch>
      <ListGroup title="Fonctions de l’application">
        <ListRow icon="apps-outline" title="Modules" detail="Activer ou masquer chaque fonction de votre formule pour votre équipe et vos clients (remises, retours, statistiques…)." onPress={() => setPage({ kind: "modules" })} />
      </ListGroup>
      {/* The team's rights live in one place: Rôles et accès (roles of the Pro, exceptions per person). */}
      <ListGroup title="Droits de l’équipe">
        <ListRow icon="key-outline" title="Rôles et accès" detail="Ce que chaque rôle permet, qui a quel rôle, exceptions par personne." onPress={() => onRoles?.()} />
      </ListGroup>
      <ListGroup title="Clients : espace et options">
        {featureBlocks.filter((block) => block.audience === "customer").map((block) => {
          const count = exceptionCount(block);
          return <ListRow key={block.key} icon={block.icon as IconName} title="Onglets de l’espace client" detail={`Commander, commandes, factures, messages, retours…${count ? ` · ${count} exception(s)` : ""}`} onPress={() => setPage({ kind: "block", block })} />;
        })}
        {clientOptionBlocks.map((block) => {
          const custom = clients.filter((record) => block.items.some((item) => record.custom_settings?.includes(item.key))).length;
          return <ListRow key={block.title} icon={block.icon as IconName} title={block.title} detail={`${block.items.map((item) => item.label.toLocaleLowerCase("fr")).join(", ")}${custom ? ` · ${custom} fiche(s) adaptée(s)` : ""}`} onPress={() => setPage({ kind: "clientOptions", theme: block.title })} />;
        })}
      </ListGroup>
      <ListGroup title="Commandes">
        <ListRow icon="checkmark-done-outline" title="Clôture automatique des livraisons" detail="Délai après lequel une commande expédiée passe en « Livrée » pour les clients qui ont l’option (Livraison et remise)." onPress={() => setPage({ kind: "autoDeliver" })} />
      </ListGroup>
      <ListGroup title="Communication">
        <ListRow icon="notifications-outline" title="Notifications et e-mails" detail="Événements notifiés (push, e-mail) et service d’envoi." onPress={() => setPage({ kind: "alerts" })} />
      </ListGroup>
      <ListGroup title="Documents">
        <ListRow icon="business-outline" title="Entreprise" detail="Raison sociale, adresse, matricule fiscal, RIB et couleur imprimés sur vos documents." onPress={() => setPage({ kind: "company" })} />
        <ListRow icon="barcode-outline" title="Numérotation des documents" detail="Format et numéro de départ des bons de livraison, factures, avoirs et retours." onPress={() => setPage({ kind: "numbering" })} />
      </ListGroup>
      <ListGroup title="Accueil">
        <ListRow icon="home-outline" title="Accueil par profil" detail="Chiffres et raccourcis proposés à chaque profil ; chacun peut ensuite personnaliser le sien." onPress={() => setPage({ kind: "home" })} />
      </ListGroup>
      </MenuSearch>
    </ScrollView>}
  </View>;
}

// Orders shipped and not confirmed by the driver: marked delivered after this delay (clients with the option).
function AutoDeliverPage({ header }: { header: React.ReactNode }) {
  const [hours, setHours] = useState<string>("");
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void supabase?.rpc("my_workflow_settings").then(({ data, error: rpcError }) => {
      if (rpcError) { setError(errorMessage(rpcError, "Réglage indisponible. La migration 20261121 est-elle exécutée ?")); return; }
      const value = Number((data as { auto_deliver_hours?: number } | null)?.auto_deliver_hours ?? 24);
      setSaved(value); setHours(String(value));
    });
  }, []);
  async function save() {
    if (!supabase) return;
    setBusy(true); setError("");
    const value = Math.round(Number(hours));
    const { error: rpcError } = await supabase.rpc("set_auto_deliver_hours", { p_hours: value });
    if (rpcError) setError(errorMessage(rpcError, "Le délai n’a pas pu être enregistré."));
    else { setSaved(value); notify("Paramétrage", "Délai enregistré."); }
    setBusy(false);
  }
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Clôture automatique" right={header} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <View style={ui.card}>
        <Text style={ui.small}>Pour les clients dont l’option « Livrée automatiquement après l’expédition » est activée (Paramétrage → Livraison et remise, ou leur fiche), une commande expédiée passe en « Livrée » après ce délai, même si le livreur ne l’a pas signalée. L’historique le précise.</Text>
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          {[2, 6, 12, 24, 48].map((value) => <Chip key={value} label={`${value} h`} selected={Number(hours) === value} onPress={() => setHours(String(value))} />)}
        </View>
        <Field label="Délai (heures, 1 à 720)" value={hours} onChangeText={setHours} keyboardType="number-pad" />
        {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
        <Button label="ENREGISTRER LE DÉLAI" onPress={save} busy={busy} disabled={!hours || Number(hours) === saved} style={{ marginTop: 8 }} />
      </View>
    </ScrollView>
  </View>;
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (text: string) => void; placeholder: string }) {
  return <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} autoCorrect={false} />;
}

function BlockPage({ block, header, accounts, clients, roleValue, setRole, userValue, setUser, setClientFeature }: {
  block: SettingsBlock;
  header: React.ReactNode;
  accounts: AdminAccount[];
  clients: ClientRecord[];
  roleValue: (role: Role, feature: Feature) => boolean;
  setRole: (role: Role, feature: Feature, value: boolean) => void;
  userValue: (userId: string, feature: Feature) => boolean | null;
  setUser: (userId: string, feature: Feature, value: boolean | null) => void;
  setClientFeature: (record: ClientRecord, feature: Feature, value: boolean | null) => void;
}) {
  type Sheet = "roles" | "users" | "clients";
  const [sheet, setSheet] = useState<Sheet>("roles");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const roles = configurableRoles.filter((item) => item.audience === block.audience);
  const term = search.trim().toLocaleLowerCase("fr");
  const people = accounts.filter((account) => (block.audience === "customer" ? account.role === "customer" : !["customer", "admin"].includes(account.role))
    && `${account.email} ${account.full_name} ${account.client_name ?? ""}`.toLocaleLowerCase("fr").includes(term));
  const records = clients.filter((record) => record.business_name.toLocaleLowerCase("fr").includes(term));
  const user = accounts.find((account) => account.id === userId);
  const record = clients.find((item) => item.id === clientId);

  const sheets: { key: Sheet; label: string }[] = [
    { key: "roles", label: "Par profil" },
    ...(block.audience === "customer" ? [{ key: "clients" as const, label: "Par client" }] : []),
    { key: "users", label: "Par utilisateur" },
  ];

  let body: React.ReactNode;
  if (sheet === "roles") {
    body = <View style={[ui.card, { paddingVertical: 4 }]}>
      {roles.length > 1 ? <View style={[styles.matrixRow, { borderBottomWidth: 1, borderBottomColor: colors.line }]}>
        <Text style={[ui.small, { flex: 1 }]}>Fonctionnalité</Text>
        {roles.map((item) => <Text key={item.role} style={styles.roleHead}>{item.short}</Text>)}
      </View> : null}
      {block.items.map((item) => <View key={item.key} style={styles.matrixRow}>
        <Text style={[ui.body, { flex: 1 }]}>{item.label}</Text>
        {roles.map((role) => <View key={role.role} style={styles.cell}>
          <Switch value={roleValue(role.role, item.key)} onValueChange={(value) => setRole(role.role, item.key, value)} trackColor={{ true: colors.primary, false: colors.line }} />
        </View>)}
      </View>)}
    </View>;
  } else if (sheet === "users") {
    body = user ? <View>
      <ListRow icon="person-outline" title={user.full_name || user.email} detail={`${roleLabels[user.role] ?? user.role}${user.client_name ? ` · ${user.client_name}` : ""} · ${user.email}`} right={<BackButton label="Liste" onPress={() => setUserId(null)} />} />
      {block.items.map((item) => {
        const fromClient = user.role === "customer" ? clients.find((c) => c.business_name === user.client_name)?.feature_overrides?.[item.key] : undefined;
        const inherited = fromClient ?? roleValue(user.role, item.key);
        return <View key={item.key} style={ui.card}>
          <Text style={ui.body}>{item.label}</Text>
          <TriState value={userValue(user.id, item.key)} inherited={inherited} inheritLabel={fromClient !== undefined ? "Fiche" : "Profil"} onChange={(value) => setUser(user.id, item.key, value)} />
        </View>;
      })}
    </View> : <>
      <Search value={search} onChange={setSearch} placeholder="Nom ou e-mail" />
      <ListGroup>
        {people.map((account) => {
          const count = block.items.filter((item) => userValue(account.id, item.key) !== null).length;
          return <ListRow key={account.id} title={account.full_name || account.email} detail={`${roleLabels[account.role] ?? account.role}${account.client_name ? ` · ${account.client_name}` : ""}${count ? ` · ${count} exception(s)` : ""}`} onPress={() => setUserId(account.id)} />;
        })}
        {people.length === 0 ? <ListRow title="Aucun compte" /> : null}
      </ListGroup>
    </>;
  } else {
    body = record ? <View>
      <ListRow icon="storefront-outline" title={record.business_name} detail="Ces réglages s’appliquent à tous les comptes de cette fiche." right={<BackButton label="Liste" onPress={() => setClientId(null)} />} />
      {block.items.map((item) => <View key={item.key} style={ui.card}>
        <Text style={ui.body}>{item.label}</Text>
        <TriState value={record.feature_overrides?.[item.key] ?? null} inherited={roleValue("customer", item.key)} inheritLabel="Profil" onChange={(value) => setClientFeature(record, item.key, value)} />
      </View>)}
    </View> : <>
      <Search value={search} onChange={setSearch} placeholder="Client" />
      <ListGroup>
        {records.map((item) => {
          const count = block.items.filter((feature) => item.feature_overrides?.[feature.key] !== undefined).length;
          return <ListRow key={item.id} title={item.business_name} detail={count ? `${count} réglage(s) propre(s)` : "Suit le profil Client"} onPress={() => setClientId(item.id)} />;
        })}
      </ListGroup>
    </>;
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title={block.title} right={header} />
    <Sheets items={sheets} value={sheet} onChange={(next) => { setSheet(next); setSearch(""); setUserId(null); setClientId(null); }} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">{body}</ScrollView>
  </View>;
}

function ClientOptionsPage({ theme, header, clients, defaults, setDefault, setClientOption }: {
  theme?: string;
  header: React.ReactNode;
  clients: ClientRecord[];
  defaults: Partial<Record<ClientOptionKey, unknown>>;
  setDefault: (key: ClientOptionKey, value: boolean) => void;
  setClientOption: (record: ClientRecord, key: ClientOptionKey, value: boolean | null) => void;
}) {
  const { featureBlocks, clientOptionBlocks } = useVisibleSettings();
  const [sheet, setSheet] = useState<"all" | "client">("all");
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const record = clients.find((item) => item.id === clientId);
  const term = search.trim().toLocaleLowerCase("fr");

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="OPTIONS DES CLIENTS" title={theme ?? "Options des clients"} right={header} />
    <Sheets items={[{ key: "all", label: "Tous les clients" }, { key: "client", label: "Par client" }]} value={sheet} onChange={(next) => { setSheet(next); setClientId(null); }} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      {sheet === "all" ? <>
        <Text style={[ui.small, { marginTop: 8 }]}>Réglage commun à tous les clients. Une fiche peut avoir sa propre valeur (onglet « Par client » ou dans la fiche).</Text>
        {clientOptionBlocks.filter((block) => !theme || block.title === theme).map((block) => <ListGroup key={block.title} title={block.title}>
          {block.items.map((item) => <ListRow key={item.key} title={item.label} detail={item.hint} right={<Switch value={optionToBool(item.key, defaults[item.key])} onValueChange={(value) => setDefault(item.key, value)} trackColor={{ true: colors.primary, false: colors.line }} />} />)}
        </ListGroup>)}
      </> : record ? <>
        <ListRow icon="storefront-outline" title={record.business_name} detail={`${record.custom_settings.length} option(s) propre(s)`} right={<BackButton label="Liste" onPress={() => setClientId(null)} />} />
        <ClientOptionsEditor record={record} defaults={defaults} theme={theme} onChange={(key, value) => setClientOption(record, key, value)} />
      </> : <>
        <Search value={search} onChange={setSearch} placeholder="Client" />
        <ListGroup>
          {clients.filter((item) => item.business_name.toLocaleLowerCase("fr").includes(term)).map((item) => <ListRow key={item.id} title={item.business_name} detail={item.custom_settings.length ? `${item.custom_settings.length} option(s) propre(s)` : "Suit le réglage commun"} onPress={() => setClientId(item.id)} />)}
        </ListGroup>
      </>}
    </ScrollView>
  </View>;
}

// Each option: follow the default for all clients, or this client's own yes / no.
export function ClientOptionsEditor({ record, defaults, onChange, disabled, theme }: {
  theme?: string;
  record: Pick<ClientRecord, ClientOptionKey | "custom_settings">;
  defaults: Partial<Record<ClientOptionKey, unknown>>;
  onChange: (key: ClientOptionKey, value: boolean | null) => void;
  disabled?: boolean;
}) {
  const { featureBlocks, clientOptionBlocks } = useVisibleSettings();
  return <>
    {clientOptionBlocks.filter((block) => !theme || block.title === theme).map((block) => <View key={block.title} style={{ marginTop: 10 }}>
      <Text style={styles.groupTitle}>{block.title.toLocaleUpperCase("fr")}</Text>
      {block.items.map((item) => <View key={item.key} style={[ui.card, { marginTop: 4 }]}>
        <Text style={ui.body}>{item.label}</Text>
        <Text style={ui.small}>{item.hint}</Text>
        <TriState
          value={record.custom_settings.includes(item.key) ? optionToBool(item.key, record[item.key]) : null}
          inherited={optionToBool(item.key, defaults[item.key])}
          inheritLabel="Tous"
          onChange={(value) => onChange(item.key, value)}
          disabled={disabled}
        />
      </View>)}
    </View>)}
  </>;
}

function HomeRolesPage({ header }: { header: React.ReactNode }) {
  const [layouts, setLayouts] = useState<Partial<Record<Role, HomeLayout>>>({});
  const [editing, setEditing] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => fetchRoleHomeLayouts().then(setLayouts).catch((cause: unknown) => notify("Accueil", errorMessage(cause, "Impossible de charger les accueils."))).finally(() => setLoading(false));
  useEffect(() => { void reload(); }, []);

  const audience = editing === "customer" ? "customer" : "team";
  const tiles = useMemo(() => homeTiles.filter((tile) => tile.audience === audience).map(({ key, label, icon }) => ({ key, label, icon })), [audience]);
  const shortcuts = useMemo(() => homeShortcuts.filter((item) => item.audience === audience).map(({ key, label, icon }) => ({ key, label, icon })), [audience]);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Accueil par profil" right={header} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
      <Text style={[ui.small, { marginTop: 8 }]}>L’accueil proposé à chaque profil. Chacun voit seulement ce que ses droits permettent, et peut personnaliser le sien depuis l’Accueil.</Text>
      <ListGroup>
        {configurableRoles.map((item) => <ListRow key={item.role} icon="home-outline" title={item.label} detail={layouts[item.role] ? `Personnalisé : ${layouts[item.role]!.tiles.length} chiffre(s), ${layouts[item.role]!.shortcuts.length} raccourci(s)` : "Accueil standard"} onPress={() => setEditing(item.role)} />)}
      </ListGroup>
    </ScrollView>}
    <HomeEditor
      visible={editing !== null}
      title={editing ? `Accueil · ${roleLabels[editing]}` : "Accueil"}
      tiles={tiles}
      shortcuts={shortcuts}
      value={(editing && layouts[editing]) || defaultLayout(audience)}
      resetLabel="REVENIR À L’ACCUEIL STANDARD"
      onSave={async (layout) => { if (editing) { await setRoleHomeLayout(editing, layout); await reload(); } }}
      onReset={async () => { if (editing) { await setRoleHomeLayout(editing, null); await reload(); } }}
      onClose={() => setEditing(null)}
    />
  </View>;
}

function NumberingPage({ header }: { header: React.ReactNode }) {
  const [items, setItems] = useState<Numbering[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetchNumbering().then(setItems).catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger la numérotation. La migration 20261030 est-elle exécutée ?"))).finally(() => setLoading(false));
  }, []);

  const patch = (type: string, values: Partial<Numbering>) => setItems((current) => current.map((item) => item.doc_type === type ? { ...item, ...values } : item));
  async function save(item: Numbering) {
    setBusy(item.doc_type);
    setError("");
    try {
      await saveNumbering(item);
      notify("Numérotation", `${docTypeLabels[item.doc_type]} : prochain numéro ${previewNumber(item)}.`);
    } catch (cause) {
      setError(errorMessage(cause, "La numérotation n’a pas pu être enregistrée."));
    } finally {
      setBusy(null);
    }
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Numérotation" right={header} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <Text style={[ui.small, { marginTop: 8 }]}>Le numéro est attribué à l’émission du document (BL : à l’acceptation de la commande). Un numéro déjà utilisé ne peut pas être réattribué.</Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {items.map((item) => <View key={item.doc_type} style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{docTypeLabels[item.doc_type]}</Text>
          <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>Prochain : {previewNumber(item)}</Text>
        </View>
        <View style={[ui.row, { marginTop: 4 }]}>
          <View style={{ flex: 1 }}><Field label="Préfixe" value={item.prefix} onChangeText={(text) => patch(item.doc_type, { prefix: text })} autoCapitalize="characters" /></View>
          <View style={{ flex: 1 }}><Field label="Chiffres" value={String(item.digits)} onChangeText={(text) => patch(item.doc_type, { digits: Math.min(10, Math.max(1, Number(text) || 1)) })} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Field label="Prochain n°" value={String(item.next_number)} onChangeText={(text) => patch(item.doc_type, { next_number: Math.max(1, Number(text) || 1) })} keyboardType="number-pad" /></View>
        </View>
        <View style={[ui.row, { marginTop: 8 }]}>
          <Text style={[ui.body, { flex: 1 }]}>Inclure l’année (ex. 2026-)</Text>
          <Switch value={item.with_year} onValueChange={(value) => patch(item.doc_type, { with_year: value })} trackColor={{ true: colors.primary, false: colors.line }} />
        </View>
        <View style={[ui.row, { marginTop: 4 }]}>
          <Text style={[ui.body, { flex: 1 }]}>Repartir à 1 chaque année</Text>
          <Switch value={item.yearly_reset} onValueChange={(value) => patch(item.doc_type, { yearly_reset: value })} trackColor={{ true: colors.primary, false: colors.line }} />
        </View>
        <Button label="ENREGISTRER" variant="secondary" onPress={() => save(item)} busy={busy === item.doc_type} style={{ marginTop: 8, alignSelf: "flex-start" }} />
      </View>)}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  matrixRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
  roleHead: { width: 58, textAlign: "center", color: colors.textSoft, fontSize: 10, fontWeight: "800" },
  cell: { width: 58, alignItems: "center" },
  groupTitle: { color: colors.textSoft, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginLeft: 2 },
});
