import { useEffect, useMemo, useState, useRef } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardSpacer } from "../ui/KeyboardSpacer";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { roleLabels, type Role } from "../data/account";
import {
  addTeamMembers, fetchTeamConversations, fetchTeamDirectory, fetchTeamThread, flagTeamMessage, markTeamRead, sendTeamMessage, startTeamConversation,
  type TeamConversation, type TeamConversationKind, type TeamMessage, type TeamPerson,
} from "../data/teamMessages";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { uploadAttachment, type LocalFile } from "../data/attachments";
import { AttachmentPicker, AttachmentView, NeedsReplyTag, NeedsReplyToggle } from "../ui/Attachments";
import { ReplyAction, ReplyBanner, ReplyQuote, messagePreview } from "../ui/MessageReply";
import type { IconName } from "../ui/navigation";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { useModules } from "../data/modules";

const kindIcon: Record<TeamConversationKind, IconName> = { direct: "person-outline", group: "people-outline", role: "id-card-outline", all: "megaphone-outline" };

// Team conversations: list, new conversation, thread.
export function TeamMessagesList({ onRead, initialConversationId, moderator }: { onRead: () => void; initialConversationId?: string; moderator?: boolean }) {
  const [conversations, setConversations] = useState<TeamConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialConversationId ?? null);
  const [creating, setCreating] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setConversations(await fetchTeamConversations());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les conversations. La migration 20261029 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel("team-conversations")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "team_messages" }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  return <View style={{ flex: 1 }}>
    <View style={[ui.row, { paddingHorizontal: 14, paddingTop: 8 }]}>
      <Text style={[ui.small, { flex: 1 }]}>Échanges internes : invisibles pour les clients.</Text>
      <Button label="+ NOUVEAU MESSAGE" onPress={() => setCreating(true)} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={conversations}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune conversation" body="Touchez « Nouveau message » pour écrire à un collègue, à plusieurs, à un profil ou à toute l’équipe." />}
      renderItem={({ item }) => <Pressable onPress={() => setOpenId(item.id)} style={[ui.card, styles.conversation, item.unread > 0 && styles.unreadCard]}>
        <View style={styles.avatar}><Ionicons name={kindIcon[item.kind]} size={18} color={colors.primary} /></View>
        <View style={{ flex: 1 }}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.title}</Text>
            <Text style={ui.small}>{formatDateTime(item.last_at)}</Text>
          </View>
          <Text style={ui.small} numberOfLines={1}>
            {item.last_body ? `${item.last_mine ? "Vous" : item.last_sender} : ${item.last_body}` : "Aucun message"}
            {item.kind !== "direct" ? ` · ${item.member_count} pers.` : ""}
          </Text>
        </View>
        {item.unread ? <View style={styles.badge}><Text style={styles.badgeText}>{item.unread}</Text></View> : null}
      </Pressable>}
    />}
    <RecipientsModal visible={creating} mode="new" onClose={() => setCreating(false)} onDone={async (choice) => { const id = await startFromChoice(choice); setCreating(false); setOpenId(id); void reload(); }} />
    <Modal visible={openId !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpenId(null)}>
      <SafeAreaView style={ui.modalSafe}>
        {openId ? <TeamThread conversationId={openId} moderator={moderator} onClose={() => { setOpenId(null); void reload(); }} onRead={onRead} /> : null}
      </SafeAreaView>
    </Modal>
  </View>;
}

const teamRoles: Role[] = ["supervisor", "production", "driver", "admin"];
const roleAudience: Partial<Record<Role, string>> = {
  supervisor: "Tous les superviseurs",
  production: "Toute la production",
  driver: "Tous les livreurs",
  admin: "Tous les administrateurs",
};

// One screen: tick people, whole profiles or the whole team, then write. Also used to add people.
function RecipientsModal({ visible, mode, onClose, onDone }: {
  visible: boolean;
  mode: "new" | "add";
  onClose: () => void;
  onDone: (choice: { all: boolean; ids: string[]; roles: Role[]; title: string }) => Promise<void>;
}) {
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [all, setAll] = useState(false);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setSelected([]);
    setRoles([]);
    setAll(false);
    setTitle("");
    setSearch("");
    setError("");
    void fetchTeamDirectory().then(setPeople).catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger l’équipe.")));
  }, [visible]);

  const term = search.trim().toLocaleLowerCase("fr");
  const visiblePeople = people.filter((person) => `${person.name} ${roleLabels[person.role] ?? ""}`.toLocaleLowerCase("fr").includes(term));
  const fromRoles = people.filter((person) => roles.includes(person.role)).map((person) => person.id);
  const recipients = all ? people.map((person) => person.id) : [...new Set([...selected, ...fromRoles])];
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleRole = (role: Role) => setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);

  async function done() {
    if (!all && recipients.length === 0) {
      setError("Choisissez au moins une personne ou un profil.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onDone({ all, ids: recipients, roles: selected.length ? [] : roles, title });
    } catch (cause) {
      setError(errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={mode === "new" ? "MESSAGE À L’ÉQUIPE" : "AJOUTER À LA DISCUSSION"} title={all ? "Toute l’équipe" : recipients.length ? `${recipients.length} destinataire(s)` : "Destinataires"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <View style={[ui.wrapRow, { marginTop: 10 }]}>
          {mode === "new" ? <Chip label="Toute l’équipe" selected={all} onPress={() => setAll(!all)} /> : null}
          {!all ? teamRoles.filter((role) => people.some((person) => person.role === role)).map((role) => <Chip key={role} label={roleAudience[role] ?? role} selected={roles.includes(role)} onPress={() => toggleRole(role)} />) : null}
        </View>
        {!all ? <>
          <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un collègue" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} />
          {visiblePeople.map((person) => {
            const viaRole = roles.includes(person.role);
            const on = selected.includes(person.id) || viaRole;
            return <Pressable key={person.id} onPress={() => toggle(person.id)} disabled={viaRole} style={[styles.person, on && styles.selected]}>
              <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? colors.primary : colors.muted} />
              <Text style={[ui.body, { flex: 1, fontWeight: "700" }]}>{person.name}</Text>
              <Text style={ui.small}>{roleLabels[person.role] ?? person.role}</Text>
            </Pressable>;
          })}
        </> : <Text style={[ui.small, { marginTop: 10 }]}>Une seule discussion pour toute l’équipe : les nouveaux membres la verront aussi.</Text>}
        {mode === "new" && !all && recipients.length > 1 ? <Field label="Nom de la discussion (facultatif)" value={title} onChangeText={setTitle} placeholder="Ex. Tournée du matin" /> : null}
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <Button label={mode === "new" ? "ÉCRIRE" : "AJOUTER"} onPress={() => done()} busy={busy} style={{ marginTop: 14 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

// A single profile alone stays a living "profile" conversation; otherwise people are listed.
async function startFromChoice(choice: { all: boolean; ids: string[]; roles: Role[]; title: string }) {
  if (choice.all) return startTeamConversation("all");
  if (choice.roles.length === 1) return startTeamConversation("role", { role: choice.roles[0] });
  if (choice.ids.length === 1) return startTeamConversation("direct", { memberIds: choice.ids });
  return startTeamConversation("group", { memberIds: choice.ids, title: choice.title });
}

// Admins and supervisors (moderator) may mark any message "needs a reply"; others only their own.
function TeamThread({ conversationId, onClose, onRead, moderator }: { conversationId: string; onClose: () => void; onRead: () => void; moderator?: boolean }) {
  const needsReplyOn = useModules()("needs_reply");
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const list = useRef<FlatList<TeamMessage>>(null);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<LocalFile | null>(null);
  const [needsReply, setNeedsReply] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [me, setMe] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const authorOf = (message: TeamMessage) => message.sender_id === me ? "Vous" : message.sender_name;
  function goTo(id: string) {
    const index = messages.findIndex((item) => item.id === id);
    if (index < 0) return;
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlight(id);
    setTimeout(() => setHighlight((current) => current === id ? null : current), 1600);
  }

  async function reloadThread() {
    const thread = await fetchTeamThread(conversationId);
    setTitle(thread.title);
    setMembers(thread.members);
    setMessages(thread.messages);
  }

  async function toggleFlag(message: TeamMessage) {
    const next = !message.needs_reply;
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, needs_reply: next } : item));
    try {
      await flagTeamMessage(message.id, next);
    } catch (cause) {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, needs_reply: !next } : item));
      setError(errorMessage(cause, "Impossible de marquer le message. La migration 20261102 est-elle exécutée ?"));
    }
  }

  async function markRead() {
    try {
      await markTeamRead(conversationId);
      onRead();
    } catch {
      // Read state is best effort.
    }
  }

  useEffect(() => {
    const realtime = supabase;
    let active = true;
    void realtime?.auth.getUser().then(({ data }) => { if (active) setMe(data.user?.id ?? null); });
    void fetchTeamThread(conversationId)
      .then((thread) => { if (!active) return; setTitle(thread.title); setMembers(thread.members); setMessages(thread.messages); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause, "Impossible d’ouvrir la conversation.")); })
      .finally(() => { if (active) setLoading(false); });
    void markRead();
    if (!realtime) return () => { active = false; };
    const channel = realtime.channel(`team-thread-${conversationId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "team_messages", filter: `conversation_id=eq.${conversationId}` }, () => {
        // Reload to get the sender's name, then mark as read.
        void fetchTeamThread(conversationId).then((thread) => { if (active) setMessages(thread.messages); });
        void markRead();
      })
      .subscribe();
    return () => { active = false; void realtime.removeChannel(channel); };
  }, [conversationId]);

  const sendLock = useRef(false);
  async function send() {
    const body = draft.trim();
    if (!body && !file) return;
    if (sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setError("");
    try {
      const attachment = file ? await uploadAttachment(`team/${conversationId}`, file) : null;
      const message = await sendTeamMessage(conversationId, body, attachment, needsReply, replyTo?.id ?? null);
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

  return <>
    <ScreenHeader eyebrow={`${members.length} PARTICIPANT(S)`} title={title || "Conversation"} subtitle={members.length > 1 && members.length <= 8 ? members.join(", ") : undefined} right={<View style={[ui.row, { gap: 6 }]}>
      <Pressable onPress={() => setAdding(true)} style={styles.addButton} accessibilityLabel="Ajouter des participants"><Ionicons name="person-add-outline" size={18} color={colors.primary} /></Pressable>
      <CloseButton onPress={onClose} />
    </View>} />
    <RecipientsModal visible={adding} mode="add" onClose={() => setAdding(false)} onDone={async (choice) => { await addTeamMembers(conversationId, choice.ids); setAdding(false); await reloadThread(); }} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      {loading ? <Loading /> : messages.length === 0 ? <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState title="Aucun message" body="Écrivez le premier message ci-dessous." />
      </View> : <FlatList
        ref={list}
        inverted
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={{ padding: 14, flexGrow: 1 }}
        onScrollToIndexFailed={({ index }) => setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5 }), 250)}
        renderItem={({ item }) => {
          const mine = item.sender_id === me;
          const canFlag = needsReplyOn && (!!moderator || mine);
          const original = item.reply_to ? messages.find((other) => other.id === item.reply_to) : undefined;
          return <Pressable onLongPress={() => setReplyTo(item)} delayLongPress={350} style={[styles.bubble, mine ? styles.mine : styles.theirs, item.needs_reply && { borderWidth: 2, borderColor: colors.danger }, highlight === item.id && { borderWidth: 2, borderColor: colors.orange }]}>
            {item.needs_reply ? <NeedsReplyTag mine={mine} /> : null}
            {!mine ? <Text style={styles.author}>{item.sender_name}</Text> : null}
            {item.reply_to ? <ReplyQuote mine={mine} author={original ? authorOf(original) : "Message"} text={original ? messagePreview(original.body, original.attachment) : null} onPress={original ? () => goTo(original.id) : undefined} /> : null}
            {item.attachment ? <AttachmentView attachment={item.attachment} mine={mine} /> : null}
            {item.body ? <Text style={[styles.body, mine && { color: colors.white }]}>{item.body}</Text> : null}
            <Text style={[styles.time, mine && { color: colors.onPrimaryMuted }]}>{formatDateTime(item.created_at)}</Text>
            <View style={styles.footer}>
              <ReplyAction mine={mine} onPress={() => setReplyTo(item)} />
              {canFlag ? <Pressable onPress={() => void toggleFlag(item)} hitSlop={6} style={styles.flagRow}>
                <Ionicons name={item.needs_reply ? "checkbox" : "square-outline"} size={14} color={item.needs_reply ? colors.danger : mine ? colors.onPrimaryMuted : colors.muted} />
                <Text style={[styles.flagText, mine && { color: colors.onPrimaryMuted }, item.needs_reply && { color: mine ? colors.white : colors.danger }]}>Nécessite une réponse</Text>
              </Pressable> : null}
            </View>
          </Pressable>;
        }}
      />}
      {error ? <Text style={[ui.error, { paddingHorizontal: 14 }]}>{error}</Text> : null}
      {replyTo ? <ReplyBanner author={authorOf(replyTo)} text={messagePreview(replyTo.body, replyTo.attachment)} onCancel={() => setReplyTo(null)} /> : null}
      <AttachmentPicker value={file} onChange={setFile} disabled={sending} extra={<NeedsReplyToggle value={needsReply} onChange={setNeedsReply} />} />
      <View style={styles.composer}>
        <TextInput value={draft} onChangeText={setDraft} placeholder={file ? "Ajouter un texte (facultatif)…" : "Votre message…"} placeholderTextColor={colors.muted} style={[ui.input, { flex: 1, maxHeight: 120 }]} multiline maxLength={2000} />
        <Pressable onPress={() => void send()} disabled={sending || (!draft.trim() && !file)} style={[styles.send, (sending || (!draft.trim() && !file)) && ui.disabled]} accessibilityLabel="Envoyer">
          <Ionicons name="send" size={18} color={colors.white} />
        </Pressable>
      </View>
      <KeyboardSpacer />
    </KeyboardAvoidingView>
  </>;
}

const styles = StyleSheet.create({
  conversation: { flexDirection: "row", alignItems: "center", gap: 10 },
  unreadCard: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "800" },
  choice: { flexDirection: "row", alignItems: "center", gap: 10 },
  selected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  person: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 9, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  link: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  bubble: { maxWidth: "82%", padding: 9, borderRadius: 12, marginVertical: 3 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.primary, borderBottomRightRadius: 3 },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 3 },
  author: { color: colors.orange, fontSize: 10, fontWeight: "800", marginBottom: 2 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  time: { color: colors.muted, fontSize: 9, marginTop: 3, textAlign: "right" },
  addButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  footer: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 4 },
  flagRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  flagText: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
});
