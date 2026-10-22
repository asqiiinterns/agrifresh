import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, TextInput } from "../ui/Text";
import {
  deletePriceGroup, deleteRule, emptyRule, fetchPricing, kindLabels, ruleBenefit, ruleConditions, savePriceGroup, saveRule, setClientPriceGroup,
  setRuleActive, weekdayLabels, type PricingOverview, type PricingRule, type RuleKind, type Tier,
} from "../data/pricing";
import { fetchAdminProducts, fetchCategories, type AdminProduct, type Category } from "../data/productAdmin";
import { Button, Chip, CloseButton, EmptyState, Field, ListGroup, Loading, ScreenHeader, formatPrice } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Supplier side: discounts and negotiated prices, and the client groups they target. The server applies
// them to every order and to the buyer's cart, live (20261118_pro_modules_pricing.sql).
export function PricingModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"rules" | "groups">("rules");
  const [data, setData] = useState<PricingOverview | null>(null);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<PricingRule | null>(null);

  async function reload() {
    setError("");
    try {
      setData(await fetchPricing());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les remises. La migration 20261118 est-elle exécutée ?"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    void reload();
    void fetchAdminProducts().then(setProducts).catch(() => {});
    void fetchCategories().then(setCategories).catch(() => {});
  }, [visible]);

  const groupName = (id?: string | null) => data?.groups.find((group) => group.id === id)?.name ?? "groupe supprimé";
  const clientName = (id?: string | null) => data?.clients.find((item) => item.id === id)?.business_name ?? "client";
  const targetText = (rule: PricingRule) => rule.target === "group" ? `Groupe ${groupName(rule.price_group_id)}` : rule.target === "client" ? clientName(rule.client_id) : "Tous les clients";
  const scopeText = (rule: PricingRule) => rule.product_scope === "products"
    ? rule.product_ids.map((id) => products.find((item) => item.id === id)?.name ?? "?").join(", ")
    : rule.product_scope === "category" ? rule.category_ids.map((id) => categories.find((item) => item.id === id)?.name ?? "?").join(", ") : "Tous les produits";

  async function toggle(rule: PricingRule & { id: string }, active: boolean) {
    try {
      await setRuleActive(rule.id, active);
      await reload();
    } catch (cause) {
      notify("Remises", errorMessage(cause, "La remise n’a pas pu être modifiée."));
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="CATALOGUE" title="Remises et tarifs" subtitle="Appliqués par le serveur à chaque commande et en direct dans le panier de vos clients." right={<CloseButton onPress={onClose} />} />
      <View style={[ui.wrapRow, { paddingHorizontal: 18, paddingTop: 10 }]}>
        <Chip label={`Remises${data ? ` (${data.rules.length})` : ""}`} selected={tab === "rules"} onPress={() => setTab("rules")} />
        <Chip label={`Groupes de clients${data ? ` (${data.groups.length})` : ""}`} selected={tab === "groups"} onPress={() => setTab("groups")} />
      </View>
      {loading ? <Loading /> : error ? <EmptyState title="Remises indisponibles" body={error} action={<Button label="RÉESSAYER" onPress={() => reload()} />} /> : data ? <ScrollView contentContainerStyle={ui.content}>
        {tab === "rules" ? <>
          <Text style={[ui.small, { marginTop: 8 }]}>Pour chaque produit commandé : un prix net négocié remplace le prix catalogue, puis la meilleure remise s’applique ; les remises « cumulables » s’ajoutent par-dessus. Vos clients voient vos offres dans Commander, et ce qui leur manque pour la remise suivante.</Text>
          <Button label="+ NOUVELLE REMISE" onPress={() => setEditing(emptyRule())} style={{ marginTop: 10 }} />
          {data.rules.length === 0 ? <EmptyState title="Aucune remise" body="Exemples : −5 % pour le groupe Hôtels, 10 + 1 offert sur un produit, −3 % dès 500 TND de commande, un prix net pour un client." /> : null}
          {data.rules.map((rule) => <Pressable key={rule.id} onPress={() => setEditing(rule)} style={[ui.card, !rule.active && { opacity: 0.6 }]}>
            <View style={[ui.row, { justifyContent: "flex-start" }]}>
              <Switch value={rule.active} onValueChange={(value) => void toggle(rule, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <View style={{ flex: 1 }}>
                <Text style={ui.strong}>{rule.name}</Text>
                <Text style={styles.benefit}>{`${kindLabels[rule.kind]} · ${ruleBenefit(rule)}${rule.stackable ? " · cumulable" : ""}`}</Text>
              </View>
            </View>
            <Text style={ui.small}>{`${targetText(rule)} · ${scopeText(rule)}`}</Text>
            {ruleConditions(rule).length || rule.starts_on ? <Text style={ui.small}>{[rule.starts_on ? `à partir du ${rule.starts_on}` : "", ...ruleConditions(rule)].filter(Boolean).join(" · ")}</Text> : null}
          </Pressable>)}
        </> : <GroupsPanel data={data} onChanged={reload} />}
      </ScrollView> : null}
      {editing && data ? <RuleEditor rule={editing} data={data} products={products} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
    </SafeAreaView>
  </Modal>;
}

// Client groups ("Hôtels", "Revendeurs"…) and which client is in which group.
function GroupsPanel({ data, onChanged }: { data: PricingOverview; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  async function act(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      notify("Groupes de clients", errorMessage(cause, failure));
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string, label: string) {
    notify("Supprimer le groupe", `Les clients de « ${label} » n’auront plus de groupe et ses remises seront supprimées.`, [
      { text: "Annuler", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void act(() => deletePriceGroup(id), "Le groupe n’a pas pu être supprimé.") },
    ]);
  }

  const needle = search.trim().toLocaleLowerCase("fr");
  const clients = data.clients.filter((item) => !needle || item.business_name.toLocaleLowerCase("fr").includes(needle));
  return <>
    <Text style={[ui.small, { marginTop: 8 }]}>Un groupe réunit des clients qui ont les mêmes conditions. Une remise peut viser un groupe : elle s’applique à chaque client du groupe.</Text>
    <View style={[ui.row, { gap: 8, marginTop: 10 }]}>
      <TextInput value={name} onChangeText={setName} placeholder="Nouveau groupe (ex. Hôtels)" placeholderTextColor={colors.muted} style={[ui.input, { flex: 1 }]} />
      <Button label="CRÉER" busy={busy} disabled={!name.trim()} onPress={() => void act(() => savePriceGroup(null, name), "Le groupe n’a pas pu être créé.").then(() => setName(""))} />
    </View>
    {data.groups.length ? <ListGroup title="Groupes">
      {data.groups.map((group) => renaming?.id === group.id ? <View key={group.id} style={styles.groupRow}>
        <TextInput value={renaming.name} onChangeText={(next) => setRenaming({ id: group.id, name: next })} autoFocus style={[ui.input, { flex: 1 }]} />
        <Pressable onPress={() => { const next = renaming; if (next.name.trim()) void act(() => savePriceGroup(next.id, next.name), "Le groupe n’a pas pu être renommé.").then(() => setRenaming(null)); }} style={{ padding: 6 }}><Text style={styles.link}>OK</Text></Pressable>
        <Pressable onPress={() => setRenaming(null)} style={{ padding: 6 }}><Text style={[styles.link, { color: colors.muted }]}>Annuler</Text></Pressable>
      </View> : <View key={group.id} style={styles.groupRow}>
        <View style={{ flex: 1 }}>
          <Text style={ui.strong}>{group.name}</Text>
          <Text style={ui.small}>{`${group.clients} client(s)`}</Text>
        </View>
        <Pressable onPress={() => setRenaming({ id: group.id, name: group.name })} style={{ padding: 6 }}><Text style={styles.link}>Renommer</Text></Pressable>
        <Pressable onPress={() => remove(group.id, group.name)} style={{ padding: 6 }}><Text style={[styles.link, { color: colors.danger }]}>Supprimer</Text></Pressable>
      </View>)}
    </ListGroup> : null}
    {data.groups.length ? <>
      <Text style={[ui.strong, { marginTop: 16 }]}>Groupe de chaque client</Text>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} />
      {clients.map((item) => <View key={item.id} style={ui.card}>
        <Text style={ui.strong}>{item.business_name}</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          <Chip label="Aucun" selected={!item.price_group_id} onPress={() => void act(() => setClientPriceGroup(item.id, null), "Le client n’a pas pu être modifié.")} />
          {data.groups.map((group) => <Chip key={group.id} label={group.name} selected={item.price_group_id === group.id} onPress={() => void act(() => setClientPriceGroup(item.id, group.id), "Le client n’a pas pu être modifié.")} />)}
        </View>
      </View>)}
    </> : null}
  </>;
}

const text = (value?: number | null) => value === null || value === undefined ? "" : String(value);
const num = (value: string) => {
  const parsed = Number(value.replace(",", ".").trim());
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function RuleEditor({ rule, data, products, categories, onClose, onSaved }: {
  rule: PricingRule;
  data: PricingOverview;
  products: AdminProduct[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PricingRule>(rule);
  const [value, setValue] = useState(text(rule.value));
  const [buy, setBuy] = useState(text(rule.buy_qty));
  const [free, setFree] = useState(text(rule.free_qty));
  const [tiers, setTiers] = useState<{ min: string; percent: string }[]>(rule.tiers.length ? rule.tiers.map((tier) => ({ min: String(tier.min_qty), percent: String(tier.percent) })) : [{ min: "", percent: "" }]);
  const [minAmount, setMinAmount] = useState(text(rule.min_order_amount));
  const [minQty, setMinQty] = useState(text(rule.min_line_qty));
  const [minPast, setMinPast] = useState(text(rule.min_past_orders));
  const [starts, setStarts] = useState(rule.starts_on ?? "");
  const [ends, setEnds] = useState(rule.ends_on ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof PricingRule>(key: K, next: PricingRule[K]) => setForm((current) => ({ ...current, [key]: next }));
  const toggleIn = (list: string[], id: string) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  function setKind(kind: RuleKind) {
    setForm((current) => ({ ...current, kind, product_scope: kind === "net_price" ? "products" : current.product_scope }));
  }

  const needle = search.trim().toLocaleLowerCase("fr");
  const shownProducts = useMemo(() => products.filter((item) => item.active && (!needle || item.name.toLocaleLowerCase("fr").includes(needle) || form.product_ids.includes(item.id))), [products, needle, form.product_ids]);
  const shownClients = useMemo(() => data.clients.filter((item) => !needle || item.business_name.toLocaleLowerCase("fr").includes(needle) || item.id === form.client_id), [data.clients, needle, form.client_id]);

  async function save() {
    if ((starts && !DATE.test(starts)) || (ends && !DATE.test(ends))) {
      setError("Les dates s’écrivent AAAA-MM-JJ, par exemple 2026-12-31.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const tierList: Tier[] = tiers.map((tier) => ({ min_qty: num(tier.min) ?? 0, percent: num(tier.percent) ?? 0 })).filter((tier) => tier.min_qty || tier.percent);
      await saveRule({ ...form, value: num(value), buy_qty: num(buy), free_qty: num(free), tiers: tierList, min_order_amount: num(minAmount), min_line_qty: num(minQty),
        min_past_orders: num(minPast), starts_on: starts || null, ends_on: ends || null });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "La remise n’a pas pu être enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!form.id) return;
    const id = form.id;
    notify("Supprimer la remise", `« ${form.name} » ne s’appliquera plus aux prochaines commandes. Les commandes passées gardent leurs prix.`, [
      { text: "Annuler", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => { void deleteRule(id).then(onSaved).catch((cause: unknown) => setError(errorMessage(cause, "La remise n’a pas pu être supprimée."))); } },
    ]);
  }

  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader eyebrow="REMISES ET TARIFS" title={form.id ? "Modifier la remise" : "Nouvelle remise"} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <View style={ui.card}>
            <Field label="Nom affiché au client" value={form.name} onChangeText={(next) => set("name", next)} placeholder="Ex. Promo d’été, Prix hôtels" />
            <Text style={ui.fieldLabel}>Type</Text>
            <View style={ui.wrapRow}>
              {(Object.keys(kindLabels) as RuleKind[]).map((kind) => <Chip key={kind} label={kindLabels[kind]} selected={form.kind === kind} onPress={() => setKind(kind)} />)}
            </View>
            {form.kind === "percent" ? <Field label="Remise (%)" value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="10" /> : null}
            {form.kind === "net_price" ? <Field label="Prix net HT négocié (par unité)" value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="2,500" /> : null}
            {form.kind === "free_units" ? <View style={[ui.row, { gap: 8 }]}>
              <View style={{ flex: 1 }}><Field label="Achetés" value={buy} onChangeText={setBuy} keyboardType="decimal-pad" placeholder="10" /></View>
              <View style={{ flex: 1 }}><Field label="Offerts" value={free} onChangeText={setFree} keyboardType="decimal-pad" placeholder="1" /></View>
            </View> : null}
            {form.kind === "free_units" ? <Text style={ui.small}>Le client commande la quantité totale : sur chaque lot (achetés + offerts), les offerts ne sont pas facturés.</Text> : null}
            {form.kind === "tiers" ? <>
              {tiers.map((tier, index) => <View key={index} style={[ui.row, { gap: 8 }]}>
                <View style={{ flex: 1 }}><Field label="Dès la quantité" value={tier.min} onChangeText={(next) => setTiers((current) => current.map((item, i) => i === index ? { ...item, min: next } : item))} keyboardType="decimal-pad" /></View>
                <View style={{ flex: 1 }}><Field label="Remise (%)" value={tier.percent} onChangeText={(next) => setTiers((current) => current.map((item, i) => i === index ? { ...item, percent: next } : item))} keyboardType="decimal-pad" /></View>
                {tiers.length > 1 ? <Pressable onPress={() => setTiers((current) => current.filter((_, i) => i !== index))} style={{ padding: 6, marginTop: 14 }}><Text style={[styles.link, { color: colors.danger }]}>✕</Text></Pressable> : null}
              </View>)}
              <Pressable onPress={() => setTiers((current) => [...current, { min: "", percent: "" }])} style={{ paddingVertical: 6 }}><Text style={styles.link}>+ Ajouter un palier</Text></Pressable>
            </> : null}
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Pour qui</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              <Chip label="Tous les clients" selected={form.target === "all"} onPress={() => set("target", "all")} />
              <Chip label="Un groupe" selected={form.target === "group"} onPress={() => set("target", "group")} />
              <Chip label="Un client" selected={form.target === "client"} onPress={() => set("target", "client")} />
            </View>
            {form.target === "group" ? data.groups.length ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
              {data.groups.map((group) => <Chip key={group.id} label={group.name} selected={form.price_group_id === group.id} onPress={() => set("price_group_id", group.id)} />)}
            </View> : <Text style={[ui.small, { marginTop: 6 }]}>Créez d’abord un groupe dans l’onglet « Groupes de clients ».</Text> : null}
            {form.target === "client" ? <>
              <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} />
              <View style={[ui.wrapRow, { marginTop: 8 }]}>
                {shownClients.slice(0, 30).map((item) => <Chip key={item.id} label={item.business_name} selected={form.client_id === item.id} onPress={() => set("client_id", item.id)} />)}
              </View>
            </> : null}
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Sur quels produits</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              {form.kind !== "net_price" ? <Chip label="Tous" selected={form.product_scope === "all"} onPress={() => set("product_scope", "all")} /> : null}
              {form.kind !== "net_price" ? <Chip label="Des catégories" selected={form.product_scope === "category"} onPress={() => set("product_scope", "category")} /> : null}
              <Chip label="Des produits choisis" selected={form.product_scope === "products"} onPress={() => set("product_scope", "products")} />
            </View>
            {form.product_scope === "category" ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
              {categories.map((item) => <Chip key={item.id} label={item.name} selected={form.category_ids.includes(item.id)} onPress={() => set("category_ids", toggleIn(form.category_ids, item.id))} />)}
            </View> : null}
            {form.product_scope === "products" ? <>
              <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un produit" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} />
              <View style={[ui.wrapRow, { marginTop: 8 }]}>
                {shownProducts.slice(0, 40).map((item) => <Chip key={item.id} label={`${item.name} · ${formatPrice(item.price)}`} selected={form.product_ids.includes(item.id)} onPress={() => set("product_ids", toggleIn(form.product_ids, item.id))} />)}
              </View>
            </> : null}
          </View>

          <View style={ui.card}>
            <Text style={ui.strong}>Conditions (facultatif)</Text>
            <Field label="Montant minimal de la commande (HT)" value={minAmount} onChangeText={setMinAmount} keyboardType="decimal-pad" placeholder="Ex. 500" />
            <Field label="Quantité minimale par produit" value={minQty} onChangeText={setMinQty} keyboardType="decimal-pad" />
            <View style={[ui.row, { gap: 8 }]}>
              <View style={{ flex: 1 }}><Field label="Du (AAAA-MM-JJ)" value={starts} onChangeText={setStarts} autoCapitalize="none" /></View>
              <View style={{ flex: 1 }}><Field label="Au (AAAA-MM-JJ)" value={ends} onChangeText={setEnds} autoCapitalize="none" /></View>
            </View>
            <Text style={ui.fieldLabel}>Jours de commande (aucun = tous)</Text>
            <View style={ui.wrapRow}>
              {weekdayLabels.map((label, index) => <Chip key={label} label={label} selected={form.weekdays.includes(index + 1)} onPress={() => set("weekdays", form.weekdays.includes(index + 1) ? form.weekdays.filter((day) => day !== index + 1) : [...form.weekdays, index + 1])} />)}
            </View>
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
              <Switch value={form.first_order_only} onValueChange={(next) => set("first_order_only", next)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <Text style={[ui.body, { flex: 1 }]}>Première commande du client seulement</Text>
            </View>
            <Field label="Fidélité : à partir de combien de commandes passées" value={minPast} onChangeText={setMinPast} keyboardType="number-pad" />
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 6 }]}>
              <Switch value={form.stackable} onValueChange={(next) => set("stackable", next)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <View style={{ flex: 1 }}>
                <Text style={ui.body}>Cumulable</Text>
                <Text style={ui.small}>S’ajoute à la meilleure remise au lieu d’être comparée avec elle.</Text>
              </View>
            </View>
            <View style={[ui.row, { justifyContent: "flex-start", marginTop: 6 }]}>
              <Switch value={form.active} onValueChange={(next) => set("active", next)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
              <Text style={[ui.body, { flex: 1 }]}>Active</Text>
            </View>
          </View>

          {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
          <Button label="ENREGISTRER" busy={busy} onPress={() => save()} style={{ marginTop: 12 }} />
          {form.id ? <Button label="SUPPRIMER" variant="danger" onPress={remove} style={{ marginTop: 8 }} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  benefit: { color: colors.orange, fontSize: 12, fontWeight: "700", marginTop: 2 },
  link: { color: colors.primary, fontWeight: "700", fontSize: 13 },
  groupRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
});
