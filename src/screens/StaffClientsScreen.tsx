import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatClientNumber } from "../data/account";
import { type BillingSettings, createClient, fetchClients, printDeliveryPointQr, saveDeliveryPoint, setDeliveryPointActive, updateClient, type ClientRecord, type DeliveryPoint, type DeliveryPointInput } from "../data/clients";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader } from "../ui/components";
import { InviteModal } from "../ui/InviteModal";
import { errorMessage, notify } from "../ui/notify";
import { boolToOption, clientOptionKeys, fetchClientDefaults, useCan, type ClientOptionKey } from "../data/permissions";
import { ClientOptionsEditor } from "./SettingsScreen";
import { colors, ui } from "../ui/theme";
import { DocumentViewerHost } from "../ui/DocumentViewer";
import { QR, QrCode } from "../ui/Qr";

// Creating and editing client records follow the admin-defined permissions (also enforced by the database).
export function StaffClientsScreen({ embedded }: { embedded?: boolean } = {}) {
  const can = useCan();
  // Clients are chosen in Réseau → Annuaire among the Pros validated by Appro+.
  const [inviting, setInviting] = useState(false);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ClientRecord | "new" | null>(null);

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      const next = await fetchClients();
      setClients(next);
      setEditing((current) => current && current !== "new" ? next.find((item) => item.id === current.id) ?? null : current);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les clients."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload("initial"); }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return clients.filter((item) => `${item.business_name} ${item.contact_name} ${item.email ?? ""} ${formatClientNumber(item.client_number)}`.toLocaleLowerCase("fr").includes(term));
  }, [clients, search]);

  return <View style={embedded ? { flex: 1 } : ui.screen}>
    {embedded ? <View style={[ui.row, { paddingHorizontal: 14, paddingTop: 8 }]}>
      <Text style={[ui.small, { flex: 1 }]}>{clients.length} fiche(s) client · nouveaux clients : invitation ou Réseau → Annuaire</Text>
      <Button label="INVITER UN CLIENT" onPress={() => setInviting(true)} />
    </View> : <ScreenHeader eyebrow={`${clients.length} FICHES`} title="Clients" right={<Button label="INVITER" onPress={() => setInviting(true)} />} />}
    {/* A new client joins by invitation (link, e-mail, WhatsApp…) or through the directory: records are never typed by hand. */}
    {inviting ? <InviteModal visible side="client" onClose={() => setInviting(false)} /> : null}
    <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun client" body="Invitez vos clients ou trouvez-les dans Réseau → Annuaire : leur fiche se crée à leur arrivée." />}
      renderItem={({ item }) => {
        const points = item.client_delivery_points.filter((point) => point.active);
        return <Pressable style={[ui.card, !item.active && ui.disabled]} onPress={() => setEditing(item)}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
            <Text style={[ui.small, { color: item.has_account ? colors.primary : colors.amber, fontWeight: "800" }]}>{item.has_account ? "ACCÈS ACTIVÉ" : "NON ACTIVÉ"}</Text>
          </View>
          <Text style={ui.small}>{formatClientNumber(item.client_number)}{item.contact_name ? ` · ${item.contact_name}` : ""}{item.phone ? ` · ${item.phone}` : ""}</Text>
          <Text style={[ui.small, { marginTop: 4 }]}>{points.length} point{points.length > 1 ? "s" : ""} de livraison{!item.active ? " · fiche désactivée" : ""}</Text>
        </Pressable>;
      }}
    />}

    <ClientEditor
      record={editing === "new" ? null : editing}
      visible={editing !== null}
      onClose={() => setEditing(null)}
      onSaved={() => void reload("silent")}
    />
  </View>;
}

type Options = Pick<ClientRecord, ClientOptionKey | "custom_settings">;
const blankOptions: Options = { show_prices: true, show_origin: false, show_stock: false, stock_managed: true, invoice_mode: "manual", reception_qr: false, history_enabled: true, reconfirm_declined: true, scan_delivery_note: true, scan_client_qr: true, payment_reminders: true, reminder_opt_out_allowed: true, delivery_signature: false, driver_prices: false, auto_accept: false, auto_deliver: false, delivery_note_client: true, custom_settings: [] };
const blankBilling: BillingSettings = { payment_terms_days: 30, reminder_interval_days: 7, billing_frequency: "manual", billing_every_days: 7, billing_start: null, billing_month_day: 1 };
const pickOptions = (record: ClientRecord): Options => ({ ...Object.fromEntries(clientOptionKeys.map((key) => [key, record[key]])), custom_settings: record.custom_settings ?? [] }) as Options;

const emptyPoint: DeliveryPointInput = { label: "Principal", address_line: "", city: "", phone: "", instructions: "" };

function ClientEditor({ record, visible, onClose, onSaved }: { record: ClientRecord | null; visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [shownQr, setShownQr] = useState<DeliveryPoint | null>(null);
  const can = useCan();
  const canEdit = record ? can("clients.edit") : can("clients.create");
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [taxId, setTaxId] = useState("");
  const [options, setOptions] = useState<Options>(blankOptions);
  const [defaults, setDefaults] = useState<Partial<Record<ClientOptionKey, unknown>>>({});
  const [billing, setBilling] = useState<BillingSettings>(blankBilling);
  const [firstPoint, setFirstPoint] = useState<DeliveryPointInput>(emptyPoint);
  const [pointForm, setPointForm] = useState<{ id: string | null; values: DeliveryPointInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setBusinessName(record?.business_name ?? "");
    setContactName(record?.contact_name ?? "");
    setEmail(record?.email ?? "");
    setPhone(record?.phone ?? "");
    setNotes(record?.notes ?? "");
    setTaxId(record?.tax_id ?? "");
    setOptions(record ? pickOptions(record) : blankOptions);
    setBilling(record ? { payment_terms_days: record.payment_terms_days ?? 30, reminder_interval_days: record.reminder_interval_days ?? 7, billing_frequency: record.billing_frequency ?? "manual", billing_every_days: record.billing_every_days ?? 7, billing_start: record.billing_start ?? null, billing_month_day: record.billing_month_day ?? 1 } : blankBilling);
    void fetchClientDefaults().then((next) => {
      setDefaults(next);
      // A new record starts on the defaults for all clients.
      if (!record) setOptions((current) => ({ ...current, ...next }) as Options);
    }).catch(() => setDefaults({}));
    setActive(record?.active ?? true);
    setFirstPoint(emptyPoint);
    setPointForm(null);
    setError("");
  }, [visible, record?.id]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause, "L’enregistrement a échoué."));
    } finally {
      setBusy(false);
    }
  }

  function saveClient() {
    if (!businessName.trim()) {
      setError("Le nom du client est obligatoire.");
      return;
    }
    if (!record && (!firstPoint.address_line.trim() || !firstPoint.city.trim())) {
      setError("Renseignez l’adresse et la ville du premier point de livraison.");
      return;
    }
    void run(async () => {
      // Only this client's own options are sent; the database applies the defaults to the others.
      const input = { business_name: businessName, contact_name: contactName, email, phone, notes, tax_id: taxId, custom_settings: options.custom_settings, ...Object.fromEntries(options.custom_settings.map((key) => [key, options[key]])), ...billing };
      if (record) await updateClient(record.id, { ...input, active });
      else await createClient(input, firstPoint);
      onSaved();
      if (!record) onClose();
      else notify("Fiche enregistrée");
    });
  }

  function savePoint() {
    if (!record || !pointForm) return;
    if (!pointForm.values.address_line.trim() || !pointForm.values.city.trim()) {
      setError("L’adresse et la ville du point de livraison sont obligatoires.");
      return;
    }
    void run(async () => {
      await saveDeliveryPoint(record.id, pointForm.id, pointForm.values);
      setPointForm(null);
      onSaved();
    });
  }

  function togglePoint(point: DeliveryPoint) {
    void run(async () => {
      await setDeliveryPointActive(point.id, !point.active);
      onSaved();
    });
  }

  // Invitation link (e-mail, WhatsApp, Messenger, SMS…): the person becomes the Responsable of this client's space.
  const [inviting, setInviting] = useState(false);
  function invite() {
    if (!record) return;
    setInviting(true);
  }

  function print(points: DeliveryPoint[]) {
    if (!record || points.length === 0) return;
    void run(() => printDeliveryPointQr(record, points));
  }

  const activePoints = record?.client_delivery_points.filter((point) => point.active) ?? [];

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <DocumentViewerHost />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader
          eyebrow={record ? formatClientNumber(record.client_number) : "NOUVELLE FICHE"}
          title={record ? record.business_name : "Nouveau client"}
          right={<CloseButton onPress={onClose} />}
        />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}

          <View style={ui.card}>
            <Text style={ui.strong}>Fiche client</Text>
            <Field label="Nom de l’établissement" value={businessName} onChangeText={setBusinessName} autoCapitalize="words" />
            <Field label="Contact" value={contactName} onChangeText={setContactName} autoCapitalize="words" />
            <Field label="E-mail de connexion du client" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            <Field label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field label="Matricule fiscal (pour les factures)" value={taxId} onChangeText={setTaxId} autoCapitalize="characters" />
            <Field label="Notes internes" value={notes} onChangeText={setNotes} multiline />
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Options</Text>
            <Text style={ui.small}>« Tous » suit le réglage commun à tous les clients (Admin → Paramétrage) ; Oui / Non est propre à ce client.</Text>
            <ClientOptionsEditor record={options} defaults={defaults} disabled={!canEdit} onChange={(key, value) => setOptions((current) => ({
              ...current,
              custom_settings: value === null ? current.custom_settings.filter((item) => item !== key) : [...new Set([...current.custom_settings, key])],
              [key]: value === null ? defaults[key] ?? current[key] : boolToOption(key, value),
            }))} />
            {record ? <View style={[ui.row, { justifyContent: "flex-start", marginTop: 12 }]}>
              <Switch value={active} onValueChange={setActive} trackColor={{ true: colors.primary, false: colors.line }} />
              <Text style={ui.body}>Fiche active (peut commander)</Text>
            </View> : null}
            {record ? <Text style={[ui.small, { marginTop: 10, color: record.has_account ? colors.primary : colors.amber }]}>
              {record.has_account ? "Le client a activé son accès." : "Le client n’a pas encore activé son accès avec cet e-mail."}
            </Text> : null}
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Fréquence de facturation et paiement</Text>
            <Text style={ui.small}>Les clients à facturer apparaissent dans « À décider » à la date prévue.</Text>
            <View style={[ui.wrapRow, { marginTop: 8 }]}>
              <Chip label="Manuelle" selected={billing.billing_frequency === "manual"} onPress={() => setBilling({ ...billing, billing_frequency: "manual" })} />
              <Chip label="Tous les X jours" selected={billing.billing_frequency === "every_n_days"} onPress={() => setBilling({ ...billing, billing_frequency: "every_n_days" })} />
              <Chip label="Un jour fixe par mois" selected={billing.billing_frequency === "monthly_day"} onPress={() => setBilling({ ...billing, billing_frequency: "monthly_day" })} />
            </View>
            {billing.billing_frequency === "every_n_days" ? <View style={ui.row}>
              <View style={{ flex: 1 }}><Field label="Tous les (jours)" value={String(billing.billing_every_days)} onChangeText={(text) => setBilling({ ...billing, billing_every_days: Math.min(365, Math.max(1, Number(text) || 1)) })} keyboardType="number-pad" /></View>
              <View style={{ flex: 1 }}><Field label="À partir du (AAAA-MM-JJ)" value={billing.billing_start ?? ""} onChangeText={(text) => setBilling({ ...billing, billing_start: text.trim() || null })} placeholder="2026-11-01" /></View>
            </View> : null}
            {billing.billing_frequency === "monthly_day" ? <Field label="Jour du mois (1 à 28)" value={String(billing.billing_month_day)} onChangeText={(text) => setBilling({ ...billing, billing_month_day: Math.min(28, Math.max(1, Number(text) || 1)) })} keyboardType="number-pad" /> : null}
            <View style={ui.row}>
              <View style={{ flex: 1 }}><Field label="Délai de paiement (jours)" value={String(billing.payment_terms_days)} onChangeText={(text) => setBilling({ ...billing, payment_terms_days: Math.min(365, Math.max(0, Number(text) || 0)) })} keyboardType="number-pad" /></View>
              <View style={{ flex: 1 }}><Field label="Relancer tous les (jours)" value={String(billing.reminder_interval_days)} onChangeText={(text) => setBilling({ ...billing, reminder_interval_days: Math.min(90, Math.max(1, Number(text) || 1)) })} keyboardType="number-pad" /></View>
            </View>
          </View>

          {!record ? <View style={ui.card}>
            <Text style={ui.strong}>Point de livraison principal</Text>
            <PointFields values={firstPoint} onChange={setFirstPoint} />
          </View> : null}

          {canEdit ? <Button label={record ? "ENREGISTRER LA FICHE" : "CRÉER LE CLIENT"} onPress={saveClient} busy={busy} style={{ marginTop: 14 }} /> : <Text style={[ui.small, { marginTop: 14 }]}>Consultation seule : votre profil ne permet pas de modifier les fiches.</Text>}
          {record ? <Button label={record.has_account ? "INVITER UNE AUTRE PERSONNE" : "INVITER (E-MAIL, WHATSAPP, SMS…)"} variant="secondary" onPress={invite} disabled={busy} style={{ marginTop: 10 }} /> : null}
          {record && inviting ? <InviteModal visible side="client" clientId={record.id} name={record.contact_name || record.business_name} phone={record.phone} email={record.email ?? ""} onClose={() => setInviting(false)} /> : null}

          {record ? <View style={ui.card}>
            <View style={ui.row}>
              <Text style={ui.strong}>Points de livraison</Text>
              {activePoints.length > 1 ? <Pressable onPress={() => print(activePoints)}><Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>IMPRIMER TOUS LES QR</Text></Pressable> : null}
            </View>
            <Text style={[ui.small, { marginTop: 4 }]}>Chaque point a son QR code, à coller sur place. Avec plusieurs points actifs, le client choisit le point à chaque commande.</Text>
            {record.client_delivery_points.map((point) => <View key={point.id} style={[ui.divider, !point.active && ui.disabled]}>
              <Text style={ui.strong}>{point.label}{!point.active ? " (désactivé)" : ""}</Text>
              <Text style={ui.body}>{point.address_line}, {point.city}{point.phone ? ` · ${point.phone}` : ""}</Text>
              {point.instructions ? <Text style={ui.small}>{point.instructions}</Text> : null}
              <View style={[ui.wrapRow, { marginTop: 8 }]}>
                {point.active ? <Button label="AFFICHER LE QR" variant="secondary" onPress={() => setShownQr(point)} /> : null}
                {point.active ? <Button label="IMPRIMER" variant="secondary" onPress={() => print([point])} disabled={busy} /> : null}
                {canEdit ? <Button label="MODIFIER" variant="secondary" onPress={() => setPointForm({ id: point.id, values: { label: point.label, address_line: point.address_line, city: point.city, phone: point.phone, instructions: point.instructions ?? "" } })} disabled={busy} /> : null}
                {canEdit ? <Button label={point.active ? "DÉSACTIVER" : "RÉACTIVER"} variant={point.active ? "danger" : "secondary"} onPress={() => togglePoint(point)} disabled={busy} /> : null}
              </View>
            </View>)}

            {pointForm ? <View style={ui.divider}>
              <Text style={ui.strong}>{pointForm.id ? "Modifier le point" : "Nouveau point de livraison"}</Text>
              <PointFields values={pointForm.values} onChange={(values) => setPointForm({ ...pointForm, values })} />
              <View style={[ui.wrapRow, { marginTop: 12 }]}>
                <Button label="ENREGISTRER LE POINT" onPress={savePoint} busy={busy} />
                <Button label="ANNULER" variant="secondary" onPress={() => setPointForm(null)} disabled={busy} />
              </View>
            </View> : !canEdit ? null : <Button label="+ AJOUTER UN POINT DE LIVRAISON" variant="secondary" onPress={() => setPointForm({ id: null, values: { ...emptyPoint, label: "" } })} disabled={busy} style={{ marginTop: 12 }} />}
          </View> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
    <Modal visible={shownQr !== null} transparent animationType="fade" onRequestClose={() => setShownQr(null)}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setShownQr(null)}>
        <View style={{ backgroundColor: colors.white, borderRadius: 14, padding: 18, alignItems: "center", gap: 8 }}>
          <Text style={ui.strong}>{shownQr?.label}</Text>
          {shownQr ? <QrCode value={QR.point(shownQr.qr_token)} size={240} /> : null}
          <Text style={[ui.small, { textAlign: "center" }]}>Le livreur scanne ce code à la livraison. Touchez pour fermer.</Text>
        </View>
      </Pressable>
    </Modal>
  </Modal>;
}

function PointFields({ values, onChange }: { values: DeliveryPointInput; onChange: (values: DeliveryPointInput) => void }) {
  const set = (key: keyof DeliveryPointInput) => (text: string) => onChange({ ...values, [key]: text });
  return <>
    <Field label="Nom du point (ex. Cuisine centrale, Magasin Lac)" value={values.label} onChangeText={set("label")} />
    <Field label="Adresse" value={values.address_line} onChangeText={set("address_line")} />
    <Field label="Ville" value={values.city} onChangeText={set("city")} autoCapitalize="words" />
    <Field label="Téléphone sur place (facultatif)" value={values.phone} onChangeText={set("phone")} keyboardType="phone-pad" />
    <Field label="Consignes de livraison (facultatif)" value={values.instructions ?? ""} onChangeText={set("instructions")} multiline />
  </>;
}
