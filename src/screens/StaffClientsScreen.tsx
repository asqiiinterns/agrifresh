import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatClientNumber } from "../data/account";
import { createClient, fetchClients, printDeliveryPointQr, saveDeliveryPoint, setDeliveryPointActive, shareInvitation, updateClient, type ClientRecord, type DeliveryPoint, type DeliveryPointInput } from "../data/clients";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Only admins create client records (also enforced by the database).
export function StaffClientsScreen({ canCreate }: { canCreate: boolean }) {
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

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${clients.length} FICHES`} title="Clients" right={canCreate ? <Button label="+ NOUVEAU" onPress={() => setEditing("new")} /> : undefined} />
    <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun client" body="Créez la fiche de vos clients pour qu’ils puissent commander." />}
      renderItem={({ item }) => {
        const points = item.client_delivery_points.filter((point) => point.active);
        return <Pressable style={[ui.card, !item.active && ui.disabled]} onPress={() => setEditing(item)}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
            <Text style={[ui.small, { color: item.has_account ? colors.green : colors.amber, fontWeight: "800" }]}>{item.has_account ? "ACCÈS ACTIVÉ" : "NON ACTIVÉ"}</Text>
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

const emptyPoint: DeliveryPointInput = { label: "Principal", address_line: "", city: "", phone: "", instructions: "" };

function ClientEditor({ record, visible, onClose, onSaved }: { record: ClientRecord | null; visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [taxId, setTaxId] = useState("");
  const [showPrices, setShowPrices] = useState(true);
  const [showOrigin, setShowOrigin] = useState(false);
  const [stockManaged, setStockManaged] = useState(true);
  const [showStock, setShowStock] = useState(false);
  const [invoiceMode, setInvoiceMode] = useState<"auto" | "manual">("manual");
  const [receptionQr, setReceptionQr] = useState(false);
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
    setShowPrices(record?.show_prices ?? true);
    setShowOrigin(record?.show_origin ?? false);
    setStockManaged(record?.stock_managed ?? true);
    setShowStock(record?.show_stock ?? false);
    setInvoiceMode(record?.invoice_mode ?? "manual");
    setReceptionQr(record?.reception_qr ?? false);
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
      const input = { business_name: businessName, contact_name: contactName, email, phone, notes, tax_id: taxId, show_prices: showPrices, show_origin: showOrigin, show_stock: showStock, stock_managed: stockManaged, invoice_mode: invoiceMode, reception_qr: receptionQr };
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

  function invite() {
    if (!record?.email) {
      setError("Ajoutez l’adresse e-mail du client avant de l’inviter.");
      return;
    }
    void run(async () => {
      const result = await shareInvitation(record);
      if (result === "copied") notify("Invitation copiée", "Collez-la dans un e-mail ou un message au client.");
    });
  }

  function print(points: DeliveryPoint[]) {
    if (!record || points.length === 0) return;
    void run(() => printDeliveryPointQr(record, points));
  }

  const activePoints = record?.client_delivery_points.filter((point) => point.active) ?? [];

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
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
            <View style={[ui.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}><Text style={ui.body}>Afficher les prix au client</Text><Text style={ui.small}>Dans l’application et sur les bons de livraison.</Text></View>
              <Switch value={showPrices} onValueChange={setShowPrices} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
            <View style={[ui.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}><Text style={ui.body}>Afficher l’origine des produits</Text><Text style={ui.small}>Producteur, région et label sur le catalogue, les commandes et les bons de livraison.</Text></View>
              <Switch value={showOrigin} onValueChange={setShowOrigin} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
            <View style={[ui.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}><Text style={ui.body}>Gestion du stock</Text><Text style={ui.small}>Activée : ses commandes sont limitées au stock disponible et le réservent. Désactivée : production à la demande, sans limite de stock.</Text></View>
              <Switch value={stockManaged} onValueChange={setStockManaged} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
            <View style={[ui.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}><Text style={ui.body}>Afficher le stock au client</Text><Text style={ui.small}>Le client voit la quantité disponible de chaque produit en commandant.</Text></View>
              <Switch value={showStock} onValueChange={setShowStock} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
            <View style={[ui.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}><Text style={ui.body}>Réception par QR client</Text><Text style={ui.small}>Le livreur scanne le QR affiché dans l’application du client au lieu du QR collé au point de livraison.</Text></View>
              <Switch value={receptionQr} onValueChange={setReceptionQr} trackColor={{ true: colors.green, false: colors.line }} />
            </View>
            <Text style={[ui.body, { marginTop: 14 }]}>Facturation</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              <Chip label="Automatique (1 facture par commande acceptée)" selected={invoiceMode === "auto"} onPress={() => setInvoiceMode("auto")} />
              <Chip label="Manuelle (regroupée par le staff)" selected={invoiceMode === "manual"} onPress={() => setInvoiceMode("manual")} />
            </View>
            {record ? <View style={[ui.row, { marginTop: 12 }]}>
              <Text style={ui.body}>Fiche active (peut commander)</Text>
              <Switch value={active} onValueChange={setActive} trackColor={{ true: colors.green, false: colors.line }} />
            </View> : null}
            {record ? <Text style={[ui.small, { marginTop: 10, color: record.has_account ? colors.green : colors.amber }]}>
              {record.has_account ? "Le client a activé son accès." : "Le client n’a pas encore activé son accès avec cet e-mail."}
            </Text> : null}
          </View>

          {!record ? <View style={ui.card}>
            <Text style={ui.strong}>Point de livraison principal</Text>
            <PointFields values={firstPoint} onChange={setFirstPoint} />
          </View> : null}

          <Button label={record ? "ENREGISTRER LA FICHE" : "CRÉER LE CLIENT"} onPress={saveClient} busy={busy} style={{ marginTop: 14 }} />
          {record ? <Button label="PARTAGER L’INVITATION" variant="secondary" onPress={invite} disabled={busy} style={{ marginTop: 10 }} /> : null}

          {record ? <View style={ui.card}>
            <View style={ui.row}>
              <Text style={ui.strong}>Points de livraison</Text>
              {activePoints.length > 1 ? <Pressable onPress={() => print(activePoints)}><Text style={[ui.small, { color: colors.green, fontWeight: "800" }]}>IMPRIMER TOUS LES QR</Text></Pressable> : null}
            </View>
            <Text style={[ui.small, { marginTop: 4 }]}>Chaque point a son QR code, à coller sur place. Avec plusieurs points actifs, le client choisit le point à chaque commande.</Text>
            {record.client_delivery_points.map((point) => <View key={point.id} style={[ui.divider, !point.active && ui.disabled]}>
              <Text style={ui.strong}>{point.label}{!point.active ? " (désactivé)" : ""}</Text>
              <Text style={ui.body}>{point.address_line}, {point.city}{point.phone ? ` · ${point.phone}` : ""}</Text>
              {point.instructions ? <Text style={ui.small}>{point.instructions}</Text> : null}
              <View style={[ui.wrapRow, { marginTop: 8 }]}>
                {point.active ? <Button label="IMPRIMER LE QR" variant="secondary" onPress={() => print([point])} disabled={busy} /> : null}
                <Button label="MODIFIER" variant="secondary" onPress={() => setPointForm({ id: point.id, values: { label: point.label, address_line: point.address_line, city: point.city, phone: point.phone, instructions: point.instructions ?? "" } })} disabled={busy} />
                <Button label={point.active ? "DÉSACTIVER" : "RÉACTIVER"} variant={point.active ? "danger" : "secondary"} onPress={() => togglePoint(point)} disabled={busy} />
              </View>
            </View>)}

            {pointForm ? <View style={ui.divider}>
              <Text style={ui.strong}>{pointForm.id ? "Modifier le point" : "Nouveau point de livraison"}</Text>
              <PointFields values={pointForm.values} onChange={(values) => setPointForm({ ...pointForm, values })} />
              <View style={[ui.wrapRow, { marginTop: 12 }]}>
                <Button label="ENREGISTRER LE POINT" onPress={savePoint} busy={busy} />
                <Button label="ANNULER" variant="secondary" onPress={() => setPointForm(null)} disabled={busy} />
              </View>
            </View> : <Button label="+ AJOUTER UN POINT DE LIVRAISON" variant="secondary" onPress={() => setPointForm({ id: null, values: { ...emptyPoint, label: "" } })} disabled={busy} style={{ marginTop: 12 }} />}
          </View> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
