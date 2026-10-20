import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { roleLabels, type Role } from "../data/account";
import {
  fetchTeamConversations, fetchTeamDirectory, fetchTeamThread, markTeamRead, sendTeamMessage, startTeamConversation,
  type TeamConversation, type TeamConversationKind, type TeamMessage, type TeamPerson,
} from "../data/teamMessages";
import { Button, CloseButton, EmptyState, Field, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { uploadAttachment, type LocalFile } from "../data/attachments";
import { AttachmentPicker, AttachmentView } from "../ui/Attachments";
import type { IconName } from "../ui/navigation";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const kindIcon: Record<TeamConversationKind, IconName> = { direct: "person-outline", group: "people-outline", role: "id-card-outline", all: "megaphone-outline" };

// Team conversations: list, new conversation, thread.
export function TeamMessagesList({ onRead, initialConversationId }: { onRead: () => void; initialConversationId?: string }) {
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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune conversation" body="Touchez « Nouveau message » pour écrire à un collègue, à plusieurs, à un profil ou à toute l’équipe." />}
      renderItem={({ item }) => <Pressable onPress={() => setOpenId(item.id)} style={[ui.card, styles.conversation, item.unread > 0 && styles.unreadCard]}>
        <View style={styles.avatar}><Ionicons name={kindIcon[item.kind]} size={18} color={colors.green} /></View>
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
    <NewConversationModal visible={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); void reload(); }} />
    <Modal visible={openId !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpenId(null)}>
      <SafeAreaView style={ui.modalSafe}>
        {openId ? <TeamThread conversationId={openId} onClose={() => { setOpenId(null); void reload(); }} onRead={onRead} /> : null}
      </SafeAreaView>
    </Modal>
  </View>;
}

const choices: { kind: TeamConversationKind; title: string; body: string }[] = [
  { kind: "direct", title: "Une personne", body: "Discussion privée avec un collègue." },
  { kind: "group", title: "Plusieurs personnes", body: "Choisissez les participants et donnez un nom au groupe." },
  { kind: "role", title: "Un profil", body: "Tous les livreurs, toute la production, tous les superviseurs…" },
  { kind: "all", title: "Toute l’équipe", body: "Une annonce pour tout le monde." },
];
const teamRoles: Role[] = ["supervisor", "production", "driver", "admin"];
const roleAudience: Partial<Record<Role, string>> = {
  supervisor: "Tous les superviseurs",
  production: "Toute l’équipe de production",
  driver: "Tous les livreurs",
  admin: "Tous les administrateurs",
};

function NewConversationModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<TeamConversationKind | null>(null);
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setKind(null);
    setSelected([]);
    setRole(null);
    setTitle("");
    setSearch("");
    setError("");
    void fetchTeamDirectory().then(setPeople).catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger l’équipe.")));
  }, [visible]);

  const term = search.trim().toLocaleLowerCase("fr");
  const visiblePeople = people.filter((person) => `${person.name} ${roleLabels[person.role] ?? ""}`.toLocaleLowerCase("fr").includes(term));
  const counts = useMemo(() => Object.fromEntries(teamRoles.map((item) => [item, people.filter((person) => person.role === item).length])), [people]);

  async function start(nextKind = kind) {
    if (!nextKind) return;
    if (nextKind === "direct" && selected.length !== 1) { setError("Choisissez une personne."); return; }
    if (nextKind === "group" && selected.length < 1) { setError("Choisissez au moins une personne."); return; }
    if (nextKind === "role" && !role) { setError("Choisissez un profil."); return; }
    setBusy(true);
    setError("");
    try {
      onCreated(await startTeamConversation(nextKind, { memberIds: selected, role: role ?? undefined, title }));
    } catch (cause) {
      setError(errorMessage(cause, "La conversation n’a pas pu être ouverte."));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setSelected((current) => kind === "direct" ? [id] : current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="MESSAGE À L’ÉQUIPE" title={kind ? choices.find((item) => item.kind === kind)!.title : "À qui écrire ?"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {!kind ? choices.map((choice) => <Pressable key={choice.kind} onPress={() => { setSelected([]); if (choice.kind === "all") void start("all"); else setKind(choice.kind); }} style={[ui.card, styles.choice]}>
          <View style={styles.avatar}><Ionicons name={kindIcon[choice.kind]} size={20} color={colors.green} /></View>
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>{choice.title}</Text>
            <Text style={ui.small}>{choice.body}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.muted} />
        </Pressable>) : <>
          <Pressable onPress={() => setKind(null)} style={{ marginTop: 8 }}><Text style={styles.link}>‹ Changer de type</Text></Pressable>
          {kind === "role" ? <View style={{ marginTop: 6 }}>
            {teamRoles.map((item) => {
              const on = role === item;
              return <Pressable key={item} onPress={() => setRole(item)} style={[ui.card, styles.choice, on && styles.selected]}>
                <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? colors.green : colors.muted} />
                <Text style={[ui.strong, { flex: 1 }]}>{roleAudience[item]}</Text>
                <Text style={ui.small}>{counts[item] ?? 0} pers.</Text>
              </Pressable>;
            })}
          </View> : <>
            {kind === "group" ? <Field label="Nom du groupe (facultatif)" value={title} onChangeText={setTitle} placeholder="Ex. Tournée du matin" /> : null}
            <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un collègue" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} />
            {kind === "group" ? <Text style={[ui.small, { marginTop: 6 }]}>{selected.length} personne(s) sélectionnée(s)</Text> : null}
            {visiblePeople.map((person) => {
              const on = selected.includes(person.id);
              return <Pressable key={person.id} onPress={() => toggle(person.id)} style={[styles.person, on && styles.selected]}>
                <Ionicons name={kind === "direct" ? (on ? "radio-button-on" : "radio-button-off") : (on ? "checkbox" : "square-outline")} size={20} color={on ? colors.green : colors.muted} />
                <Text style={[ui.body, { flex: 1, fontWeight: "700" }]}>{person.name}</Text>
                <Text style={ui.small}>{roleLabels[person.role] ?? person.role}</Text>
              </Pressable>;
            })}
          </>}
          {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
          <Button label="ÉCRIRE" onPress={() => void start()} busy={busy} style={{ marginTop: 14 }} />
        </>}
        {!kind && error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

function TeamThread({ conversationId, onClose, onRead }: { conversationId: string; onClose: () => void; onRead: () => void }) {
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<LocalFile | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [me, setMe] = useState<string | null>(null);

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

  async function send() {
    const body = draft.trim();
    if (!body && !file) return;
    setSending(true);
    setError("");
    try {
      const attachment = file ? await uploadAttachment(`team/${conversationId}`, file) : null;
      const message = await sendTeamMessage(conversationId, body, attachment);
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [message, ...current]);
      setDraft("");
      setFile(null);
    } catch (cause) {
      setError(errorMessage(cause, "Le message n’a pas pu être envoyé."));
    } finally {
      setSending(false);
    }
  }

  return <>
    <ScreenHeader eyebrow={`${members.length} PARTICIPANT(S)`} title={title || "Conversation"} subtitle={members.length > 1 && members.length <= 8 ? members.join(", ") : undefined} right={<CloseButton onPress={onClose} />} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      {loading ? <Loading /> : messages.length === 0 ? <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState title="Aucun message" body="Écrivez le premier message ci-dessous." />
      </View> : <FlatList
        inverted
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={{ padding: 14, flexGrow: 1 }}
        renderItem={({ item }) => {
          const mine = item.sender_id === me;
          return <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
            {!mine ? <Text style={styles.author}>{item.sender_name}</Text> : null}
            {item.attachment ? <AttachmentView attachment={item.attachment} mine={mine} /> : null}
            {item.body ? <Text style={[styles.body, mine && { color: colors.white }]}>{item.body}</Text> : null}
            <Text style={[styles.time, mine && { color: "#d4e3d6" }]}>{formatDateTime(item.created_at)}</Text>
          </View>;
        }}
      />}
      {error ? <Text style={[ui.error, { paddingHorizontal: 14 }]}>{error}</Text> : null}
      <AttachmentPicker value={file} onChange={setFile} disabled={sending} />
      <View style={styles.composer}>
        <TextInput value={draft} onChangeText={setDraft} placeholder={file ? "Ajouter un texte (facultatif)…" : "Votre message…"} placeholderTextColor={colors.muted} style={[ui.input, { flex: 1, maxHeight: 120 }]} multiline maxLength={2000} />
        <Pressable onPress={() => void send()} disabled={sending || (!draft.trim() && !file)} style={[styles.send, (sending || (!draft.trim() && !file)) && ui.disabled]} accessibilityLabel="Envoyer">
          <Ionicons name="send" size={18} color={colors.white} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  </>;
}

const styles = StyleSheet.create({
  conversation: { flexDirection: "row", alignItems: "center", gap: 10 },
  unreadCard: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#e6efe4", alignItems: "center", justifyContent: "center" },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "800" },
  choice: { flexDirection: "row", alignItems: "center", gap: 10 },
  selected: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  person: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 9, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  link: { color: colors.green, fontSize: 12, fontWeight: "800" },
  bubble: { maxWidth: "82%", padding: 9, borderRadius: 12, marginVertical: 3 },
  mine: { alignSelf: "flex-end", backgroundColor: colors.green, borderBottomRightRadius: 3 },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderBottomLeftRadius: 3 },
  author: { color: colors.orange, fontSize: 10, fontWeight: "800", marginBottom: 2 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  time: { color: colors.muted, fontSize: 9, marginTop: 3, textAlign: "right" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" },
});
