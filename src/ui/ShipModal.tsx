import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "./Text";
import { fetchVehicles, shipOrders, vehicleName, type Vehicle } from "../data/fleet";
import { Button, CloseButton, Loading, ScreenHeader } from "./components";
import { errorMessage, notify } from "./notify";
import { colors, ui } from "./theme";

// Ships the selected prepared orders together, in the vehicle chosen from the fleet.
export function ShipModal({ orders, onClose, onShipped }: {
  orders: { id: string; order_number: number; business_name: string; planned_vehicle_id?: string | null }[] | null;
  onClose: () => void;
  onShipped: () => void;
}) {
  // Vehicles planned when the orders were accepted: preselected; another choice is traced ("condition forcée").
  const planned = [...new Set((orders ?? []).map((order) => order.planned_vehicle_id).filter((id): id is string => !!id))];
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!orders) return;
    setLoading(true);
    setError("");
    void fetchVehicles()
      .then((list) => {
        setVehicles(list);
        // Preselected: the planned vehicle, else the default one, else the only one.
        setVehicleId(planned.length === 1 && list.some((item) => item.id === planned[0]) ? planned[0] : list.find((item) => item.is_default)?.id ?? (list.length === 1 ? list[0].id : null));
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger la flotte.")))
      .finally(() => setLoading(false));
  }, [orders]);

  async function ship() {
    if (!orders) return;
    // No vehicle chosen: the server takes the planned or the default one (never blocked).
    setBusy(true);
    setError("");
    try {
      const result = await shipOrders(orders.map((order) => order.id), vehicleId);
      const vehicle = vehicles.find((item) => item.id === vehicleId) ?? vehicles.find((item) => item.is_default);
      notify("Expédition enregistrée", result.queued
        ? `Pas de réseau : l’expédition de ${result.count} commande(s) est enregistrée sur le téléphone et sera envoyée dès le retour de la connexion.`
        : `Expédition #${result.shipment_number} : ${result.count} commande(s)${vehicle ? ` dans ${vehicleName(vehicle)}` : ""}. Elles apparaissent dans « À livrer ».`);
      onShipped();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "L’expédition n’a pas pu être enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  const clients = [...new Set((orders ?? []).map((order) => order.business_name))];

  return <Modal visible={orders !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="EXPÉDITION" title={`${orders?.length ?? 0} bon(s) de livraison`} subtitle={clients.join(" · ")} right={<CloseButton onPress={onClose} />} />
      {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Véhicule</Text>
        {vehicles.length ? <View style={styles.group}>
          {vehicles.map((vehicle) => {
            const selected = vehicle.id === vehicleId;
            return <Pressable key={vehicle.id} onPress={() => setVehicleId(vehicle.id)} style={[styles.row, selected && styles.rowSelected]}>
              <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.muted} />
              <Ionicons name="car-outline" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={ui.strong}>{vehicle.label}{planned.includes(vehicle.id) ? " · prévu" : vehicle.is_default ? " · par défaut" : ""}</Text>
                {vehicle.plate || vehicle.notes ? <Text style={ui.small}>{[vehicle.plate, vehicle.notes].filter(Boolean).join(" · ")}</Text> : null}
              </View>
            </Pressable>;
          })}
        </View> : <Text style={[ui.small, { marginTop: 6 }]}>Aucun véhicule dans la flotte : l’expédition est enregistrée sans véhicule. L’administrateur peut ajouter la flotte dans Admin → Flotte.</Text>}
        {planned.length && vehicleId && planned.some((id) => id !== vehicleId) ? <Text style={[ui.small, { marginTop: 8, color: colors.amber, fontWeight: "700" }]}>
          Ce n’est pas le véhicule prévu{planned.length > 1 ? " pour toutes ces commandes" : ""} : le changement sera noté dans l’historique et signalé à l’équipe.
        </Text> : null}
        <Text style={[ui.fieldLabel, { marginTop: 14 }]}>Commandes</Text>
        <Text style={ui.body}>{(orders ?? []).map((order) => `#${order.order_number} ${order.business_name}`).join("\n")}</Text>
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <Button label={`EXPÉDIER ${orders?.length ?? 0} COMMANDE(S)`} onPress={() => ship()} busy={busy} style={{ marginTop: 14 }} />
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  group: { marginTop: 6, backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowSelected: { backgroundColor: colors.primarySoft },
});
