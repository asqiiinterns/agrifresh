import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { subscribeToDialogs, type PendingDialog } from "./notify";
import { colors } from "./theme";

// Web dialogs drawn by the app (alert / confirmation), instead of the blocking browser dialogs.
export function DialogHost() {
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  useEffect(() => subscribeToDialogs((dialog) => setQueue((current) => [...current, dialog])), []);
  const dialog = queue[0];
  const close = (onPress?: () => void) => {
    setQueue((current) => current.slice(1));
    if (onPress) setTimeout(onPress, 0);
  };
  return <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={() => close(dialog?.buttons.find((button) => button.style === "cancel")?.onPress)}>
    <View style={styles.backdrop}>
      {dialog ? <View style={styles.box} accessibilityRole="alert">
        <Text style={styles.title}>{dialog.title}</Text>
        {dialog.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
        <View style={styles.buttons}>
          {dialog.buttons.map((button, index) => <Pressable key={index} onPress={() => close(button.onPress)} style={[styles.button, button.style !== "cancel" && dialog.buttons.length > 1 && index === dialog.buttons.length - 1 && styles.primary]}>
            <Text style={[styles.buttonText, button.style === "destructive" && { color: colors.danger }, button.style !== "cancel" && dialog.buttons.length > 1 && index === dialog.buttons.length - 1 && button.style !== "destructive" && { color: colors.white }]}>{button.text}</Text>
          </Pressable>)}
        </View>
      </View> : null}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(24,60,42,0.35)", alignItems: "center", justifyContent: "center", padding: 20 },
  box: { width: "100%", maxWidth: 420, backgroundColor: colors.white, borderRadius: 14, padding: 18 },
  title: { color: colors.text, fontSize: 16, fontWeight: "800" },
  message: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 8 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 16 },
  button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  primary: { backgroundColor: colors.green, borderColor: colors.green },
  buttonText: { color: colors.green, fontSize: 13, fontWeight: "800" },
});
