import { useEffect, useState, useRef } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "../data/account";
import { countUnread, fetchInbox, fetchMessages, flagMessage, markMessagesRead, sendMessage, type InboxEntry, type Message } from "../data/messages";
import { uploadAttachment, type LocalFile } from "../data/attachments";
import { AttachmentPicker, AttachmentView, NeedsReplyTag, NeedsReplyToggle } from "../ui/Attachments";
import { ReplyAction, ReplyBanner, ReplyQuote, messagePreview } from "../ui/MessageReply";
import { Ionicons } from "@expo/vector-icons";
import { countTeamUnread } from "../data/teamMessages";
import { CloseButton, EmptyState, Loading, ScreenHeader, Sheets, formatDateTime } from "../ui/components";
import { TeamMessagesList } from "./TeamMessagesScreen";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Client side: a single conversation with the supplier's team.
export function ClientMessagesScreen({ clientId, onRead }: { clientId: string; onRead: () => void }) {
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ÉCHANGE DIRECT" title="Messages" subtitle="Une question sur une commande, un produit, une livraison ? Votre fournisseur vous répond ici." />
    <Thread clientId={clientId} viewerIsStaff={false} onRead={onRead} />
  </View>;
}

// Team side: conversations with clients and, separately, between team members.
export function StaffMessagesScreen({ canClients, canTeam, initialSection, initialConversationId, onRead, moderator }: {
  moderator?: boolean;
  canClients: boolean;
  canTeam: boolean;
  initialSection?: string;
  initialConversationId?: string;
  onRead: () => void;
}) {
  const [sheet, setSheet] = useState<"clients" | "team">(!canClients || (canTeam && initialSection === "team") ? "team" : "clients");
  // Unread badges on each sheet, kept live.
  const [counts, setCounts] = useState({ clients: 0, team: 0 });
  const refreshCounts = () => {
    void Promise.all([canClients ? countUnread(true) : 0, canTeam ? countTeamUnread() : 0]).then(([clients, team]) => setCounts({ clients, team }));
  };
  useEffect(() => {
    const realtime = supabase;
    refreshCounts();
    if (!realtime) return;
    const channel = realtime.channel("messages-sheet-badges")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refreshCounts)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "team_messages" }, refreshCounts)
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);
  const read = () => { onRead(); refreshCounts(); };
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ÉCHANGE DIRECT" title="Messages" />
    {canClients && canTeam ? <Sheets items={[{ key: "clients", label: "Clients", count: counts.clients || undefined }, { key: "team", label: "Équipe", count: counts.team || undefined }]} value={sheet} onChange={setSheet} /> : null}
    {sheet === "clients" ? <StaffInboxScreen embedded onRead={read} moderator={moderator} /> : <TeamMessagesList onRead={read} initialConversationId={initialConversationId} moderator={moderator} />}
  </View>;
}

// Staff side: one conversation per client, most recent first.
export function StaffInboxScreen({ onRead, embedded, moderator }: { onRead: () => void; embedded?: boolean; moderator?: boolean }) {
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

  return <View style={embedded ? { flex: 1 } : ui.screen}>
    {embedded ? null : <ScreenHeader eyebrow="ÉCHANGE DIRECT" title="Messages" />}
    <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(entry) => entry.client_id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.primary} />}
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
          <Thread clientId={openClient.client_id} viewerIsStaff moderator={moderator} onRead={() => { onRead(); void reload("silent"); }} />
        </> : null}
      </SafeAreaView>
    </Modal>
  </View>;
}

// Admins and supervisors (moderator) may mark any message "needs a reply"; others only their own.
function Thread({ clientId, viewerIsStaff, onRead, moderator }: { clientId: string; viewerIsStaff: boolean; onRead: () => void; moderator?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const list = useRef<FlatList<Message>>(null);
  const authorOf = (message: Message) => message.from_staff === viewerIsStaff ? "Vous" : message.from_staff ? "Fournisseur" : "Client";
  function goTo(id: string) {
    const index = messages.findIndex((item) => item.id === id);
    if (index < 0) return;
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlight(id);
    setTimeout(() => setHighlight((current) => current === id ? null : current), 1600);
  }
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<LocalFile | null>(null);
  const [needsReply, setNeedsReply] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function toggleNeedsReply(message: Message) {
    const next = !message.needs_reply;
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, needs_reply: next } : item));
    try {
      await flagMessage(message.id, next);
    } catch (cause) {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, needs_reply: !next } : item));
      setError(errorMessage(cause, "Impossible de marquer le message. La migration 20261031 est-elle exécutée ?"));
    }
  }

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
    void client?.auth.getUser().then(({ data }) => { if (active) setMe(data.user?.id ?? null); });
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

  const sendLock = useRef(false);
  async function send() {
    const body = draft.trim();
    if (!body && !file) return;
    if (sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setError("");
    try {
      const attachment = file ? await uploadAttachment(`client/${clientId}`, file) : null;
      const message = await sendMessage(clientId, body, attachment, needsReply, replyTo?.id ?? null);
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [message, ...current]);
      setDraft("");
      setFile(null);
      setNeedsReply(false);
      setReplyTo(null);
    } catch (cause) {
      setError(errorMessage(cause, "Le message n’a pas pu être envoyé."));
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
    {/* The empty state stays outside the inverted list, whose flip differs between platforms. */}
    {loading ? <Loading /> : messages.length === 0 ? <View style={{ flex: 1, justifyContent: "center" }}>
      <EmptyState title="Aucun message" body="Écrivez le premier message ci-dessous." />
    </View> : <FlatList
      ref={list}
      inverted
      data={messages}
      keyExtractor={(message) => message.id}
      contentContainerStyle={{ padding: 18, flexGrow: 1 }}
      onScrollToIndexFailed={({ index }) => setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5 }), 250)}
      renderItem={({ item }) => {
        const mine = item.from_staff === viewerIsStaff;
        const canFlag = !!moderator || (!!me && item.sender_id === me);
        const original = item.reply_to ? messages.find((other) => other.id === item.reply_to) : undefined;
        return <Pressable onLongPress={() => setReplyTo(item)} delayLongPress={350} style={[styles.bubble, mine ? styles.mine : styles.theirs, item.needs_reply && styles.waiting, highlight === item.id && styles.highlight]}>
          {item.needs_reply ? <NeedsReplyTag mine={mine} /> : null}
          {!mine ? <Text style={styles.author}>{item.from_staff ? "Fournisseur" : "Client"}</Text> : null}
          {item.reply_to ? <ReplyQuote mine={mine} author={original ? authorOf(original) : "Message"} text={original ? messagePreview(original.body, original.attachment) : null} onPress={original ? () => goTo(original.id) : undefined} /> : null}
          {item.attachment ? <AttachmentView attachment={item.attachment} mine={mine} /> : null}
          {item.body ? <Text style={[styles.body, mine && { color: colors.white }]}>{item.body}</Text> : null}
          <Text style={[styles.time, mine && { color: colors.onPrimaryMuted }]}>{formatDateTime(item.created_at)}{mine && item.read_at ? " · lu" : ""}</Text>
          <View style={styles.footer}>
            <ReplyAction mine={mine} onPress={() => setReplyTo(item)} />
            {canFlag ? <Pressable onPress={() => void toggleNeedsReply(item)} style={styles.needsReply} hitSlop={6}>
              <Ionicons name={item.needs_reply ? "checkbox" : "square-outline"} size={14} color={item.needs_reply ? colors.danger : mine ? colors.onPrimaryMuted : colors.muted} />
              <Text style={[styles.needsReplyText, mine && { color: colors.onPrimaryMuted }, item.needs_reply && { color: mine ? colors.white : colors.danger }]}>Nécessite une réponse</Text>
            </Pressable> : null}
          </View>
        </Pressable>;
      }}
    />}
    {error ? <Text style={[ui.error, { paddingHorizontal: 18 }]}>{error}</Text> : null}
    {replyTo ? <ReplyBanner author={authorOf(replyTo)} text={messagePreview(replyTo.body, replyTo.attachment)} onCancel={() => setReplyTo(null)} /> : null}
    <AttachmentPicker value={file} onChange={setFile} disabled={sending} extra={<NeedsReplyToggle value={needsReply} onChange={setNeedsReply} />} />
    <View style={styles.composer}>
      <TextInput value={draft} onChangeText={setDraft} placeholder={file ? "Ajouter un texte (facultatif)…" : "Votre message…"} placeholderTextColor={colors.muted} style={[ui.input, { flex: 1, maxHeight: 120 }]} multiline maxLength={2000} />
      <Pressable onPress={() => void send()} disabled={sending || (!draft.trim() && !file)} style={[styles.send, (sending || (!draft.trim() && !file)) && ui.disabled]} accessibilityLabel="Envoyer">
        <Text style={styles.sendText}>{sending ? "…" : "➤"}</Text>
      </Pressable>
    </View>
    <KeyboardSpacer />
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  bubble: { maxWidth: "82%", padding: 10, borderRadius: 12, marginVertical: 4 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.primary, borderBottomRightRadius: 3 },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 3 },
  author: { color: colors.orange, fontSize: 10, fontWeight: "800", marginBottom: 2 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  time: { color: colors.muted, fontSize: 9, marginTop: 4, textAlign: "right" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  sendText: { color: colors.white, fontSize: 18 },
  waiting: { borderWidth: 2, borderColor: colors.danger },
  footer: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 5, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 4 },
  needsReply: { flexDirection: "row", alignItems: "center", gap: 4 },
  highlight: { borderWidth: 2, borderColor: colors.orange },
  needsReplyText: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  unread: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  unreadText: { color: colors.white, fontSize: 11, fontWeight: "800" },
});
