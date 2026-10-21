import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { fetchPlatformCategories, saveCategory, saveCategoryFields, type PlatformCategory } from "../data/categories";
import type { CategoryField } from "../data/productAdmin";
import { Button, Chip, EmptyState, Field, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Draft = { id: string | null; name: string; parentId: string | null; sortOrder: string; active: boolean };

// Appro+ console: the categories every Pro files its products in (one level of sub-categories).
export function CategoriesPage({ header }: { header: React.ReactNode }) {
  const [list, setList] = useState<PlatformCategory[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [sheet, setSheet] = useState<PlatformCategory | null>(null);

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
      {sheet ? <SheetEditor category={sheet} parent={(list ?? []).find((item) => item.id === sheet.parent_id) ?? null}
        onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} /> : null}
      {mains.map((main) => <View key={main.id} style={ui.card}>
        {row(main, false)}
        {childrenOf(main.id).map((child) => row(child, true))}
        {!draft ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
          <Button label="+ SOUS-CATÉGORIE" variant="secondary" onPress={() => edit(null, main.id)} />
          <Button label={`FICHE PRODUIT${main.attributes?.length ? ` (${main.attributes.length})` : ""}`} variant="secondary" onPress={() => setSheet(main)} />
          {childrenOf(main.id).map((child) => <Button key={child.id} label={`FICHE · ${child.name}${child.attributes?.length ? ` (${child.attributes.length})` : ""}`} variant="secondary" onPress={() => setSheet(child)} />)}
        </View> : null}
      </View>)}
    </ScrollView>}
  </View>;
}

// The product sheet of a category: Appro+ lists the fields every Pro fills in (dropdown lists rather than free text),
// so that products become comparable between suppliers. A sub-category adds its fields to those of its category.
type FieldDraft = { key?: string; label: string; type: CategoryField["type"]; options: string; unit: string };
function SheetEditor({ category, parent, onClose, onSaved }: { category: PlatformCategory; parent: PlatformCategory | null; onClose: () => void; onSaved: () => void }) {
  const [fields, setFields] = useState<FieldDraft[]>((category.attributes ?? []).map((field) => ({ key: field.key, label: field.label, type: field.type, options: (field.options ?? []).join(", "), unit: field.unit ?? "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (index: number, patch: Partial<FieldDraft>) => setFields((current) => current.map((field, position) => position === index ? { ...field, ...patch } : field));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveCategoryFields(category.id, fields.map((field) => ({
        key: field.key, label: field.label.trim(), type: field.type, unit: field.unit.trim() || undefined,
        options: field.type === "list" ? field.options.split(/[,;\n]/).map((option) => option.trim()).filter(Boolean) : undefined,
      })));
      notify("Fiche produit", `Fiche de « ${category.name} » enregistrée.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "La fiche n’a pas pu être enregistrée. La migration 20261202 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }
  return <View style={ui.card}>
    <Text style={ui.strong}>Fiche produit · {category.name}</Text>
    <Text style={ui.small}>{parent?.attributes?.length ? `Elle complète les champs de « ${parent.name} » : ${parent.attributes.map((field) => field.label).join(", ")}. ` : ""}Les Pros remplissent ces champs pour chaque produit de la catégorie.</Text>
    {fields.map((field, index) => <View key={index} style={[ui.divider, { marginTop: 8 }]}>
      <Field label={`Champ ${index + 1}`} value={field.label} onChangeText={(label) => update(index, { label })} placeholder="Variété, Calibre, Conditionnement…" maxLength={40} />
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        <Chip label="Liste de choix" selected={field.type === "list"} onPress={() => update(index, { type: "list" })} />
        <Chip label="Nombre" selected={field.type === "number"} onPress={() => update(index, { type: "number" })} />
        <Chip label="Texte" selected={field.type === "text"} onPress={() => update(index, { type: "text" })} />
      </View>
      {field.type === "list" ? <Field label="Choix (séparés par des virgules)" value={field.options} onChangeText={(options) => update(index, { options })} placeholder="Extra, Catégorie I, Catégorie II" multiline /> : null}
      {field.type === "number" ? <Field label="Unité (facultatif)" value={field.unit} onChangeText={(unit) => update(index, { unit })} placeholder="mm, g, %" /> : null}
      <Button label="RETIRER CE CHAMP" variant="secondary" onPress={() => setFields((current) => current.filter((_, position) => position !== index))} style={{ marginTop: 6, alignSelf: "flex-start" }} />
    </View>)}
    <Button label="+ CHAMP" variant="secondary" onPress={() => setFields((current) => [...current, { label: "", type: "list", options: "", unit: "" }])} disabled={fields.length >= 20} style={{ marginTop: 10, alignSelf: "flex-start" }} />
    {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
    <View style={[ui.wrapRow, { marginTop: 10 }]}>
      <Button label="ENREGISTRER LA FICHE" onPress={save} busy={busy} />
      <Button label="FERMER" variant="secondary" onPress={onClose} disabled={busy} />
    </View>
  </View>;
}
