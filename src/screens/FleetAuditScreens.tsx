import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";
import { Text } from "../ui/Text";
import { actionLabels, describeChanges, entityLabels, fetchAudit, type AuditEntry } from "../data/audit";
import { roleLabels, type Role } from "../data/account";
import { fetchVehicles, saveVehicle, type Vehicle, type VehicleInput } from "../data/fleet";
import { fetchTeamLocations, type TeamLocation } from "../data/workplace";
import { Linking } from "react-native";
import { BackButton, Button, EmptyState, Field, ListGroup, ListRow, Loading, ScreenHeader, formatDateTime, toDayKey } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const emptyVehicle: VehicleInput = { label: "", plate: "", notes: "", active: true };

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
      <Text style={[ui.small, { marginTop: 8 }]}>Le livreur choisit l’un de ces véhicules à chaque expédition. Un véhicule retiré n’est plus proposé mais reste dans l’historique.</Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {form ? <View style={ui.card}>
        <Text style={ui.strong}>{form.id ? "Modifier le véhicule" : "Nouveau véhicule"}</Text>
        <Field label="Nom (ex. Camion frigo 1)" value={form.values.label} onChangeText={set("label")} />
        <Field label="Immatriculation" value={form.values.plate} onChangeText={set("plate")} autoCapitalize="characters" />
        <Field label="Notes (capacité, chauffeur habituel…)" value={form.values.notes} onChangeText={set("notes")} />
        <View style={[ui.row, { marginTop: 10 }]}>
          <Text style={ui.body}>En service</Text>
          <Switch value={form.values.active} onValueChange={set("active")} trackColor={{ true: colors.primary, false: colors.line }} />
        </View>
        <View style={[ui.wrapRow, { marginTop: 10 }]}>
          <Button label="ENREGISTRER" onPress={() => save()} busy={busy} />
          <Button label="ANNULER" variant="secondary" onPress={() => setForm(null)} disabled={busy} />
        </View>
      </View> : <Button label="+ AJOUTER UN VÉHICULE" onPress={() => setForm({ id: null, values: emptyVehicle })} style={{ marginTop: 10 }} />}
      {vehicles.length ? <ListGroup>
        {vehicles.map((vehicle) => <ListRow
          key={vehicle.id}
          icon="car-outline"
          title={`${vehicle.label}${vehicle.active ? "" : " (retiré)"}`}
          detail={[vehicle.plate, vehicle.notes].filter(Boolean).join(" · ") || undefined}
          onPress={() => setForm({ id: vehicle.id, values: { label: vehicle.label, plate: vehicle.plate, notes: vehicle.notes, active: vehicle.active } })}
        />)}
      </ListGroup> : <EmptyState title="Aucun véhicule" body="Ajoutez les véhicules de livraison : le livreur les choisira à l’expédition." />}
    </ScrollView>}
  </View>;
}

// Where connected accounts are (last position, only for those who agreed to share it).
export function LocationPage({ onBack }: { onBack: () => void }) {
  const [people, setPeople] = useState<TeamLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

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
      ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{error || "Seuls les comptes dont le profil le permet (Paramétrage → Personnel) et qui ont donné leur accord partagent leur position, quand l’application est ouverte."}</Text>}
      renderItem={({ item }) => <View style={[ui.card, ui.row]}>
        <View style={{ flex: 1 }}>
          <Text style={ui.strong}>{item.name}</Text>
          <Text style={ui.small}>{roleLabels[item.role as Role] ?? item.role} · {item.latitude !== null && item.updated_at ? `vu ${ago(item.updated_at)}${item.accuracy ? ` · ±${Math.round(item.accuracy)} m` : ""}` : item.consent ? "accord donné, pas encore de position" : "ne partage pas sa position"}</Text>
        </View>
        {item.latitude !== null && item.longitude !== null ? <Button label="CARTE" variant="secondary" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`)} /> : null}
      </View>}
    />}
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
