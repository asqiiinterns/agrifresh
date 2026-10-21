import { useEffect, useState } from "react";
import { AppState, Modal, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { answerLocationRequest, fetchIncomingLocationRequests, type IncomingLocationRequest } from "../data/workplace";
import { Button } from "./components";
import { errorMessage, notify } from "./notify";
import { colors, ui } from "./theme";

// "X demande à voir votre position": shown as soon as the app is open (checked every 15 s and when the app
// comes back to the front). Accepting sends the position of this phone now; refusing shows nothing.
export function LocationRequestHost({ enabled }: { enabled: boolean }) {
  const [requests, setRequests] = useState<IncomingLocationRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => { void fetchIncomingLocationRequests().then((next) => { if (active) setRequests(next); }); };
    load();
    const timer = setInterval(() => { if (AppState.currentState === "active") load(); }, 15000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") load(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [enabled]);

  const current = requests[0];
  async function answer(accept: boolean) {
    if (!current) return;
    setBusy(true);
    try {
      await answerLocationRequest(current.id, accept);
      setRequests((list) => list.filter((item) => item.id !== current.id));
    } catch (cause) {
      notify("Localisation", errorMessage(cause, "La réponse n’a pas pu être envoyée."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={enabled && !!current} transparent animationType="fade" onRequestClose={() => void answer(false)}>
    <View style={styles.backdrop}>
      <View style={styles.dialog}>
        <Text style={ui.strong}>Demande de position</Text>
        <Text style={[ui.body, { marginTop: 6 }]}>{current?.requester} demande à voir où vous êtes.</Text>
        <Text style={[ui.small, { marginTop: 6 }]}>{current?.tracking
          ? "Le repérage est autorisé pour votre compte : sans réponse dans la minute, votre dernière position connue lui sera montrée, et vous en serez prévenu."
          : "Sans réponse dans la minute, rien n’est montré (sauf à l’administrateur de votre Pro, et vous en serez prévenu)."}</Text>
        <View style={[ui.wrapRow, { marginTop: 12 }]}>
          <Button label="PARTAGER MA POSITION" onPress={() => answer(true)} busy={busy} style={{ flexGrow: 1 }} />
          <Button label="REFUSER" variant="danger" onPress={() => answer(false)} disabled={busy} />
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 24 },
  dialog: { backgroundColor: colors.white, borderRadius: 12, padding: 16 },
});
