import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from "expo-audio";
import { Text } from "./Text";
import { attachmentUrl, formatSize, pickDocument, pickMedia, type Attachment, type LocalFile } from "../data/attachments";
import { errorMessage, notify } from "./notify";
import { colors } from "./theme";

// Composer buttons: photo / video (camera), gallery, document, voice note.
export function AttachmentPicker({ value, onChange, disabled, extra }: { value: LocalFile | null; onChange: (file: LocalFile | null) => void; disabled?: boolean; extra?: React.ReactNode }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  async function run(task: () => Promise<LocalFile | null>) {
    try {
      const file = await task();
      if (file) onChange(file);
    } catch (cause) {
      notify("Pièce jointe", errorMessage(cause, "Le fichier n’a pas pu être ajouté."), [
        { text: "Fermer", style: "cancel" },
        { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings() },
      ]);
    }
  }

  async function toggleRecording() {
    try {
      if (recording) {
        await recorder.stop();
        setRecording(false);
        if (recorder.uri) onChange({ uri: recorder.uri, kind: "audio", name: `vocal-${seconds}s.m4a`, size: 0, mime: "audio/mp4" });
        return;
      }
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Autorisez le micro dans les réglages du téléphone.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSeconds(0);
      setRecording(true);
    } catch (cause) {
      setRecording(false);
      notify("Message vocal", errorMessage(cause, "L’enregistrement n’a pas pu démarrer."), [
        { text: "Fermer", style: "cancel" },
        { text: "Ouvrir les réglages", onPress: () => void Linking.openSettings() },
      ]);
    }
  }

  if (value) {
    return <View style={styles.pending}>
      <Ionicons name={value.kind === "image" ? "image-outline" : value.kind === "video" ? "videocam-outline" : value.kind === "audio" ? "mic-outline" : "document-outline"} size={18} color={colors.green} />
      <Text style={styles.pendingText} numberOfLines={1}>{value.name}{value.size ? ` · ${formatSize(value.size)}` : ""}</Text>
      <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityLabel="Retirer la pièce jointe"><Ionicons name="close-circle" size={20} color={colors.muted} /></Pressable>
      {extra}
    </View>;
  }
  return <View style={[styles.tools, { flexWrap: "wrap" }]}>
    {extra}
    {recording ? <Pressable onPress={() => void toggleRecording()} style={[styles.tool, styles.recording]} accessibilityLabel="Arrêter l’enregistrement">
      <Ionicons name="stop" size={16} color={colors.white} />
      <Text style={styles.recordingText}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} · Arrêter</Text>
    </Pressable> : <>
      <Tool icon="camera-outline" label="Photo / vidéo" onPress={() => void run(() => pickMedia("camera"))} disabled={disabled} />
      <Tool icon="images-outline" label="Galerie" onPress={() => void run(() => pickMedia("library"))} disabled={disabled} />
      <Tool icon="document-attach-outline" label="Document" onPress={() => void run(pickDocument)} disabled={disabled} />
      <Tool icon="mic-outline" label="Vocal" onPress={() => void toggleRecording()} disabled={disabled} />
    </>}
  </View>;
}

// Red mark on a message waiting for an answer.
export function NeedsReplyTag({ mine }: { mine: boolean }) {
  return <View style={[styles.needsTag, mine && { backgroundColor: "#fde2dd" }]}>
    <Ionicons name="alert-circle" size={12} color={colors.danger} />
    <Text style={styles.needsTagText}>Réponse attendue</Text>
  </View>;
}

// Composer switch: ask for an answer.
export function NeedsReplyToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <Pressable onPress={() => onChange(!value)} style={[styles.tool, value && { borderColor: colors.danger, backgroundColor: "#fdecea" }]} accessibilityLabel="Demander une réponse">
    <Ionicons name={value ? "alert-circle" : "alert-circle-outline"} size={18} color={value ? colors.danger : colors.muted} />
    <Text style={[styles.toolText, { color: value ? colors.danger : colors.muted }]}>Réponse attendue</Text>
  </Pressable>;
}

function Tool({ icon, label, onPress, disabled }: { icon: React.ComponentProps<typeof Ionicons>["name"]; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={styles.tool} accessibilityLabel={label}>
    <Ionicons name={icon} size={18} color={colors.green} />
    <Text style={styles.toolText}>{label}</Text>
  </Pressable>;
}

// Inside a message bubble: photo preview, voice note player, or a link to open the file.
export function AttachmentView({ attachment, mine }: { attachment: Attachment; mine: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void attachmentUrl(attachment.path).then((next) => { if (active) setUrl(next); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attachment.path]);

  const tint = mine ? colors.white : colors.green;
  if (error) return <Text style={[styles.fileText, { color: tint }]}>Fichier indisponible</Text>;
  if (!url) return <ActivityIndicator color={tint} style={{ marginVertical: 6 }} />;
  if (attachment.kind === "image") {
    return <Pressable onPress={() => void Linking.openURL(url)}><Image source={{ uri: url }} style={styles.image} resizeMode="cover" /></Pressable>;
  }
  if (attachment.kind === "audio") return <VoiceNote url={url} mine={mine} />;
  return <Pressable onPress={() => void Linking.openURL(url)} style={styles.file}>
    <Ionicons name={attachment.kind === "video" ? "play-circle-outline" : "document-outline"} size={22} color={tint} />
    <View style={{ flexShrink: 1 }}>
      <Text style={[styles.fileText, { color: tint }]} numberOfLines={1}>{attachment.kind === "video" ? "Vidéo" : attachment.name}</Text>
      <Text style={[styles.fileSize, mine && { color: "#d4e3d6" }]}>{attachment.size ? formatSize(attachment.size) : ""} · Ouvrir</Text>
    </View>
  </Pressable>;
}

function VoiceNote({ url, mine }: { url: string; mine: boolean }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const tint = mine ? colors.white : colors.green;
  const total = Math.round(status.duration || 0);
  const current = Math.round(status.currentTime || 0);
  function toggle() {
    if (status.playing) player.pause();
    else {
      if (status.didJustFinish || (total && current >= total)) player.seekTo(0);
      player.play();
    }
  }
  return <Pressable onPress={toggle} style={styles.file} accessibilityLabel={status.playing ? "Pause" : "Écouter le message vocal"}>
    <Ionicons name={status.playing ? "pause-circle" : "play-circle"} size={28} color={tint} />
    <Text style={[styles.fileText, { color: tint }]}>Message vocal · {Math.floor((status.playing ? current : total) / 60)}:{String((status.playing ? current : total) % 60).padStart(2, "0")}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  needsTag: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", backgroundColor: "#fdecea", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, marginBottom: 3 },
  needsTagText: { color: colors.danger, fontSize: 10, fontWeight: "800" },
  tools: { flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingTop: 6 },
  tool: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  toolText: { color: colors.green, fontSize: 11, fontWeight: "700" },
  recording: { backgroundColor: colors.danger, borderColor: colors.danger },
  recordingText: { color: colors.white, fontSize: 11, fontWeight: "800" },
  pending: { flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 10, marginTop: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: "#f3f8f1", borderWidth: 1, borderColor: colors.green },
  pendingText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "700" },
  image: { width: 200, height: 150, borderRadius: 8, marginTop: 2, backgroundColor: colors.cream },
  file: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  fileText: { fontSize: 13, fontWeight: "700" },
  fileSize: { color: colors.muted, fontSize: 10 },
});
