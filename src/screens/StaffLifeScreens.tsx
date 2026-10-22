import { useEffect, useState } from "react";
import { FlatList, RefreshControl, ScrollView, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { useCan } from "../data/permissions";
import { fetchVehicles, type Vehicle } from "../data/fleet";
import {
  decideLeave, fetchIncidents, fetchLeaveApproval, fetchLeaves, incidentCategories, leaveKindLabel, leaveKinds, leaveStatusStyle, reportIncident, requestLeave,
  resolveIncident, setLeaveApproval, type Incident, type Leave, type LeaveKind,
} from "../data/workplace";
import { Calendar } from "../ui/Calendar";
import { Button, Chip, EmptyState, Field, Loading, ScreenHeader, Sheets, formatDateTime, formatDay, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

function Badge({ style }: { style: { label: string; color: string; background: string } }) {
  return <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>;
}

// Congés: my requests, requests to validate (managers), absence planning.
export function LeavesScreen({ isAdmin }: { isAdmin: boolean }) {
  const can = useCan();
  const manage = can("leave.manage") || isAdmin;
  const [sheet, setSheet] = useState<"mine" | "validate" | "planning" | "new">(manage ? "validate" : "mine");
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [approval, setApproval] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const from = toDayKey(new Date(Date.now() - 60 * 86400000));
      const to = toDayKey(new Date(Date.now() + 365 * 86400000));
      const [list, required] = await Promise.all([fetchLeaves(from, to), fetchLeaveApproval().catch(() => true)]);
      setLeaves(list);
      setApproval(required);
    } catch (cause) {
      notify("Congés", errorMessage(cause, "Impossible de charger les congés. La migration 20261103 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  async function act(leave: Leave, action: "approve" | "refuse" | "cancel") {
    try {
      await decideLeave(leave.id, action, notes[leave.id]);
      void reload();
    } catch (cause) {
      notify("Congés", errorMessage(cause, "L’opération a échoué."));
    }
  }

  const pending = leaves.filter((leave) => leave.status === "pending" && !leave.mine);
  const today = toDayKey(new Date());
  const lists = {
    mine: leaves.filter((leave) => leave.mine),
    validate: pending,
    planning: leaves.filter((leave) => leave.status === "approved" && leave.end_date >= today),
  };
  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={manage ? `${pending.length} DEMANDE(S) À VALIDER` : "VOS ABSENCES"} title="Congés" right={<Button label="+ DEMANDE" onPress={() => setSheet("new")} />} />
    <Sheets items={[
      ...(manage ? [{ key: "validate" as const, label: "À valider", count: pending.length || undefined }] : []),
      { key: "mine", label: "Mes demandes" },
      { key: "planning", label: "Absences à venir" },
      { key: "new", label: "Nouvelle demande" },
    ]} value={sheet} onChange={setSheet} />
    {loading ? <Loading /> : sheet === "new" ? <LeaveForm onSaved={() => { setSheet("mine"); void reload(); }} /> : <FlatList
      data={lists[sheet]}
      keyExtractor={(leave) => leave.id}
      contentContainerStyle={ui.content}
      refreshControl={refresh}
      ListHeaderComponent={isAdmin && sheet === "validate" ? <View style={[ui.card, ui.row]}>
        <Switch value={approval} onValueChange={(value) => { setApproval(value); void setLeaveApproval(value).catch((cause: unknown) => { setApproval(!value); notify("Congés", errorMessage(cause, "Réglage impossible.")); }); }} trackColor={{ true: colors.primary, false: colors.line }} />
        <View style={{ flex: 1 }}>
          <Text style={ui.strong}>Validation des congés requise</Text>
          <Text style={ui.small}>Désactivée : chaque demande est acceptée automatiquement.</Text>
        </View>
      </View> : null}
      ListEmptyComponent={<EmptyState title={sheet === "validate" ? "Aucune demande à valider" : sheet === "mine" ? "Aucune demande" : "Aucune absence prévue"} body={sheet === "mine" ? "Touchez « + DEMANDE » pour poser un congé." : undefined} />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{sheet === "mine" ? leaveKindLabel(item.kind) : item.name}</Text>
          <Badge style={leaveStatusStyle[item.status]} />
        </View>
        <Text style={ui.body}>Du {formatDay(item.start_date, { weekday: "short", day: "numeric", month: "short" })} au {formatDay(item.end_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}{item.half_day ? " · demi-journée" : ""}</Text>
        <Text style={ui.small}>{sheet === "mine" ? "" : `${leaveKindLabel(item.kind)} · `}demandé le {formatDateTime(item.created_at)}</Text>
        {item.note ? <Text style={[ui.small, { color: colors.text }]}>« {item.note} »</Text> : null}
        {item.decision_note ? <Text style={[ui.small, { color: colors.amber }]}>Réponse : {item.decision_note}</Text> : null}
        {sheet === "validate" ? <>
          <TextInput value={notes[item.id] ?? ""} onChangeText={(text) => setNotes({ ...notes, [item.id]: text })} placeholder="Commentaire (facultatif)" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} />
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            <Button label="ACCEPTER" onPress={() => act(item, "approve")} style={{ flexGrow: 1 }} />
            <Button label="REFUSER" variant="danger" onPress={() => act(item, "refuse")} />
          </View>
        </> : null}
        {item.mine && (item.status === "pending" || (item.status === "approved" && item.start_date > today)) ? <Button label="ANNULER LA DEMANDE" variant="secondary" onPress={() => act(item, "cancel")} style={{ marginTop: 8, alignSelf: "flex-start" }} /> : null}
      </View>}
    />}
  </View>;
}

function LeaveForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<LeaveKind>("paid");
  const [from, setFrom] = useState(toDayKey(new Date()));
  const [to, setTo] = useState(toDayKey(new Date()));
  const [halfDay, setHalfDay] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      const status = await requestLeave(kind, from, to, halfDay, note);
      notify("Demande envoyée", status === "approved" ? "Votre congé est enregistré." : "Votre demande est transmise pour validation ; vous serez averti de la réponse.");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "La demande n’a pas pu être envoyée."));
    } finally {
      setBusy(false);
    }
  }

  return <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
    <Text style={[ui.fieldLabel, { marginTop: 10 }]}>Type</Text>
    <View style={[ui.wrapRow, { marginTop: 6 }]}>{leaveKinds.map((item) => <Chip key={item.key} label={item.label} selected={kind === item.key} onPress={() => setKind(item.key)} />)}</View>
    <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Dates : touchez le premier puis le dernier jour</Text>
    <View style={ui.card}><Calendar from={from} to={to} onChange={(start, end) => { setFrom(start); setTo(end); }} /></View>
    <Text style={[ui.body, { marginTop: 6 }]}>Du {formatDay(from, { weekday: "long", day: "numeric", month: "long" })} au {formatDay(to, { weekday: "long", day: "numeric", month: "long" })}</Text>
    <View style={[ui.row, { justifyContent: "flex-start", marginTop: 8 }]}>
      <Switch value={halfDay} onValueChange={setHalfDay} trackColor={{ true: colors.primary, false: colors.line }} />
      <Text style={[ui.body, { flex: 1 }]}>Demi-journée</Text>
    </View>
    <Field label="Motif / commentaire (facultatif)" value={note} onChangeText={setNote} multiline />
    {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
    <Button label="ENVOYER LA DEMANDE" onPress={() => save()} busy={busy} style={{ marginTop: 14 }} />
  </ScrollView>;
}

// Incidents: the driver reports (delivery or vehicle); managers follow and close them.
export function IncidentsScreen() {
  const can = useCan();
  const manage = can("incidents.manage");
  const [sheet, setSheet] = useState<"report" | "open" | "closed">(manage ? "open" : "report");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setIncidents(await fetchIncidents());
    } catch (cause) {
      notify("Incidents", errorMessage(cause, "Impossible de charger les incidents. La migration 20261103 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  async function resolve(incident: Incident) {
    try {
      await resolveIncident(incident.id, resolutions[incident.id] ?? "");
      void reload();
    } catch (cause) {
      notify("Incidents", errorMessage(cause, "L’incident n’a pas pu être clôturé."));
    }
  }

  const open = incidents.filter((item) => item.status === "open");
  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${open.length} INCIDENT(S) OUVERT(S)`} title="Incidents" />
    <Sheets items={[{ key: "report", label: "Signaler" }, { key: "open", label: "En cours", count: open.length || undefined }, { key: "closed", label: "Clôturés" }]} value={sheet} onChange={setSheet} />
    {sheet === "report" ? <IncidentForm onSaved={() => { setSheet("open"); void reload(); }} /> : loading ? <Loading /> : <FlatList
      data={incidents.filter((item) => sheet === "open" ? item.status === "open" : item.status === "resolved")}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListEmptyComponent={<EmptyState title="Aucun incident" body={sheet === "open" ? "Les incidents signalés par les livreurs apparaîtront ici." : undefined} />}
      renderItem={({ item }) => <View style={[ui.card, item.status === "open" && { borderLeftWidth: 4, borderLeftColor: colors.danger }]}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{item.kind === "vehicle" ? "🚚 Véhicule" : "📦 Livraison"} · {item.category}</Text>
          <Text style={ui.small}>{formatDateTime(item.created_at)}</Text>
        </View>
        <Text style={ui.body}>{item.description}</Text>
        <Text style={ui.small}>{item.reporter?.full_name ?? ""}{item.vehicles ? ` · ${item.vehicles.label}` : ""}{item.orders ? ` · cde #${item.orders.order_number}` : ""}</Text>
        {item.resolution ? <Text style={[ui.small, { color: colors.primary }]}>Réglé : {item.resolution}</Text> : null}
        {manage && item.status === "open" ? <>
          <TextInput value={resolutions[item.id] ?? ""} onChangeText={(text) => setResolutions({ ...resolutions, [item.id]: text })} placeholder="Solution apportée" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} />
          <Button label="CLÔTURER" onPress={() => resolve(item)} style={{ marginTop: 8, alignSelf: "flex-start" }} />
        </> : null}
      </View>}
    />}
  </View>;
}

function IncidentForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<Incident["kind"]>("delivery");
  const [category, setCategory] = useState(incidentCategories.delivery[0]);
  const [description, setDescription] = useState("");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void fetchVehicles().then(setVehicles).catch(() => setVehicles([])); }, []);

  async function save() {
    if (!description.trim()) {
      setError("Décrivez ce qui s’est passé.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await reportIncident(kind, category, description, null, vehicleId);
      notify("Incident signalé", "Les responsables sont prévenus.");
      setDescription("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "L’incident n’a pas pu être signalé."));
    } finally {
      setBusy(false);
    }
  }

  return <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
    <View style={[ui.wrapRow, { marginTop: 10 }]}>
      <Chip label="📦 Livraison" selected={kind === "delivery"} onPress={() => { setKind("delivery"); setCategory(incidentCategories.delivery[0]); }} />
      <Chip label="🚚 Véhicule" selected={kind === "vehicle"} onPress={() => { setKind("vehicle"); setCategory(incidentCategories.vehicle[0]); }} />
    </View>
    <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Quoi ?</Text>
    <View style={[ui.wrapRow, { marginTop: 6 }]}>{incidentCategories[kind].map((item) => <Chip key={item} label={item} selected={category === item} onPress={() => setCategory(item)} />)}</View>
    {kind === "vehicle" && vehicles.length ? <>
      <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Véhicule</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>{vehicles.map((vehicle) => <Chip key={vehicle.id} label={vehicle.label} selected={vehicleId === vehicle.id} onPress={() => setVehicleId(vehicle.id)} />)}</View>
    </> : null}
    <Field label="Description (lieu, client, ce qui s’est passé)" value={description} onChangeText={setDescription} multiline />
    {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
    <Button label="SIGNALER" onPress={() => save()} busy={busy} style={{ marginTop: 14 }} />
  </ScrollView>;
}
