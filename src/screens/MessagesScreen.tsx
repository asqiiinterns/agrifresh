import { useEffect, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "../data/account";
import { fetchInbox, fetchMessages, markMessagesRead, sendMessage, type InboxEntry, type Message } from "../data/messages";
import { CloseButton, EmptyState, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Client side: a single conversation with the AgriFresh team.
export function ClientMessagesScreen({ clientId, onRead }: { clientId: string; onRead: () => void }) {
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ÉCHANGE DIRECT" title="Messages" subtitle="Une question sur une commande, un produit, une livraison ? L’équipe AgriFresh vous répond ici." />
    <Thread clientId={clientId} viewerIsStaff={false} onRead={onRead} />
  </View>;
}

// Staff side: one conversation per client, most recent first.
export function StaffInboxScreen({ onRead }: { onRead: () => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [openClient, setOpenClient] = useState<InboxEntry | null>(null);

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      setEntries(await fetchInbox());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les messages."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const client = supabase;
    void reload("initial");
    if (!client) return;
    const channel = client
      .channel("staff-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => { void reload("silent"); })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, []);

  const term = search.trim().toLocaleLowerCase("fr");
  const visible = entries.filter((entry) => entry.business_name.toLocaleLowerCase("fr").includes(term));

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ÉCHANGE DIRECT" title="Messages" />
    <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(entry) => entry.client_id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun client" body="Créez des fiches clients pour échanger avec eux." />}
      renderItem={({ item }) => <Pressable style={ui.card} onPress={() => setOpenClient(item)}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
          {item.unread ? <View style={styles.unread}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}
        </View>
        <Text style={ui.small} numberOfLines={1}>
          {item.last_body ? `${item.last_from_staff ? "Vous : " : ""}${item.last_body}` : `${formatClientNumber(item.client_number)} · aucun message`}
        </Text>
        {item.last_at ? <Text style={ui.small}>{formatDateTime(item.last_at)}</Text> : null}
      </Pressable>}
    />}

    <Modal visible={openClient !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpenClient(null)}>
      <SafeAreaView style={ui.modalSafe}>
        {openClient ? <>
          <ScreenHeader eyebrow={formatClientNumber(openClient.client_number)} title={openClient.business_name} right={<CloseButton onPress={() => setOpenClient(null)} />} />
          <Thread clientId={openClient.client_id} viewerIsStaff onRead={() => { onRead(); void reload("silent"); }} />
        </> : null}
      </SafeAreaView>
    </Modal>
  </View>;
}

function Thread({ clientId, viewerIsStaff, onRead }: { clientId: string; viewerIsStaff: boolean; onRead: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function markRead() {
    try {
      await markMessagesRead(clientId);
      onRead();
    } catch {
      // Read receipts are best effort.
    }
  }

  useEffect(() => {
    const client = supabase;
    let active = true;
    setLoading(true);
    void fetchMessages(clientId)
      .then((next) => { if (active) setMessages(next); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause, "Impossible de charger la conversation.")); })
      .finally(() => { if (active) setLoading(false); });
    void markRead();
    if (!client) return () => { active = false; };

    const channel = client
      .channel(`messages-${clientId}-${viewerIsStaff ? "staff" : "client"}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `client_id=eq.${clientId}` }, (payload) => {
        const incoming = payload.new as Message;
        setMessages((current) => current.some((item) => item.id === incoming.id) ? current : [incoming, ...current]);
        if (incoming.from_staff !== viewerIsStaff) void markRead();
      })
      .subscribe();
    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [clientId, viewerIsStaff]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError("");
    try {
      const message = await sendMessage(clientId, body);
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [message, ...current]);
      setDraft("");
    } catch (cause) {
      setError(errorMessage(cause, "Le message n’a pas pu être envoyé."));
    } finally {
      setSending(false);
    }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
    {loading ? <Loading /> : <FlatList
      inverted
      data={messages}
      keyExtractor={(message) => message.id}
      contentContainerStyle={{ padding: 18, flexGrow: 1 }}
      ListEmptyComponent={<View style={{ transform: [{ scaleY: -1 }] }}><EmptyState title="Aucun message" body="Écrivez le premier message ci-dessous." /></View>}
      renderItem={({ item }) => {
        const mine = item.from_staff === viewerIsStaff;
        return <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
          {!mine ? <Text style={styles.author}>{item.from_staff ? "AgriFresh" : "Client"}</Text> : null}
          <Text style={[styles.body, mine && { color: colors.white }]}>{item.body}</Text>
          <Text style={[styles.time, mine && { color: "#d4e3d6" }]}>{formatDateTime(item.created_at)}{mine && item.read_at ? " · lu" : ""}</Text>
        </View>;
      }}
    />}
    {error ? <Text style={[ui.error, { paddingHorizontal: 18 }]}>{error}</Text> : null}
    <View style={styles.composer}>
      <TextInput value={draft} onChangeText={setDraft} placeholder="Votre message…" placeholderTextColor={colors.muted} style={[ui.input, { flex: 1, maxHeight: 120 }]} multiline maxLength={2000} />
      <Pressable onPress={() => void send()} disabled={sending || !draft.trim()} style={[styles.send, (sending || !draft.trim()) && ui.disabled]} accessibilityLabel="Envoyer">
        <Text style={styles.sendText}>{sending ? "…" : "➤"}</Text>
      </Pressable>
    </View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  bubble: { maxWidth: "82%", padding: 10, borderRadius: 12, marginVertical: 4 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.green, borderBottomRightRadius: 3 },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 3 },
  author: { color: colors.orange, fontSize: 10, fontWeight: "800", marginBottom: 2 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  time: { color: colors.muted, fontSize: 9, marginTop: 4, textAlign: "right" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" },
  sendText: { color: colors.white, fontSize: 18 },
  unread: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  unreadText: { color: colors.white, fontSize: 11, fontWeight: "800" },
});
