import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View , Linking } from "react-native";
import { Text } from "../ui/Text";
import { actionLabels, describeChanges, entityLabels, fetchAudit, type AuditEntry } from "../data/audit";
import { roleLabels, type Role } from "../data/account";
import { fetchVehicles, saveVehicle, setDefaultVehicle, type Vehicle, type VehicleInput } from "../data/fleet";
import { fetchLocationRequestStatus, fetchTeamLocations, requestLocation, setLocationTracking, type LocationRequestStatus, type TeamLocation } from "../data/workplace";

import { BackButton, Button, EmptyState, Field, ListGroup, ListRow, Loading, ScreenHeader, formatDateTime, toDayKey } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const emptyVehicle: VehicleInput = { label: "", plate: "", notes: "", active: true };

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 24 },
  dialog: { backgroundColor: colors.white, borderRadius: 12, padding: 16 },
});

// Delivery fleet: the vehicles a driver can pick when shipping.
export function FleetPage({ onBack }: { onBack: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ id: string | null; values: VehicleInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reload() {
    try {
      setVehicles(await fetchVehicles(true));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger la flotte."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function save() {
    if (!form) return;
    if (!form.values.label.trim()) {
      setError("Donnez un nom au véhicule.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveVehicle(form.id, form.values);
      setForm(null);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Le véhicule n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof VehicleInput) => (value: string | boolean) => { if (form) setForm({ ...form, values: { ...form.values, [key]: value } }); };

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${vehicles.filter((item) => item.active).length} VÉHICULE(S) EN SERVICE`} title="Flotte" right={<BackButton label="Admin" onPress={onBack} />} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <Text style={[ui.small, { marginTop: 8 }]}>Le livreur peut choisir l’un de ces véhicules à chaque expédition ; sans choix, c’est le véhicule prévu pour la commande, sinon le véhicule par défaut. Une expédition n’est jamais bloquée faute de véhicule. Un véhicule retiré n’est plus proposé mais reste dans l’historique.</Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {form ? <View style={ui.card}>
        <Text style={ui.strong}>{form.id ? "Modifier le véhicule" : "Nouveau véhicule"}</Text>
        <Field label="Nom (ex. Camion frigo 1)" value={form.values.label} onChangeText={set("label")} />
        <Field label="Immatriculation" value={form.values.plate} onChangeText={set("plate")} autoCapitalize="characters" />
        <Field label="Notes (capacité, chauffeur habituel…)" value={form.values.notes} onChangeText={set("notes")} />
        <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
          <Switch value={form.values.active} onValueChange={set("active")} trackColor={{ true: colors.primary, false: colors.line }} />
          <Text style={ui.body}>En service</Text>
        </View>
        <View style={[ui.wrapRow, { marginTop: 10 }]}>
          <Button label="ENREGISTRER" onPress={() => save()} busy={busy} />
          <Button label="ANNULER" variant="secondary" onPress={() => setForm(null)} disabled={busy} />
          {form.id && form.values.active && !vehicles.find((item) => item.id === form.id)?.is_default ? <Button label="VÉHICULE PAR DÉFAUT" variant="secondary" onPress={async () => {
            try { await setDefaultVehicle(form.id!); setForm(null); await reload(); } catch (cause) { setError(errorMessage(cause, "Réglage impossible. La migration 20261127 est-elle exécutée ?")); }
          }} /> : null}
        </View>
      </View> : <Button label="+ AJOUTER UN VÉHICULE" onPress={() => setForm({ id: null, values: emptyVehicle })} style={{ marginTop: 10 }} />}
      {vehicles.length ? <ListGroup>
        {vehicles.map((vehicle) => <ListRow
          key={vehicle.id}
          icon="car-outline"
          title={`${vehicle.label}${vehicle.active ? "" : " (retiré)"}${vehicle.is_default ? " · par défaut" : ""}`}
          detail={[vehicle.plate, vehicle.notes].filter(Boolean).join(" · ") || undefined}
          onPress={() => setForm({ id: vehicle.id, values: { label: vehicle.label, plate: vehicle.plate, notes: vehicle.notes, active: vehicle.active } })}
        />)}
      </ListGroup> : <EmptyState title="Aucun véhicule" body="Ajoutez les véhicules de livraison : le livreur les choisira à l’expédition." />}
    </ScrollView>}
  </View>;
}

// Where a colleague is: asked to her, she accepts or refuses. Without answer within a minute, the last known
// position is shown only if the administrator allowed tracking for her account (or if I am the administrator);
// she is told who looked. The administrator switches tracking on or off per account.
export function LocationPage({ onBack, isAdmin = false }: { onBack: () => void; isAdmin?: boolean }) {
  const [people, setPeople] = useState<TeamLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState<{ name: string; requestId: string } | null>(null);
  const [status, setStatus] = useState<LocationRequestStatus | null>(null);

  async function ask(person: TeamLocation) {
    try {
      const requestId = await requestLocation(person.user_id);
      setStatus(null);
      setAsking({ name: person.name, requestId });
    } catch (cause) {
      notify("Localisation", errorMessage(cause, "La demande n’a pas pu être envoyée. La migration 20261123 est-elle exécutée ?"));
    }
  }

  // While waiting: the answer, or the end of the minute.
  useEffect(() => {
    if (!asking) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await fetchLocationRequestStatus(asking.requestId);
        if (active) setStatus(next);
        return next.status !== "pending";
      } catch { return false; }
    };
    void poll();
    const timer = setInterval(() => { void poll().then((done) => { if (done) clearInterval(timer); }); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [asking?.requestId]);

  async function toggleTracking(person: TeamLocation, allowed: boolean) {
    setPeople((current) => current.map((item) => item.user_id === person.user_id ? { ...item, tracking: allowed } : item));
    try {
      await setLocationTracking(person.user_id, allowed);
    } catch (cause) {
      setPeople((current) => current.map((item) => item.user_id === person.user_id ? { ...item, tracking: !allowed } : item));
      notify("Localisation", errorMessage(cause, "Le réglage n’a pas pu être enregistré."));
    }
  }

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setPeople(await fetchTeamLocations());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les positions. La migration 20261103 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  const ago = (iso: string) => {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return minutes < 60 ? `il y a ${minutes} min` : minutes < 1440 ? `il y a ${Math.round(minutes / 60)} h` : formatDateTime(iso);
  };
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="POSITION DES COMPTES" title="Localisation" right={<BackButton label="Admin" onPress={onBack} />} />
    {loading ? <Loading /> : <FlatList
      data={people}
      keyExtractor={(item) => item.user_id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{error || "Touchez « Demander la position » : la personne est prévenue et accepte ou refuse. Sans réponse en une minute, sa dernière position n’est montrée que si le repérage est autorisé pour son compte (ou à l’administrateur), et elle en est informée."}</Text>}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun autre compte dans votre équipe"
        body="Seuls les comptes actifs de votre équipe apparaissent ici (pas vous-même ni vos clients). Invitez un collègue ou validez son compte dans Admin → Comptes." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>{item.name}</Text>
            <Text style={ui.small}>{roleLabels[item.role as Role] ?? item.role}{item.updated_at ? ` · dernière position ${ago(item.updated_at)}` : " · aucune position connue"}</Text>
          </View>
          <Button label="DEMANDER LA POSITION" variant="secondary" onPress={() => ask(item)} />
        </View>
        {isAdmin ? <View style={[ui.row, { justifyContent: "flex-start", marginTop: 8 }]}>
          <Switch value={!!item.tracking} onValueChange={(value) => void toggleTracking(item, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
          <View style={{ flex: 1 }}>
            <Text style={ui.body}>Repérage autorisé</Text>
            <Text style={ui.small}>Sans réponse dans la minute, sa dernière position est montrée ; elle est prévenue à chaque fois.</Text>
          </View>
        </View> : null}
      </View>}
    />}
    <Modal visible={asking !== null} transparent animationType="fade" onRequestClose={() => setAsking(null)}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={ui.strong}>Position de {asking?.name}</Text>
          {!status || status.status === "pending" ? <>
            <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
            <Text style={[ui.small, { marginTop: 8, textAlign: "center" }]}>En attente de sa réponse{status ? ` · ${status.seconds_left} s` : ""}.</Text>
          </> : status.status === "accepted" || status.status === "automatic" ? <>
            {status.latitude !== null && status.longitude !== null ? <>
              <Text style={[ui.body, { marginTop: 8 }]}>{status.status === "accepted" ? "Position partagée à l’instant." : `Dernière position connue${status.located_at ? ` (${ago(status.located_at)})` : ""}, sans réponse de sa part : elle en est informée.`}{status.accuracy ? ` Précision ±${Math.round(status.accuracy)} m.` : ""}</Text>
              <Button label="OUVRIR LA CARTE" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${status.latitude},${status.longitude}`)} style={{ marginTop: 10 }} />
            </> : <Text style={[ui.body, { marginTop: 8 }]}>Aucune position connue pour ce compte.</Text>}
          </> : <Text style={[ui.body, { marginTop: 8 }]}>{status.status === "refused" ? "Elle a refusé de partager sa position." : "Pas de réponse dans la minute : sa position ne peut pas être montrée sans son accord."}</Text>}
          <Button label="FERMER" variant="secondary" onPress={() => { setAsking(null); void reload(); }} style={{ marginTop: 12 }} />
        </View>
      </View>
    </Modal>
  </View>;
}

// Audit trail: every change, by whom and when, filterable by person, subject and period.
export function AuditPage({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<DateFilterValue>(() => presets.today.value());
  const [actor, setActor] = useState("all");
  const [entity, setEntity] = useState("all");
  const [openId, setOpenId] = useState<number | null>(null);

  // Loads from 30 days back, or from the first calendar day picked if earlier.
  const since = useMemo(() => {
    const floor = new Date();
    floor.setDate(floor.getDate() - 30);
    const key = toDayKey(floor);
    return period?.from && period.from < key ? period.from : key;
  }, [period]);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setEntries(await fetchAudit(`${since}T00:00:00`));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger le journal. La migration 20261027 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, [since]);

  const actors = useMemo(() => [...new Map(entries.map((entry) => [entry.actor_id ?? "system", entry.actor_name ?? "Système"])).entries()], [entries]);
  const entities = useMemo(() => [...new Set(entries.map((entry) => entry.entity))], [entries]);
  const term = search.trim().toLocaleLowerCase("fr");
  const visible = entries.filter((entry) => matchesDate(entry.at, period)
    && (actor === "all" || (entry.actor_id ?? "system") === actor)
    && (entity === "all" || entry.entity === entity)
    && (!term || `${entry.label ?? ""} ${entry.actor_name ?? ""} ${describeChanges(entry).join(" ")}`.toLocaleLowerCase("fr").includes(term)));

  const filters: Filter[] = [
    { kind: "date", title: "Période", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: period, onChange: setPeriod },
    { kind: "choice", title: "Utilisateur", options: [{ key: "all", label: "Tous" }, ...actors.map(([key, label]) => ({ key, label }))], value: actor, defaultValue: "all", onChange: setActor },
    { kind: "choice", title: "Sujet", options: [{ key: "all", label: "Tous" }, ...entities.map((key) => ({ key, label: entityLabels[key] ?? key }))], value: entity, defaultValue: "all", onChange: setEntity },
  ];

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="TRAÇABILITÉ" title="Journal des actions" right={<BackButton label="Admin" onPress={onBack} />} />
    <FilterBar search={search} onSearch={setSearch} placeholder="Commande, client, produit…" filters={filters} />
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(entry) => String(entry.id)}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{error || `${visible.length} action(s)`}</Text>}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune action" body="Rien ne correspond à ces filtres." />}
      renderItem={({ item }) => {
        const lines = describeChanges(item);
        const open = openId === item.id;
        return <Pressable style={ui.card} onPress={() => setOpenId(open ? null : item.id)}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.label ?? entityLabels[item.entity] ?? item.entity}</Text>
            <Text style={ui.small}>{formatDateTime(item.at)}</Text>
          </View>
          <Text style={ui.small}>
            <Text style={{ fontWeight: "800", color: colors.text }}>{item.actor_name ?? "Système"}</Text>
            {item.actor_role ? ` (${roleLabels[item.actor_role as Role] ?? item.actor_role})` : ""} · {actionLabels[item.action]} · {entityLabels[item.entity] ?? item.entity}
          </Text>
          {(open ? lines : lines.slice(0, 2)).map((line, index) => <Text key={index} style={[ui.small, { color: colors.text }]}>{line}</Text>)}
          {!open && lines.length > 2 ? <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>+ {lines.length - 2} détail(s)</Text> : null}
        </Pressable>;
      }}
    />}
  </View>;
}
