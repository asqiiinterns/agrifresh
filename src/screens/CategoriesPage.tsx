import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { fetchPlatformCategories, saveCategory, type PlatformCategory } from "../data/categories";
import { Button, Chip, EmptyState, Field, Loading, ScreenHeader } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Draft = { id: string | null; name: string; parentId: string | null; sortOrder: string; active: boolean };

// Appro+ console: the categories every Pro files its products in (one level of sub-categories).
export function CategoriesPage({ header }: { header: React.ReactNode }) {
  const [list, setList] = useState<PlatformCategory[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  async function reload() {
    setError("");
    try {
      setList(await fetchPlatformCategories());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les catégories. La migration 20261116 est-elle exécutée ?"));
    }
  }
  useEffect(() => { void reload(); }, []);

  const mains = useMemo(() => (list ?? []).filter((item) => !item.parent_id), [list]);
  const childrenOf = (id: string) => (list ?? []).filter((item) => item.parent_id === id);

  function edit(item: PlatformCategory | null, parentId: string | null = null) {
    setFormError("");
    setDraft(item
      ? { id: item.id, name: item.name, parentId: item.parent_id, sortOrder: String(item.sort_order), active: item.active }
      : { id: null, name: "", parentId, sortOrder: "", active: true });
  }

  async function save() {
    if (!draft) return;
    const sortOrder = draft.sortOrder.trim() === "" ? null : Number(draft.sortOrder);
    if (sortOrder !== null && !Number.isFinite(sortOrder)) {
      setFormError("L’ordre est un nombre.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await saveCategory(draft.id, { name: draft.name, parentId: draft.parentId, sortOrder, active: draft.active });
      setDraft(null);
      await reload();
    } catch (cause) {
      setFormError(errorMessage(cause, "La catégorie n’a pas pu être enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  const row = (item: PlatformCategory, sub: boolean) => <Pressable key={item.id} onPress={() => edit(item)} style={[ui.row, ui.divider, sub && { paddingLeft: 18 }]}>
    <View style={{ flex: 1 }}>
      <Text style={[sub ? ui.body : ui.strong, !item.active && { color: colors.muted }]}>{sub ? `› ${item.name}` : item.name}</Text>
      <Text style={ui.small}>{item.active ? `${item.products} produit(s)` : `Masquée · ${item.products} produit(s)`}</Text>
    </View>
    <Text style={ui.small}>{item.sort_order}</Text>
  </Pressable>;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+ · PARAMÉTRAGE" title="Catégories" subtitle="Une seule liste pour tous les Pros : leurs produits deviennent comparables entre fournisseurs." right={header} />
    {!list ? (error ? <EmptyState title="Catégories indisponibles" body={error} /> : <Loading />) : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      {draft ? <View style={ui.card}>
        <Text style={ui.strong}>{draft.id ? "Modifier la catégorie" : draft.parentId ? "Nouvelle sous-catégorie" : "Nouvelle catégorie"}</Text>
        <Field label="Nom" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
        <Text style={[ui.fieldLabel, { marginTop: 8 }]}>Rangée sous</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          <Chip label="Catégorie principale" selected={draft.parentId === null} onPress={() => setDraft({ ...draft, parentId: null })} />
          {mains.filter((item) => item.id !== draft.id).map((item) => <Chip key={item.id} label={item.name} selected={draft.parentId === item.id} onPress={() => setDraft({ ...draft, parentId: item.id })} />)}
        </View>
        <Field label="Ordre d’affichage (facultatif)" value={draft.sortOrder} onChangeText={(sortOrder) => setDraft({ ...draft, sortOrder })} keyboardType="number-pad" />
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          <Chip label="Visible" selected={draft.active} onPress={() => setDraft({ ...draft, active: true })} />
          <Chip label="Masquée" selected={!draft.active} onPress={() => setDraft({ ...draft, active: false })} />
        </View>
        <Text style={[ui.small, { marginTop: 6 }]}>Une catégorie masquée n’est plus proposée aux Pros ; les produits déjà rangés dedans la gardent.</Text>
        {formError ? <Text style={[ui.error, { marginTop: 8 }]}>{formError}</Text> : null}
        <View style={[ui.wrapRow, { marginTop: 10 }]}>
          <Button label="ENREGISTRER" onPress={() => save()} busy={busy} />
          <Button label="ANNULER" variant="secondary" onPress={() => setDraft(null)} disabled={busy} />
        </View>
      </View> : <View style={[ui.wrapRow, { marginTop: 12 }]}>
        <Button label="+ CATÉGORIE" onPress={() => edit(null)} />
      </View>}
      {mains.map((main) => <View key={main.id} style={ui.card}>
        {row(main, false)}
        {childrenOf(main.id).map((child) => row(child, true))}
        {!draft ? <Button label="+ SOUS-CATÉGORIE" variant="secondary" onPress={() => edit(null, main.id)} style={{ marginTop: 8, alignSelf: "flex-start" }} /> : null}
      </View>)}
    </ScrollView>}
  </View>;
}
