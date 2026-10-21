import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import {
  fetchMembersRights, fetchRightsCatalogue, setFeatureDisplay, setMemberPermission, setRolePermission,
  type CatalogueFunction, type MemberRights, type RolesMatrix,
} from "../data/pros";
import { pickCsvText, parseCsv } from "../data/csvFile";
import { saveCsv, toCsv } from "../data/exports";
import { escapeHtml, outputPdf } from "../data/pdf";
import { Button, Chip, CloseButton, EmptyState, Loading, ScreenHeader } from "../ui/components";
import { confirmWithPassword } from "../ui/PasswordConfirm";
import { useUnsavedChanges } from "../ui/unsavedGuard";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Column = { id: string; name: string; owner: boolean; granted: string[] };
type Display = "hidden" | "locked";
const OWNER_KEYS = ["supplier_owner", "buyer_owner"];
const yes = (value: string) => /^(oui|yes|1|x|vrai|true|✓)$/i.test(value.trim());
const no = (value: string) => /^(non|no|0|faux|false|-|–)$/i.test(value.trim());

// The matrix of rights: functions in rows (by area, reading or changing), roles or accounts in columns.
// Changes are prepared, then saved together (password asked for the critical ones); leaving with changes not
// saved asks first. Export (Excel/CSV, PDF) and import of a full or partial file with a preview of the changes.
export function RightsMatrix({ orgId, matrix, platform, onChanged }: { orgId?: string | null; matrix: RolesMatrix; platform: boolean; onChanged: () => Promise<void> | void }) {
  const [catalogue, setCatalogue] = useState<CatalogueFunction[] | null>(null);
  const [members, setMembers] = useState<MemberRights[] | null>(null);
  const [mode, setMode] = useState<"roles" | "accounts">("roles");
  const sides = (["supplier", "buyer"] as const).filter((side) => matrix.roles.some((role) => role.side === side));
  const [side, setSide] = useState<"supplier" | "buyer">(sides[0] ?? "supplier");
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [displayDraft, setDisplayDraft] = useState<Record<string, Display | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ file: string; changes: { cell: string; column: string; label: string; from: boolean; to: boolean }[]; ignored: string[] } | null>(null);
  const [openAreas, setOpenAreas] = useState<string[]>([]);

  async function load() {
    try {
      const [nextCatalogue, nextMembers] = await Promise.all([fetchRightsCatalogue(orgId), fetchMembersRights(orgId).catch(() => [] as MemberRights[])]);
      setCatalogue(nextCatalogue);
      setMembers(nextMembers);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger la matrice. Les migrations 20261124 et 20261125 sont-elles exécutées ?"));
    }
  }
  useEffect(() => { void load(); }, [orgId]);

  const owner = matrix.roles.find((role) => role.side === side && OWNER_KEYS.includes(role.template_key ?? ""));
  const ceiling = owner?.granted ?? [];
  const functions = useMemo(() => (catalogue ?? []).filter((item) => item.side === side), [catalogue, side]);
  const areas = useMemo(() => [...new Set(functions.map((item) => item.area))], [functions]);
  const columns: Column[] = mode === "roles"
    ? matrix.roles.filter((role) => role.side === side)
      .sort((a, b) => Number(OWNER_KEYS.includes(b.template_key ?? "")) - Number(OWNER_KEYS.includes(a.template_key ?? "")))
      .map((role) => ({ id: role.id, name: role.name, owner: OWNER_KEYS.includes(role.template_key ?? ""), granted: role.granted }))
    // Accounts: the Responsable and oneself are shown but locked (set by Appro+ / by another person).
    : (members ?? []).filter((member) => member.side === side).map((member) => ({ id: member.id, name: member.is_self ? `${member.name} (vous)` : member.name,
      owner: !!member.owner || (!!member.is_self && !platform), granted: member.granted }));

  const cellKey = (column: Column, key: string) => `${mode}|${column.id}|${key}`;
  const valueOf = (column: Column, key: string) => draft[cellKey(column, key)] ?? column.granted.includes(key);
  const editable = (column: Column, key: string) => matrix.can_edit && (platform || (!column.owner && (ceiling.includes(key) || valueOf(column, key))));
  const displayOf = (item: CatalogueFunction): Display => (item.key in displayDraft ? displayDraft[item.key] ?? item.display_default : item.display);

  function set(column: Column, key: string, value: boolean) {
    const original = column.granted.includes(key);
    setDraft((current) => {
      const next = { ...current };
      if (value === original) delete next[cellKey(column, key)]; else next[cellKey(column, key)] = value;
      return next;
    });
  }

  // An area for one column: nothing → reading → changing → nothing.
  function areaState(column: Column, area: string) {
    const items = functions.filter((item) => item.area === area);
    const reads = items.filter((item) => item.kind === "read");
    const writes = items.filter((item) => item.kind === "write");
    const on = (list: CatalogueFunction[]) => list.length > 0 && list.every((item) => valueOf(column, item.key));
    const off = (list: CatalogueFunction[]) => list.every((item) => !valueOf(column, item.key));
    if (off(items)) return "none";
    if (on(items)) return "write";
    if ((reads.length === 0 || on(reads)) && off(writes)) return "read";
    return "partial";
  }
  function cycleArea(column: Column, area: string) {
    const state = areaState(column, area);
    const target = state === "none" ? "read" : state === "read" ? "write" : "none";
    functions.filter((item) => item.area === area).forEach((item) => {
      if (!editable(column, item.key)) return;
      const value = target === "write" || (target === "read" && item.kind === "read");
      if (!platform && value && !ceiling.includes(item.key) && !column.owner) return;
      set(column, item.key, value);
    });
  }

  const changes = Object.keys(draft).length + Object.keys(displayDraft).length;
  const dirty = changes > 0;

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    const critical = Object.keys(displayDraft).length > 0 || Object.keys(draft).some((cell) => cell.endsWith("|roles.manage"))
      || columns.some((column) => column.owner && Object.keys(draft).some((cell) => cell.startsWith(`${mode}|${column.id}|`))) || changes > 15;
    if (critical && !(await confirmWithPassword(`Vous enregistrez ${changes} modification(s) de droits, dont des changements importants.`))) return false;
    setSaving(true);
    const failures: string[] = [];
    for (const [cell, value] of Object.entries(draft)) {
      const [cellMode, id, key] = cell.split("|");
      try {
        if (cellMode === "roles") await setRolePermission(id, key, value);
        else await setMemberPermission(id, key, value);
      } catch (cause) {
        failures.push(`${functions.find((item) => item.key === key)?.label ?? key} : ${errorMessage(cause, "refusé")}`);
      }
    }
    for (const [key, value] of Object.entries(displayDraft)) {
      try { await setFeatureDisplay(orgId ?? null, key, value); } catch (cause) { failures.push(`${key} : ${errorMessage(cause, "refusé")}`); }
    }
    setDraft({});
    setDisplayDraft({});
    await onChanged();
    await load();
    setSaving(false);
    if (failures.length) notify("Droits", `${changes - failures.length} modification(s) enregistrée(s), ${failures.length} refusée(s) :\n${failures.slice(0, 6).join("\n")}`);
    else notify("Droits", `${changes} modification(s) enregistrée(s).`);
    return failures.length === 0;
  }
  function discard() { setDraft({}); setDisplayDraft({}); }
  useUnsavedChanges(dirty, save, discard, `${changes} modification(s) de droits ne sont pas encore enregistrées.`);

  // ---- Export ----
  const header = () => ["Domaine", "Fonction", "Clé", "Type", ...columns.map((column) => column.owner ? `${column.name} (plafond)` : column.name), ...(platform && mode === "roles" ? ["Si non autorisé"] : [])];
  const lines = () => functions.map((item) => [item.area, item.label, item.key, item.kind === "read" ? "Lecture" : "Modification",
    ...columns.map((column) => valueOf(column, item.key) ? "Oui" : "Non"), ...(platform && mode === "roles" ? [displayOf(item) === "locked" ? "Grisé" : "Caché"] : [])]);
  async function exportCsv() {
    await saveCsv(`droits-${mode === "roles" ? "roles" : "comptes"}-${side === "supplier" ? "fournisseur" : "acheteur"}.csv`, toCsv([header(), ...lines()]));
  }
  async function exportPdf() {
    const head = header().filter((title) => title !== "Clé");
    const body = lines().map((row) => row.filter((_, index) => index !== 2));
    let area = "";
    const rows = body.map((row) => {
      const title = row[0] !== area ? `<tr class="area"><td colspan="${head.length - 1}">${escapeHtml(row[0])}</td></tr>` : "";
      area = row[0];
      return `${title}<tr>${row.slice(1).map((value, index) => `<td class="${index === 0 ? "" : "c"}${value === "Oui" ? " yes" : value === "Non" ? " no" : ""}">${escapeHtml(value)}</td>`).join("")}</tr>`;
    }).join("");
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><style>
      body{font-family:Arial,sans-serif;color:#1d2939;font-size:10px;padding:16px} h1{font-size:16px;margin:0 0 4px} .muted{color:#667085}
      table{border-collapse:collapse;width:100%;margin-top:10px} th,td{border:1px solid #e2e6ec;padding:4px 5px} th{background:#eef1f5;font-size:9px}
      td.c{text-align:center} td.yes{color:#1d6b36;font-weight:bold} td.no{color:#a0a7b4} tr.area td{background:#f6f8fa;font-weight:bold;color:#1f3b63}
    </style></head><body><h1>Synthèse des droits · ${mode === "roles" ? "par rôle" : "par compte"} (${side === "supplier" ? "fournisseur" : "acheteur"})</h1>
      <div class="muted">${escapeHtml(matrix.org.name)} · ${new Date().toLocaleDateString("fr-FR")}</div>
      <table><tr>${head.slice(1).map((title) => `<th>${escapeHtml(title)}</th>`).join("")}</tr>${rows}</table></body></html>`;
    await outputPdf(html, `Droits-${matrix.org.name}`, `Synthèse des droits · ${matrix.org.name}`);
  }

  // ---- Import (full or partial file: only the rows and columns present are compared) ----
  async function importCsv() {
    const file = await pickCsvText();
    if (!file) return;
    const rows = parseCsv(file.text);
    const head = rows[0]?.map((title) => title.trim()) ?? [];
    const keyIndex = head.findIndex((title) => /^cl[ée]$/i.test(title));
    if (keyIndex < 0) { notify("Import", "Colonne « Clé » introuvable : partez d’un fichier exporté depuis cette matrice."); return; }
    const columnIndex = columns.map((column) => ({ column, index: head.findIndex((title) => title.replace(/\s*\(plafond\)$/i, "").trim().toLocaleLowerCase("fr") === column.name.toLocaleLowerCase("fr")) }))
      .filter((entry) => entry.index >= 0);
    const ignored: string[] = [];
    const found: NonNullable<typeof preview>["changes"] = [];
    const next: Record<string, boolean> = {};
    for (const row of rows.slice(1)) {
      const key = row[keyIndex]?.trim();
      const item = functions.find((entry) => entry.key === key);
      if (!item) { if (key) ignored.push(`${key} : fonction inconnue pour ce côté`); continue; }
      for (const { column, index } of columnIndex) {
        const text = row[index] ?? "";
        if (!yes(text) && !no(text)) continue;
        const target = yes(text);
        const now = valueOf(column, key);
        if (target === now) continue;
        if (!editable(column, key) || (!platform && target && !ceiling.includes(key) && !column.owner)) { ignored.push(`${column.name} · ${item.label} : hors de ce que vous pouvez régler`); continue; }
        next[cellKey(column, key)] = target;
        found.push({ cell: cellKey(column, key), column: column.name, label: item.label, from: now, to: target });
      }
    }
    if (!found.length) { notify("Import", ignored.length ? `Aucune modification applicable.\n${ignored.slice(0, 5).join("\n")}` : "Le fichier ne change rien."); return; }
    setPreview({ file: file.name, changes: found, ignored });
  }
  function acceptPreview() {
    if (!preview) return;
    const next = { ...draft };
    preview.changes.forEach((change) => {
      const [, id, key] = change.cell.split("|");
      const column = columns.find((item) => item.id === id);
      if (column && change.to === column.granted.includes(key)) delete next[change.cell]; else next[change.cell] = change.to;
    });
    setDraft(next);
    setPreview(null);
  }

  if (error) return <EmptyState title="Matrice indisponible" body={error} />;
  if (!catalogue) return <Loading />;

  const stateLabel = { none: "—", read: "Lire", write: "Modifier", partial: "Partiel" } as const;
  return <View style={{ flex: 1 }}>
    <View style={[ui.wrapRow, styles.bar]}>
      <Chip label="Par rôle" selected={mode === "roles"} onPress={() => setMode("roles")} />
      <Chip label={`Par compte (${(members ?? []).filter((member) => member.side === side).length})`} selected={mode === "accounts"} onPress={() => setMode("accounts")} />
      {sides.length > 1 ? sides.map((item) => <Chip key={item} label={item === "supplier" ? "Fournisseur" : "Acheteur"} selected={side === item} onPress={() => setSide(item)} />) : null}
      <View style={{ flex: 1 }} />
      <Button label="EXCEL (CSV)" variant="secondary" onPress={exportCsv} />
      <Button label="PDF" variant="secondary" onPress={exportPdf} />
      {matrix.can_edit ? <Button label="IMPORTER" variant="secondary" onPress={importCsv} /> : null}
    </View>
    <Text style={[ui.small, { paddingHorizontal: 14 }]}>
      {mode === "roles" ? "Touchez une case pour donner ou retirer une fonction ; la ligne d’un domaine passe de « — » à « Lire » puis « Modifier »." : "Exceptions par personne, en plus de ses rôles."}
      {platform ? " La colonne « Si non autorisé » choisit ce que voit un compte sans la fonction : cachée ou grisée." : ` Plafond : ce qu’Appro+ a ouvert à votre espace (${ceiling.length} fonctions).`}
    </Text>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: dirty ? 90 : 20 }}>
      <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 14 }}>
        <View>
          <View style={[styles.row, styles.headRow]}>
            <Text style={[styles.labelCell, styles.headText]}>Fonction</Text>
            {columns.map((column) => <Text key={column.id} style={[styles.cell, styles.headText]} numberOfLines={2}>{column.owner ? `${column.name}\n(plafond)` : column.name}</Text>)}
            {platform && mode === "roles" ? <Text style={[styles.displayCell, styles.headText]}>Si non autorisé</Text> : null}
          </View>
          {areas.map((area) => {
            const items = functions.filter((item) => item.area === area);
            const open = openAreas.includes(area);
            return <View key={area}>
              <View style={[styles.row, styles.areaRow]}>
                <Pressable style={styles.labelCell} onPress={() => setOpenAreas((current) => current.includes(area) ? current.filter((item) => item !== area) : [...current, area])}>
                  <Text style={styles.areaText}>{open ? "▾" : "▸"} {area} <Text style={ui.small}>({items.length})</Text></Text>
                </Pressable>
                {columns.map((column) => {
                  const state = areaState(column, area);
                  return <Pressable key={column.id} style={[styles.cell, styles[state]]} onPress={() => cycleArea(column, area)} disabled={!matrix.can_edit || (column.owner && !platform)}>
                    <Text style={[styles.stateText, state === "write" && { color: colors.white }]}>{stateLabel[state]}</Text>
                  </Pressable>;
                })}
                {platform && mode === "roles" ? <View style={styles.displayCell} /> : null}
              </View>
              {open ? items.map((item) => <View key={item.key} style={styles.row}>
                <View style={styles.labelCell}>
                  <Text style={ui.body} numberOfLines={2}>{item.label}</Text>
                  <Text style={styles.kind}>{item.kind === "read" ? "Lecture" : "Modification"}</Text>
                </View>
                {columns.map((column) => {
                  const on = valueOf(column, item.key);
                  const changed = cellKey(column, item.key) in draft;
                  const can = editable(column, item.key) && (platform || column.owner || on || ceiling.includes(item.key));
                  return <Pressable key={column.id} style={[styles.cell, changed && styles.changed]} disabled={!can} onPress={() => set(column, item.key, !on)}
                    accessibilityLabel={`${column.name} · ${item.label} : ${on ? "oui" : "non"}`}>
                    <Ionicons name={on ? "checkmark-circle" : can ? "ellipse-outline" : "lock-closed-outline"} size={18} color={on ? colors.primary : can ? colors.muted : colors.line} />
                  </Pressable>;
                })}
                {platform && mode === "roles" ? <Pressable style={[styles.displayCell, item.key in displayDraft && styles.changed]}
                  onPress={() => setDisplayDraft((current) => ({ ...current, [item.key]: displayOf(item) === "locked" ? "hidden" : "locked" }))}>
                  <Text style={[ui.small, { color: displayOf(item) === "locked" ? colors.amber : colors.muted, fontWeight: "800" }]}>{displayOf(item) === "locked" ? "Grisé" : "Caché"}</Text>
                </Pressable> : null}
              </View>) : null}
            </View>;
          })}
        </View>
      </ScrollView>
    </ScrollView>
    {dirty ? <View style={styles.saveBar}>
      <Text style={[ui.body, { flex: 1 }]}>{changes} modification(s) en attente</Text>
      <Button label="ANNULER" variant="secondary" onPress={discard} disabled={saving} />
      <Button label="ENREGISTRER" onPress={() => void save()} busy={saving} />
    </View> : null}
    <Modal visible={preview !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPreview(null)}>
      <SafeAreaView style={ui.modalSafe}>
        <ScreenHeader eyebrow="IMPORT · APERÇU" title={preview?.file ?? ""} subtitle={`${preview?.changes.length ?? 0} changement(s) : rien n’est enregistré avant votre validation.`} right={<CloseButton onPress={() => setPreview(null)} />} />
        <ScrollView contentContainerStyle={ui.content}>
          {preview?.changes.map((change, index) => <View key={index} style={[ui.row, styles.previewRow]}>
            <Text style={[ui.body, { flex: 1 }]}>{change.column} · {change.label}</Text>
            <Text style={[ui.small, { color: change.to ? colors.primary : colors.danger, fontWeight: "800" }]}>{change.from ? "Oui" : "Non"} → {change.to ? "Oui" : "Non"}</Text>
          </View>)}
          {preview?.ignored.length ? <View style={{ marginTop: 12 }}>
            <Text style={ui.fieldLabel}>Lignes ignorées</Text>
            {preview.ignored.slice(0, 30).map((line, index) => <Text key={index} style={ui.small}>{line}</Text>)}
          </View> : null}
          <Button label="REPRENDRE CES CHANGEMENTS" onPress={acceptPreview} style={{ marginTop: 14 }} />
          <Text style={[ui.small, { marginTop: 6 }]}>Ils s’ajoutent aux modifications en attente ; touchez ensuite « Enregistrer » (mot de passe demandé).</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 14, paddingVertical: 8, alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  headRow: { backgroundColor: colors.cream },
  headText: { color: colors.text, fontSize: 11, fontWeight: "800", textAlign: "center" },
  areaRow: { backgroundColor: "#f6f8fa" },
  areaText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  labelCell: { width: 230, paddingHorizontal: 8, paddingVertical: 8 },
  cell: { width: 92, minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderLeftWidth: 1, borderLeftColor: colors.line },
  displayCell: { width: 110, minHeight: 40, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderLeftColor: colors.line },
  kind: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  stateText: { fontSize: 11, fontWeight: "800", color: colors.text },
  none: {},
  read: { backgroundColor: "#dbe7f8" },
  write: { backgroundColor: colors.primary },
  partial: { backgroundColor: "#fbefc9" },
  changed: { backgroundColor: "#fff3cd" },
  saveBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  previewRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line },
});
