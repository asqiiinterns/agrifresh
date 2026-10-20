import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { fetchDecisionBoard, decisionCount, type DecisionBoard } from "../data/decisions";
import { sendReminders } from "../data/invoices";
import { useCan } from "../data/permissions";
import { returnReasonLabel } from "../data/returns";
import { claimReasonLabel } from "../data/claims";
import { Button, EmptyState, ListGroup, ListRow, Loading, ScreenHeader, formatDateTime, formatDay, formatPrice, statusLabel } from "../ui/components";
import { useNav } from "../ui/navigation";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const clientName = (order: { clients: { business_name: string } | null; address_snapshot?: { business_name?: string } }) => order.clients?.business_name ?? order.address_snapshot?.business_name ?? "Client";

// « À décider »: everything waiting for someone, grouped, each line opening where to act.
export function DecideScreen({ isAdmin, onCount }: { isAdmin: boolean; onCount: (count: number) => void }) {
  const can = useCan();
  const { navigate } = useNav();
  const [board, setBoard] = useState<DecisionBoard | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reminding, setReminding] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const next = await fetchDecisionBoard(can, isAdmin);
      setBoard(next);
      onCount(decisionCount(next));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel("decide-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => { void reload(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  async function remind() {
    setReminding(true);
    try {
      const count = await sendReminders();
      notify("Relances", count ? `${count} relance(s) envoyée(s).` : "Aucune relance à envoyer pour le moment.");
      void reload();
    } catch (cause) {
      notify("Relances", errorMessage(cause, "Les relances n’ont pas pu être envoyées."));
    } finally {
      setReminding(false);
    }
  }

  if (!board) return <View style={ui.screen}><ScreenHeader eyebrow="EN SUSPENS" title="À décider" /><Loading /></View>;
  const total = decisionCount(board);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${total} ÉLÉMENT(S) EN SUSPENS`} title="À décider" />
    <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}>
      {total === 0 ? <EmptyState title="Rien en suspens" body="Commandes en attente, suivis spéciaux, réclamations, messages à répondre, facturation et relances apparaîtront ici." /> : null}

      {board.toDecide.length ? <ListGroup title={`Commandes en attente de décision (${board.toDecide.length})`}>
        {board.toDecide.map((order) => <ListRow key={order.id} icon="hourglass-outline" title={clientName(order)} detail={`#${order.order_number} · ${statusLabel(order.status)}${order.requested_delivery_date ? ` · livraison ${formatDay(order.requested_delivery_date)}` : ""}`} onPress={() => navigate("orders", { section: "decide", orderId: order.id, back: "decide" })} />)}
      </ListGroup> : null}

      {board.special.length ? <ListGroup title={`Suivi spécial (${board.special.length})`}>
        {board.special.map((order) => <ListRow key={order.id} icon="star" title={clientName(order)} detail={`#${order.order_number} · ${statusLabel(order.status)}`} onPress={() => navigate("orders", { orderId: order.id, back: "decide" })} />)}
      </ListGroup> : null}

      {board.reschedule.length ? <ListGroup title={`À reprogrammer (${board.reschedule.length})`}>
        {board.reschedule.map((order) => <ListRow key={order.id} icon="refresh-circle-outline" title={clientName(order)} detail={`#${order.order_number} · ${statusLabel(order.status)}`} onPress={() => navigate("planning", { back: "decide" })} />)}
      </ListGroup> : null}

      {board.claims.length ? <ListGroup title={`Réclamations ouvertes (${board.claims.length})`}>
        {board.claims.map((claim) => <ListRow key={claim.id} icon="alert-circle-outline" title={claim.clients?.business_name ?? "Client"} detail={`N° ${claim.claim_number} · ${claimReasonLabel(claim.reason)} · cde #${claim.orders?.order_number ?? ""}`} onPress={() => navigate("orders", { section: "claims", back: "decide" })} />)}
      </ListGroup> : null}

      {board.messages.clients.length || board.messages.team.length ? <ListGroup title={`Messages à répondre (${board.messages.clients.length + board.messages.team.length})`}>
        {board.messages.clients.map((item) => <ListRow key={item.client_id} icon="alert-circle" title={`${item.business_name} (client)`} detail={`${item.count} message(s) depuis ${formatDateTime(item.since)} · ${item.last_body}`} onPress={() => navigate("messages", { section: "clients", back: "decide" })} />)}
        {board.messages.team.map((item) => <ListRow key={item.conversation_id} icon="alert-circle" title={`${item.title} (équipe)`} detail={`${item.count} message(s) · ${item.last_body}`} onPress={() => navigate("messages", { section: "team", page: item.conversation_id, back: "decide" })} />)}
      </ListGroup> : null}

      {board.billing.due.length ? <ListGroup title={`Facturation à faire (${board.billing.due.length})`}>
        {board.billing.due.map((item) => <ListRow key={item.client_id} icon="document-text-outline" title={item.business_name} detail={`${item.orders} BL à facturer · ${formatPrice(item.amount)} · prévu le ${formatDay(item.next_date)}`} onPress={() => navigate("invoices", { back: "decide" })} />)}
      </ListGroup> : null}

      {board.billing.overdue.length ? <>
        <ListGroup title={`Factures en retard (${board.billing.overdue.length})`}>
          {board.billing.overdue.map((item) => <ListRow key={item.invoice_id} icon="time-outline" title={`${item.business_name} · ${item.invoice_number}`} detail={`Reste ${formatPrice(item.balance)} · ${item.days_late} j de retard${item.reminder_count ? ` · ${item.reminder_count} relance(s)` : ""}${item.reminders ? "" : " · relances désactivées"}`} onPress={() => navigate("invoices", { back: "decide" })} />)}
        </ListGroup>
        <Button label="ENVOYER LES RELANCES" variant="secondary" onPress={() => void remind()} busy={reminding} style={{ marginTop: 8, alignSelf: "flex-start" }} />
      </> : null}

      {board.returns.length ? <ListGroup title={`Retours à traiter (${board.returns.length})`}>
        {board.returns.map((item) => <ListRow key={item.id} icon="return-down-back-outline" title={item.clients?.business_name ?? "Client"} detail={`${item.return_number} · ${returnReasonLabel(item.reason)}`} onPress={() => navigate("returns", { back: "decide" })} />)}
      </ListGroup> : null}

      {board.accounts ? <ListGroup title="Comptes">
        <ListRow icon="person-add-outline" title={`${board.accounts} compte(s) à valider`} onPress={() => navigate("admin", { page: "accounts", back: "decide" })} />
      </ListGroup> : null}
      <Text style={[ui.small, styles.hint]}>Les commandes « suivi spécial » restent ici quel que soit leur statut, jusqu’à ce que la pastille soit retirée.</Text>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  hint: { marginTop: 14, textAlign: "center" },
});
