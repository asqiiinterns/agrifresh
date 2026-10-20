import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { applyDeposit, fetchAccounts, fetchStatement, lineLabel, netBalance, overLimit, recordDeposit, setCreditLimit, withBalance, type AccountFigures, type AccountSummary, type DepositMethod, type Statement } from "../data/accounts";
import { balanceOf, fetchInvoices, invoiceLabel, type InvoiceWithOrders } from "../data/invoices";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, formatDay, formatPrice, toDayKey } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { FilterBar } from "../ui/FilterBar";
import { fetchBuyerAccounts, type BuyerAccount } from "../data/buyer";

const MIGRATION_HINT = "La migration 20261114 est-elle exécutée ?";
const depositMethods: { key: DepositMethod; label: string }[] = [
  { key: "cash", label: "Espèces" },
  { key: "transfer", label: "Virement" },
  { key: "check", label: "Chèque" },
  { key: "card", label: "Carte" },
  { key: "other", label: "Autre" },
];

// The three figures of an account, the same on both sides.
function FiguresCard({ figures, clientSide }: { figures: AccountFigures; clientSide?: boolean }) {
  const net = netBalance(figures);
  return <View style={ui.card}>
    <View style={ui.row}>
      <Text style={[ui.body, { flex: 1 }]}>Factures à régler</Text>
      <Text style={[ui.body, { fontWeight: "800" }]}>{formatPrice(figures.outstanding)}</Text>
    </View>
    <View style={ui.row}>
      <Text style={[ui.body, { flex: 1 }]}>Acompte disponible</Text>
      <Text style={[ui.body, { fontWeight: "800", color: Number(figures.deposits) > 0 ? colors.primary : colors.text }]}>{formatPrice(figures.deposits)}</Text>
    </View>
    <View style={[ui.row, ui.divider]}>
      <Text style={[ui.strong, { flex: 1 }]}>{net > 0.0005 ? "Solde dû" : net < -0.0005 ? "Solde en faveur du client" : "Compte soldé"}</Text>
      <Text style={[ui.amount, { color: net > 0.0005 ? colors.danger : colors.primary }]}>{formatPrice(Math.abs(net))}</Text>
    </View>
    <Text style={[ui.small, { marginTop: 6 }]}>
      {figures.credit_limit === null ? "Encours autorisé : sans limite" : `Encours autorisé : ${formatPrice(figures.credit_limit)}`}
    </Text>
    {overLimit(figures) ? <Text style={[ui.error, { marginTop: 6 }]}>
      {clientSide ? "Encours atteint : réglez vos factures pour pouvoir commander à nouveau." : "Encours atteint : le client ne peut plus commander avant un règlement."}
    </Text> : null}
  </View>;
}

// Statement: every movement with a running balance, the most recent first.
function StatementCard({ statement }: { statement: Statement }) {
  const lines = withBalance(statement.lines).reverse();
  return <View style={ui.card}>
    <Text style={ui.strong}>Relevé de compte</Text>
    {lines.length === 0 ? <Text style={[ui.small, { marginTop: 6 }]}>Aucun mouvement pour le moment.</Text> : null}
    {lines.map((line) => <View key={line.sort} style={[ui.row, ui.divider]}>
      <View style={{ flex: 1 }}>
        <Text style={ui.body}>{lineLabel(line)}</Text>
        <Text style={ui.small}>{formatDay(line.date, { day: "numeric", month: "short", year: "numeric" })}{line.kind === "deposit_use" && line.info ? ` · ${formatPrice(line.info)}` : ""}</Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        {Number(line.debit) > 0 ? <Text style={[ui.body, { fontWeight: "800", color: colors.danger }]}>{`+ ${formatPrice(line.debit)}`}</Text> : null}
        {Number(line.credit) > 0 ? <Text style={[ui.body, { fontWeight: "800", color: colors.primary }]}>{`− ${formatPrice(line.credit)}`}</Text> : null}
        <Text style={ui.small}>{`Solde ${formatPrice(line.balance)}`}</Text>
      </View>
    </View>)}
  </View>;
}

// Supplier side: one card per client account.
export function AccountsList() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setAccounts(await fetchAccounts());
    } catch (cause) {
      setError(errorMessage(cause, `Impossible de charger les comptes clients. ${MIGRATION_HINT}`));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return accounts.filter((account) => !needle || account.business_name.toLowerCase().includes(needle));
  }, [accounts, search]);
  const totalDeposits = accounts.reduce((sum, account) => sum + Number(account.deposits), 0);

  return <View style={{ flex: 1 }}>
    <FilterBar search={search} onSearch={setSearch} placeholder="Client" filters={[]} />
    {totalDeposits > 0 ? <Text style={[ui.small, { paddingHorizontal: 14, marginTop: 6, color: colors.text, fontWeight: "800" }]}>{`Acomptes détenus : ${formatPrice(totalDeposits)}`}</Text> : null}
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(account) => account.client_id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun compte client" body="Les comptes apparaissent dès qu’un client est en relation avec vous." />}
      renderItem={({ item }) => {
        const net = netBalance(item);
        return <Pressable onPress={() => setOpenId(item.client_id)} style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
            <Text style={[ui.amount, { color: net > 0.0005 ? colors.danger : colors.primary }]}>{formatPrice(Math.abs(net))}</Text>
          </View>
          <Text style={ui.small}>{item.credit_limit === null
            ? `À régler ${formatPrice(item.outstanding)} · acompte ${formatPrice(item.deposits)}`
            : `À régler ${formatPrice(item.outstanding)} · acompte ${formatPrice(item.deposits)} · encours autorisé ${formatPrice(item.credit_limit)}`}</Text>
          {overLimit(item) ? <Text style={[ui.small, { color: colors.danger, fontWeight: "800" }]}>Encours atteint</Text> : null}
        </Pressable>;
      }}
    />}
    <AccountModal clientId={openId} onClose={() => setOpenId(null)} onChanged={() => void reload()} />
  </View>;
}

function AccountModal({ clientId, onClose, onChanged }: { clientId: string | null; onClose: () => void; onChanged: () => void }) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithOrders[]>([]);
  const [error, setError] = useState("");

  async function load(id: string) {
    setError("");
    try {
      const [next, all] = await Promise.all([fetchStatement(id), fetchInvoices().catch(() => [] as InvoiceWithOrders[])]);
      setStatement(next);
      setInvoices(all.filter((invoice) => invoice.client_id === id && invoice.status === "issued" && balanceOf(invoice) > 0.0005));
    } catch (cause) {
      setError(errorMessage(cause, `Impossible de charger ce compte. ${MIGRATION_HINT}`));
    }
  }
  useEffect(() => {
    setStatement(null);
    if (clientId) void load(clientId);
  }, [clientId]);

  function changed() {
    if (clientId) void load(clientId);
    onChanged();
  }

  return <Modal visible={clientId !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.screen}>
      <View style={[ui.row, { padding: 14 }]}>
        <View style={{ flex: 1 }}>
          <Text style={ui.small}>COMPTE CLIENT</Text>
          <Text style={ui.title}>{statement?.business_name ?? ""}</Text>
        </View>
        <CloseButton onPress={onClose} />
      </View>
      {error ? <Text style={[ui.error, { marginHorizontal: 14 }]}>{error}</Text> : null}
      {!statement ? (error ? null : <Loading />) : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <FiguresCard figures={statement.figures} />
        <DepositCard clientId={statement.client_id} available={Number(statement.figures.deposits)} onChanged={changed} />
        {Number(statement.figures.deposits) > 0.0005 && invoices.length ? <ApplyCard invoices={invoices} available={Number(statement.figures.deposits)} onChanged={changed} /> : null}
        <LimitCard clientId={statement.client_id} limit={statement.figures.credit_limit} onChanged={changed} />
        <StatementCard statement={statement} />
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

// Records money received in advance, or paid back.
function DepositCard({ clientId, available, onChanged }: { clientId: string; available: number; onChanged: () => void }) {
  const [kind, setKind] = useState<"deposit" | "refund" | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DepositMethod>("cash");
  const [date, setDate] = useState(toDayKey(new Date()));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function start(next: "deposit" | "refund") {
    setKind(next);
    setAmount(next === "refund" ? available.toFixed(3) : "");
    setReference("");
    setNote("");
    setError("");
  }

  async function save() {
    const value = Number(amount.replace(",", "."));
    if (!kind) return;
    if (!value || value <= 0) {
      setError("Indiquez un montant positif.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await recordDeposit(clientId, kind, value, method, date, reference, note);
      setKind(null);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "L’acompte n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Acomptes</Text>
    <Text style={ui.small}>Argent reçu d’avance : il reste au crédit du client jusqu’à ce que vous l’imputiez sur une facture ou le remboursiez.</Text>
    {!kind ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
      <Button label="+ ACOMPTE REÇU" onPress={() => start("deposit")} />
      {available > 0.0005 ? <Button label="REMBOURSER" variant="secondary" onPress={() => start("refund")} /> : null}
    </View> : <View style={ui.divider}>
      <Text style={ui.fieldLabel}>{kind === "deposit" ? "Acompte reçu" : `Remboursement (disponible ${formatPrice(available)})`}</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        {depositMethods.map((item) => <Chip key={item.key} label={item.label} selected={method === item.key} onPress={() => setMethod(item.key)} />)}
      </View>
      <View style={ui.row}>
        <View style={{ flex: 1 }}><Field label="Montant (TND)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Field label="Date (AAAA-MM-JJ)" value={date} onChangeText={setDate} /></View>
      </View>
      <Field label="Référence (reçu, chèque, virement…)" value={reference} onChangeText={setReference} />
      <Field label="Note" value={note} onChangeText={setNote} />
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        <Button label="ENREGISTRER" onPress={() => save()} busy={busy} />
        <Button label="ANNULER" variant="secondary" onPress={() => setKind(null)} disabled={busy} />
      </View>
    </View>}
  </View>;
}

// Uses the available deposit to pay all or part of an open invoice.
function ApplyCard({ invoices, available, onChanged }: { invoices: InvoiceWithOrders[]; available: number; onChanged: () => void }) {
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function choose(invoice: InvoiceWithOrders) {
    setInvoiceId(invoice.id);
    setAmount(Math.min(available, balanceOf(invoice)).toFixed(3));
    setError("");
  }

  async function save() {
    const value = Number(amount.replace(",", "."));
    if (!invoiceId) return;
    if (!value || value <= 0) {
      setError("Indiquez un montant positif.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await applyDeposit(invoiceId, value);
      setInvoiceId(null);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "L’acompte n’a pas pu être imputé."));
    } finally {
      setBusy(false);
    }
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Imputer l’acompte sur une facture</Text>
    <View style={[ui.wrapRow, { marginTop: 8 }]}>
      {invoices.map((invoice) => <Chip key={invoice.id} label={`${invoiceLabel(invoice)} · reste ${formatPrice(balanceOf(invoice))}`} selected={invoiceId === invoice.id} onPress={() => choose(invoice)} />)}
    </View>
    {invoiceId ? <>
      <Field label="Montant imputé (TND)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        <Button label="IMPUTER" onPress={() => save()} busy={busy} />
        <Button label="ANNULER" variant="secondary" onPress={() => setInvoiceId(null)} disabled={busy} />
      </View>
    </> : null}
  </View>;
}

// Outstanding limit: past it, the client can no longer order by itself.
function LimitCard({ clientId, limit, onChanged }: { clientId: string; limit: number | null; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(next: number | null) {
    setBusy(true);
    setError("");
    try {
      await setCreditLimit(clientId, next);
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "L’encours autorisé n’a pas pu être modifié."));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const parsed = Number(value.replace(",", "."));
    if (value.trim() === "" || Number.isNaN(parsed) || parsed < 0) {
      setError("Indiquez un montant (0 = paiement avant commande).");
      return;
    }
    void save(parsed);
  }

  return <View style={ui.card}>
    <View style={ui.row}>
      <Text style={[ui.strong, { flex: 1 }]}>Encours autorisé</Text>
      <Text style={[ui.body, { fontWeight: "800" }]}>{limit === null ? "Sans limite" : formatPrice(limit)}</Text>
    </View>
    <Text style={ui.small}>Au-delà, le client ne peut plus passer commande lui-même ; vous pouvez toujours commander pour lui.</Text>
    {!editing ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
      <Button label="MODIFIER" variant="secondary" onPress={() => { setValue(limit === null ? "" : String(limit)); setError(""); setEditing(true); }} />
      {limit !== null ? <Button label="SANS LIMITE" variant="secondary" onPress={() => save(null)} busy={busy} /> : null}
    </View> : <>
      <Field label="Montant (TND)" value={value} onChangeText={setValue} keyboardType="decimal-pad" />
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        <Button label="ENREGISTRER" onPress={() => submit()} busy={busy} />
        <Button label="ANNULER" variant="secondary" onPress={() => setEditing(false)} disabled={busy} />
      </View>
    </>}
    {!editing && error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
  </View>;
}

// Client side: my account with each of my suppliers (one at a time, chosen above the statement).
export function ClientAccountSheet() {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [accounts, setAccounts] = useState<BuyerAccount[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function reload(refresh = false, clientId = chosen) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      const list = await fetchBuyerAccounts() ?? [];
      setAccounts(list);
      const target = clientId ?? list.find((account) => account.current)?.client_id ?? list[0]?.client_id ?? null;
      setChosen(target);
      setStatement(await fetchStatement(target ?? undefined));
    } catch (cause) {
      setError(errorMessage(cause, `Impossible de charger votre compte. ${MIGRATION_HINT}`));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  if (loading) return <Loading />;
  return <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}>
    {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
    {accounts.length > 1 ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
      {accounts.map((account) => <Chip key={account.client_id} label={account.supplier_name} selected={chosen === account.client_id} onPress={() => { setChosen(account.client_id); void reload(false, account.client_id); }} />)}
    </View> : null}
    {statement ? <>
      {statement.supplier_name ? <Text style={[ui.small, { marginTop: 8 }]}>{`Votre compte chez ${statement.supplier_name}`}</Text> : null}
      <FiguresCard figures={statement.figures} clientSide />
      <StatementCard statement={statement} />
    </> : null}
  </ScrollView>;
}
