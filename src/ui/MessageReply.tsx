import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "./Text";
import { colors } from "./theme";
import type { Attachment } from "../data/attachments";

// Replying to a chosen message: a quote inside the reply, a banner above the composer.
export function messagePreview(body: string | null | undefined, attachment?: Attachment | null) {
  if (body?.trim()) return body.trim();
  if (!attachment) return "Message";
  return attachment.kind === "image" ? "📷 Photo" : attachment.kind === "video" ? "🎬 Vidéo" : attachment.kind === "audio" ? "🎤 Message vocal" : `📎 ${attachment.name ?? "Document"}`;
}

// Inside a bubble: who and what is answered. Tap = go to the original message.
export function ReplyQuote({ author, text, mine, onPress }: { author: string; text: string | null; mine: boolean; onPress?: () => void }) {
  return <Pressable onPress={onPress} disabled={!onPress} style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]} accessibilityLabel="Voir le message d’origine">
    <Text style={[styles.quoteAuthor, mine && { color: colors.onPrimaryMuted }]} numberOfLines={1}>{author}</Text>
    <Text style={[styles.quoteText, mine && { color: colors.onPrimaryMuted }]} numberOfLines={2}>{text ?? "Message plus ancien"}</Text>
  </Pressable>;
}

// Above the composer while a reply is being written.
export function ReplyBanner({ author, text, onCancel }: { author: string; text: string; onCancel: () => void }) {
  return <View style={styles.banner}>
    <Ionicons name="arrow-undo" size={16} color={colors.primary} />
    <View style={{ flex: 1 }}>
      <Text style={styles.bannerTitle} numberOfLines={1}>Réponse à {author}</Text>
      <Text style={styles.bannerText} numberOfLines={1}>{text}</Text>
    </View>
    <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Annuler la réponse"><Ionicons name="close" size={18} color={colors.muted} /></Pressable>
  </View>;
}

// Small "Répondre" action in a bubble's footer.
export function ReplyAction({ mine, onPress }: { mine: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} hitSlop={6} style={styles.action} accessibilityLabel="Répondre à ce message">
    <Ionicons name="arrow-undo-outline" size={13} color={mine ? colors.onPrimaryMuted : colors.primary} />
    <Text style={[styles.actionText, mine && { color: colors.onPrimaryMuted }]}>Répondre</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  quote: { borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, marginBottom: 6 },
  quoteMine: { borderLeftColor: colors.onPrimaryMuted, backgroundColor: "rgba(255,255,255,0.14)" },
  quoteTheirs: { borderLeftColor: colors.orange, backgroundColor: colors.cream },
  quoteAuthor: { color: colors.orange, fontSize: 10, fontWeight: "800" },
  quoteText: { color: colors.text, fontSize: 12, marginTop: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 10, marginTop: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderLeftWidth: 3, borderLeftColor: colors.primary, backgroundColor: colors.primarySoft },
  bannerTitle: { color: colors.primary, fontSize: 11, fontWeight: "800" },
  bannerText: { color: colors.text, fontSize: 12 },
  action: { flexDirection: "row", alignItems: "center", gap: 3 },
  actionText: { color: colors.primary, fontSize: 10, fontWeight: "800" },
});
