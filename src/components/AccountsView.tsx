import React, { useState } from 'react';
import { Check, Download, Pencil, Plus, Trash2, X } from 'lucide-react';
import { AccountBalanceInfo, AccountBalancesData, CardEmi, SavingsTransfer, Transaction } from '../types';
import { formatDate, formatMoney, getCurrentIstDate } from '../utils/formatters';
import { exportAccountStatementExcel, exportAllAccountsStatementExcel } from '../utils/statementExport';

interface EditAccountPayload {
  name: string;
  shortName: string;
  type: 'credit_card' | 'rupay_card' | 'bank_account' | 'cash';
  creditLimit?: number;
  baseBalance?: number;
  billingDay?: number;
  paymentDueDay?: number;
  resetTimestamp?: boolean;
}

interface SettleCardPayload {
  amount: number;
  fromAccount: string;
  date: string;
  note?: string;
}

interface AccountsViewProps {
  balances: AccountBalancesData | null;
  transactions: Transaction[];
  emis: CardEmi[];
  savingsTransfers: SavingsTransfer[];
  isPrivacyMode: boolean;
  onUpdateBaseBalance: (accountId: string, balance: number) => Promise<void>;
  onUpdateCardLimit: (cardId: string, limit: number) => Promise<void>;
  onAddCustomAccount: (payload: { name: string; shortName: string; type: string; creditLimit?: number }) => Promise<void>;
  onUpdateAccount: (accountId: string, payload: EditAccountPayload) => Promise<void>;
  onSettleCardDue: (cardId: string, payload: SettleCardPayload) => Promise<void>;
  onDeleteCustomAccount: (id: string) => Promise<void>;
  onAddEmi: (payload: Partial<CardEmi>) => Promise<void>;
  onUpdateEmi: (id: string, patch: Partial<CardEmi>) => Promise<void>;
  onDeleteEmi: (id: string) => Promise<void>;
  onAddSavingsTransfer: (payload: Partial<SavingsTransfer>) => Promise<void>;
  onDeleteSavingsTransfer: (id: string) => Promise<void>;
  onUpdateWifeBase: (balance: number) => Promise<void>;
}

export const AccountsView: React.FC<AccountsViewProps> = ({
  balances,
  transactions,
  emis,
  savingsTransfers,
  isPrivacyMode,
  onUpdateBaseBalance,
  onUpdateCardLimit,
  onAddCustomAccount,
  onUpdateAccount,
  onSettleCardDue,
  onDeleteCustomAccount,
  onAddEmi,
  onUpdateEmi,
  onDeleteEmi,
  onAddSavingsTransfer,
  onDeleteSavingsTransfer,
  onUpdateWifeBase,
}) => {
  const [editingBalanceId, setEditingBalanceId] = useState<string | null>(null);
  const [balanceDraft, setBalanceDraft] = useState('');
  const [editingLimitId, setEditingLimitId] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState('');

  // Edit Credit Card Modal State
  const [editingCard, setEditingCard] = useState<AccountBalanceInfo | null>(null);
  const [editShortName, setEditShortName] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editCardType, setEditCardType] = useState<'credit_card' | 'rupay_card'>('credit_card');
  const [editCreditLimit, setEditCreditLimit] = useState('');
  const [editBaseBalance, setEditBaseBalance] = useState('');
  const [editBillingDay, setEditBillingDay] = useState('');
  const [editDueDay, setEditDueDay] = useState('');
  const [editResetTimestamp, setEditResetTimestamp] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [editCardError, setEditCardError] = useState('');

  // Settle Credit Card Due Modal State (Partial / Full)
  const [settlingCard, setSettlingCard] = useState<AccountBalanceInfo | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleFromAccount, setSettleFromAccount] = useState('AX Bank');
  const [settleDate, setSettleDate] = useState(getCurrentIstDate());
  const [settleNote, setSettleNote] = useState('');
  const [isSettlingCard, setIsSettlingCard] = useState(false);
  const [settleCardError, setSettleCardError] = useState('');

  // Custom Account Form
  const [showNewAcc, setShowNewAcc] = useState(false);
  const [newAccName, setNewAccName] = useState('');
  const [newAccType, setNewAccType] = useState<'bank_account' | 'credit_card' | 'cash'>('bank_account');
  const [newAccLimit, setNewAccLimit] = useState('');

  // EMI Form
  const [emiTitle, setEmiTitle] = useState('');
  const [emiCard, setEmiCard] = useState('ICICI CC 0000');
  const [emiAmount, setEmiAmount] = useState('');
  const [emiMonths, setEmiMonths] = useState('6');

  // Family Savings Form
  const [transferAmount, setTransferAmount] = useState('');
  const [transferFrom, setTransferFrom] = useState('AX Bank');
  const [transferNotes, setTransferNotes] = useState('');

  const accountList: AccountBalanceInfo[] = balances ? (Object.values(balances.accounts) as AccountBalanceInfo[]) : [];
  const bankAndCash = accountList.filter((a) => a.type === 'bank_account' || a.type === 'cash');
  const creditCards = accountList.filter((a) => a.type === 'credit_card' || a.type === 'rupay_card');

  return (
    <div className="space-y-8">
      {/* Bank & Cash Liquidity */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Bank Accounts &amp; Cash</h2>
            <p className="text-xs text-slate-400">
              Combined Liquidity: <span className="font-mono tabular-nums text-sky-400 font-semibold">{formatMoney(balances?.totalBankCashBalance || 0, isPrivacyMode)}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => exportAllAccountsStatementExcel(balances, transactions, emis, savingsTransfers)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>All Accounts Statement (.xlsx)</span>
            </button>
            <button
              type="button"
              onClick={() => setShowNewAcc((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#111827] border border-white/[0.08] hover:border-white/20 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Account</span>
            </button>
          </div>
        </div>

        {showNewAcc && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newAccName.trim()) return;
              await onAddCustomAccount({
                name: newAccName.trim(),
                shortName: newAccName.trim(),
                type: newAccType,
                creditLimit: newAccType === 'credit_card' ? Number(newAccLimit || 100000) : undefined,
              });
              setNewAccName('');
              setNewAccLimit('');
              setShowNewAcc(false);
            }}
            className="surface-panel rounded-xl p-4 flex flex-wrap items-end gap-3"
          >
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs text-slate-400 mb-1">Account / Card Label</label>
              <input
                type="text"
                required
                value={newAccName}
                onChange={(e) => setNewAccName(e.target.value)}
                placeholder="e.g. HDFC Savings or HDFC CC 4412"
                className="w-full px-3 py-2 text-sm rounded-lg field-input"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Type</label>
              <select
                value={newAccType}
                onChange={(e) => setNewAccType(e.target.value as any)}
                className="px-3 py-2 text-sm rounded-lg field-input"
              >
                <option value="bank_account" className="bg-[#111827]">Bank Account</option>
                <option value="credit_card" className="bg-[#111827]">Credit Card</option>
                <option value="cash" className="bg-[#111827]">Cash Wallet</option>
              </select>
            </div>
            {newAccType === 'credit_card' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">Credit Limit (₹)</label>
                <input
                  type="number"
                  value={newAccLimit}
                  onChange={(e) => setNewAccLimit(e.target.value)}
                  placeholder="100000"
                  className="w-32 px-3 py-2 text-sm font-mono rounded-lg field-input"
                />
              </div>
            )}
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
            >
              Save Account
            </button>
          </form>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {bankAndCash.map((acc) => {
            const isRemovableCustom = acc.isDefault === false;
            return (
              <div key={acc.accountId} className="surface-panel rounded-xl p-5 space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-white">{acc.shortName}</div>
                    <div className="text-xs text-slate-400">{acc.name}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => exportAccountStatementExcel(acc.accountId, transactions)}
                      title="Download Excel statement"
                      className="p-1.5 text-slate-400 hover:text-white rounded-md"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    {isRemovableCustom && (
                      <button
                        type="button"
                        onClick={() => onDeleteCustomAccount(acc.accountId)}
                        title="Remove custom account"
                        className="p-1.5 text-slate-400 hover:text-rose-400 rounded-md"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-2xl font-bold font-mono tabular-nums text-white">
                  {formatMoney(acc.currentBalance, isPrivacyMode)}
                </div>

                <div className="text-xs text-slate-400 flex items-center justify-between pt-3 border-t border-white/[0.08]">
                  <span>
                    In {formatMoney(acc.credits, isPrivacyMode)} · Out {formatMoney(acc.debits, isPrivacyMode)}
                  </span>
                  {editingBalanceId === acc.accountId ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await onUpdateBaseBalance(acc.accountId, Number(balanceDraft || 0));
                        setEditingBalanceId(null);
                      }}
                      className="flex items-center gap-1"
                    >
                      <input
                        type="number"
                        value={balanceDraft}
                        onChange={(e) => setBalanceDraft(e.target.value)}
                        className="w-24 px-2 py-1 text-xs font-mono rounded field-input"
                        autoFocus
                      />
                      <button type="submit" className="p-1 text-emerald-400">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingBalanceId(acc.accountId);
                        setBalanceDraft(String(acc.baseBalance || 0));
                      }}
                      className="text-sky-400 hover:text-sky-300 font-medium"
                    >
                      Set Base
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Credit Cards Utilization */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Credit Cards</h2>
            <p className="text-xs text-slate-400">
              Total Outstanding: <span className="font-mono tabular-nums text-rose-400">{formatMoney(balances?.totalCardOutstanding || 0, isPrivacyMode)}</span>
              <span className="mx-2">·</span>
              Available Limit: <span className="font-mono tabular-nums text-emerald-400">{formatMoney(balances?.totalCardAvailableLimit || 0, isPrivacyMode)}</span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {creditCards.map((card) => {
            const limit = card.creditLimit || 100000;
            const out = card.currentOutstanding || 0;
            const pct = Math.min(100, Math.round((out / limit) * 100));
            const isRemovableCustomCard = card.isDefault === false;
            return (
              <div key={card.accountId} className="surface-panel rounded-xl p-5 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{card.shortName}</div>
                    <div className="text-xs text-slate-400 truncate">{card.name}</div>
                    {(card.billingDay || card.paymentDueDay) && (
                      <div className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                        {card.type === 'rupay_card' ? 'RuPay UPI CC' : 'Credit Card'}
                        {card.billingDay ? ` · Bill Day ${card.billingDay}` : ''}
                        {card.paymentDueDay ? ` · Due Day ${card.paymentDueDay}` : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setSettlingCard(card);
                        setSettleAmount(out > 0 ? String(Number(out.toFixed(2))) : '');
                        setSettleFromAccount(bankAndCash[0]?.accountId || 'AX Bank');
                        setSettleDate(getCurrentIstDate());
                        setSettleNote('');
                        setSettleCardError('');
                      }}
                      title="Settle credit card due (partial or full)"
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        out > 0
                          ? 'text-slate-950 bg-emerald-400 hover:bg-emerald-300'
                          : 'text-slate-300 hover:text-white bg-[#0B0F17] border border-white/[0.08] hover:border-white/20'
                      }`}
                    >
                      <Check className="w-3 h-3" />
                      <span>Settle Due</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCard(card);
                        setEditShortName(card.shortName || card.accountId);
                        setEditFullName(card.name || card.shortName || card.accountId);
                        setEditCardType(card.type === 'rupay_card' ? 'rupay_card' : 'credit_card');
                        setEditCreditLimit(String(limit));
                        setEditBaseBalance(String(card.baseBalance || 0));
                        setEditBillingDay(card.billingDay ? String(card.billingDay) : '');
                        setEditDueDay(card.paymentDueDay ? String(card.paymentDueDay) : '');
                        setEditResetTimestamp(false);
                        setEditCardError('');
                      }}
                      title="Edit credit card"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-300 hover:text-white bg-[#0B0F17] border border-white/[0.08] hover:border-white/20 rounded-md whitespace-nowrap"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => exportAccountStatementExcel(card.accountId, transactions)}
                      title="Download card statement"
                      className="p-1.5 text-slate-400 hover:text-white rounded-md"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    {isRemovableCustomCard && (
                      <button
                        type="button"
                        onClick={() => onDeleteCustomAccount(card.accountId)}
                        title="Remove custom credit card"
                        className="p-1.5 text-slate-400 hover:text-rose-400 rounded-md"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="text-xs text-slate-400">Outstanding</div>
                    <div className="text-xl font-bold font-mono tabular-nums text-rose-400">
                      {formatMoney(out, isPrivacyMode)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-400">Available</div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-emerald-400">
                      {formatMoney(card.availableLimit ?? limit, isPrivacyMode)}
                    </div>
                  </div>
                </div>

                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${pct >= 80 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-500' : 'bg-sky-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
                  <span>{pct}% utilized</span>
                  {editingLimitId === card.accountId ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await onUpdateCardLimit(card.accountId, Number(limitDraft || limit));
                        setEditingLimitId(null);
                      }}
                      className="flex items-center gap-1"
                    >
                      <input
                        type="number"
                        value={limitDraft}
                        onChange={(e) => setLimitDraft(e.target.value)}
                        className="w-24 px-2 py-0.5 text-xs font-mono rounded field-input"
                        autoFocus
                      />
                      <button type="submit" className="text-emerald-400">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingLimitId(card.accountId);
                        setLimitDraft(String(limit));
                      }}
                      className="text-sky-400 hover:text-sky-300"
                    >
                      Limit: {formatMoney(limit, isPrivacyMode)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Card EMIs & Family Savings Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="surface-panel rounded-xl p-5 space-y-4">
          <h3 className="font-display text-base font-semibold text-white">Active Credit Card EMIs</h3>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!emiTitle.trim() || !emiAmount) return;
              await onAddEmi({
                title: emiTitle.trim(),
                cardId: emiCard,
                monthlyAmount: Number(emiAmount),
                totalMonths: Number(emiMonths || 6),
                paidMonths: 0,
              });
              setEmiTitle('');
              setEmiAmount('');
            }}
            className="grid grid-cols-1 sm:grid-cols-4 gap-2"
          >
            <input
              type="text"
              placeholder="EMI Title"
              value={emiTitle}
              onChange={(e) => setEmiTitle(e.target.value)}
              className="sm:col-span-2 px-3 py-2 text-xs rounded-lg field-input"
            />
            <input
              type="number"
              placeholder="₹ / mo"
              value={emiAmount}
              onChange={(e) => setEmiAmount(e.target.value)}
              className="px-3 py-2 text-xs font-mono rounded-lg field-input"
            />
            <button
              type="submit"
              className="px-3 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
            >
              Add EMI
            </button>
            <select
              value={emiCard}
              onChange={(e) => setEmiCard(e.target.value)}
              className="sm:col-span-2 px-3 py-2 text-xs rounded-lg field-input"
            >
              {creditCards.map((c) => (
                <option key={c.accountId} value={c.accountId} className="bg-[#111827]">
                  {c.shortName}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="1"
              placeholder="Months"
              value={emiMonths}
              onChange={(e) => setEmiMonths(e.target.value)}
              className="sm:col-span-2 px-3 py-2 text-xs font-mono rounded-lg field-input"
            />
          </form>

          {emis.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">No active card EMIs tracked.</p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {emis.map((emi) => (
                <div key={emi.id} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">{emi.title}</div>
                    <div className="text-xs text-slate-400">
                      {emi.cardId} · {emi.paidMonths}/{emi.totalMonths} months ·{' '}
                      <span className="font-mono tabular-nums">{formatMoney(emi.monthlyAmount, isPrivacyMode)}/mo</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {emi.paidMonths < emi.totalMonths && (
                      <button
                        type="button"
                        onClick={() => onUpdateEmi(emi.id, { paidMonths: emi.paidMonths + 1 })}
                        className="px-2.5 py-1 text-xs font-medium text-emerald-300 bg-emerald-500/15 rounded-md hover:bg-emerald-500/25"
                      >
                        +1 Paid
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteEmi(emi.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="surface-panel rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-semibold text-white">Family / Wife Savings</h3>
              <p className="text-xs text-slate-400">
                Accumulated Balance:{' '}
                <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                  {formatMoney(balances?.wifeSavings?.currentBalance || 0, isPrivacyMode)}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = window.prompt('Set opening family savings base balance (₹):', String(balances?.wifeBaseBalance || 0));
                if (next !== null && !Number.isNaN(Number(next))) {
                  onUpdateWifeBase(Number(next));
                }
              }}
              className="text-xs text-sky-400 hover:text-sky-300 font-medium"
            >
              Set Opening
            </button>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!transferAmount) return;
              await onAddSavingsTransfer({
                amount: Number(transferAmount),
                fromAccount: transferFrom,
                notes: transferNotes.trim() || 'Monthly Family Savings Transfer',
                date: getCurrentIstDate(),
              });
              setTransferAmount('');
              setTransferNotes('');
            }}
            className="grid grid-cols-1 sm:grid-cols-3 gap-2"
          >
            <input
              type="number"
              placeholder="Amount ₹"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              className="px-3 py-2 text-xs font-mono rounded-lg field-input"
            />
            <select
              value={transferFrom}
              onChange={(e) => setTransferFrom(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg field-input"
            >
              {bankAndCash
                .filter((b) => b.accountId !== 'Wife')
                .map((b) => (
                  <option key={b.accountId} value={b.accountId} className="bg-[#111827]">
                    From {b.shortName}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="px-3 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
            >
              Transfer
            </button>
            <input
              type="text"
              placeholder="Note (optional)"
              value={transferNotes}
              onChange={(e) => setTransferNotes(e.target.value)}
              className="sm:col-span-3 px-3 py-2 text-xs rounded-lg field-input"
            />
          </form>

          {savingsTransfers.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">No transfers logged yet.</p>
          ) : (
            <div className="divide-y divide-white/[0.06] max-h-56 overflow-y-auto">
              {savingsTransfers.map((s) => (
                <div key={s.id} className="py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <div className="text-slate-200 font-medium">{s.notes || s.recipient}</div>
                    <div className="text-slate-500">
                      {formatDate(s.date)} · From {s.fromAccount}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                      {formatMoney(s.amount, isPrivacyMode)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeleteSavingsTransfer(s.id)}
                      className="p-1 text-slate-400 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Edit Credit Card Modal */}
      {editingCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
          <div className="surface-panel rounded-xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-white">Edit Credit Card</h3>
                <p className="text-xs text-slate-400 font-mono">{editingCard.accountId}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingCard(null)}
                aria-label="Close edit credit card modal"
                className="p-1.5 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editShortName.trim() || !editFullName.trim()) {
                  setEditCardError('Card label and full name are required.');
                  return;
                }
                setIsSavingCard(true);
                setEditCardError('');
                try {
                  await onUpdateAccount(editingCard.accountId, {
                    shortName: editShortName.trim(),
                    name: editFullName.trim(),
                    type: editCardType,
                    creditLimit: Math.max(0, Number(editCreditLimit || 0)),
                    baseBalance: Number(editBaseBalance || 0),
                    billingDay: editBillingDay ? Number(editBillingDay) : undefined,
                    paymentDueDay: editDueDay ? Number(editDueDay) : undefined,
                    resetTimestamp: editResetTimestamp,
                  });
                  setEditingCard(null);
                } catch (err: any) {
                  setEditCardError(err?.message || 'Failed to save credit card changes.');
                } finally {
                  setIsSavingCard(false);
                }
              }}
              className="p-6 space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Short Label</label>
                  <input
                    type="text"
                    required
                    value={editShortName}
                    onChange={(e) => setEditShortName(e.target.value)}
                    placeholder="e.g. SBI CC 5733"
                    className="w-full px-3 py-2 text-sm rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Card Type</label>
                  <select
                    value={editCardType}
                    onChange={(e) => setEditCardType(e.target.value as 'credit_card' | 'rupay_card')}
                    className="w-full px-3 py-2 text-sm rounded-lg field-input"
                  >
                    <option value="credit_card" className="bg-[#111827]">Credit Card</option>
                    <option value="rupay_card" className="bg-[#111827]">RuPay UPI CC</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Full Card Name</label>
                <input
                  type="text"
                  required
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  placeholder="e.g. SBI SimplyCLICK / Cashback CC (5733)"
                  className="w-full px-3 py-2 text-sm rounded-lg field-input"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Credit Limit (₹)</label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={editCreditLimit}
                    onChange={(e) => setEditCreditLimit(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Opening Outstanding (₹)</label>
                  <input
                    type="number"
                    value={editBaseBalance}
                    onChange={(e) => setEditBaseBalance(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Billing Day (1-31)</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    placeholder="e.g. 18"
                    value={editBillingDay}
                    onChange={(e) => setEditBillingDay(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Payment Due Day (1-31)</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    placeholder="e.g. 7"
                    value={editDueDay}
                    onChange={(e) => setEditDueDay(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  checked={editResetTimestamp}
                  onChange={(e) => setEditResetTimestamp(e.target.checked)}
                  className="mt-0.5 rounded border-slate-600 bg-[#0B0F17] text-sky-400 focus:ring-sky-400"
                />
                <span>
                  Set Opening Outstanding as current snapshot from now{' '}
                  <span className="text-slate-500">(ignores older card transactions in balance math)</span>
                </span>
              </label>

              {editCardError && <p className="text-xs text-rose-400">{editCardError}</p>}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingCard(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingCard}
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap disabled:opacity-50"
                >
                  {isSavingCard ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Settle Credit Card Due Modal (Partial / Full) */}
      {settlingCard && (() => {
        const cardOut = Number(settlingCard.currentOutstanding || 0);
        const cardLimit = Number(settlingCard.creditLimit || 100000);
        const parsedSettle = Math.max(0, Number(settleAmount || 0));
        const remainingAfter = Math.max(0, cardOut - parsedSettle);
        const newAvailLimit = Math.max(0, cardLimit - remainingAfter);
        const isPartial = cardOut > 0 && parsedSettle > 0 && parsedSettle + 0.01 < cardOut;

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
            onClick={() => setSettlingCard(null)}
          >
            <div
              className="surface-panel rounded-xl w-full max-w-md overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-display text-base font-semibold text-white truncate">
                    Settle Credit Card Due
                  </h2>
                  <p className="text-xs text-slate-400 truncate">
                    {settlingCard.shortName} · {settlingCard.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSettlingCard(null)}
                  aria-label="Close settle card modal"
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (isSettlingCard) return;
                  if (!Number.isFinite(parsedSettle) || parsedSettle <= 0) {
                    setSettleCardError('Enter an amount greater than ₹0.');
                    return;
                  }
                  setIsSettlingCard(true);
                  setSettleCardError('');
                  try {
                    await onSettleCardDue(settlingCard.accountId, {
                      amount: parsedSettle,
                      fromAccount: settleFromAccount,
                      date: settleDate,
                      note: settleNote.trim() || undefined,
                    });
                    setSettlingCard(null);
                  } catch (err: any) {
                    setSettleCardError(err?.message || 'Unable to settle credit card due.');
                  } finally {
                    setIsSettlingCard(false);
                  }
                }}
                className="p-6 space-y-4"
              >
                <div className="bg-[#0B0F17] border border-white/[0.08] rounded-lg p-3.5 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-slate-400">Current Outstanding</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-rose-400 mt-0.5">
                      {formatMoney(cardOut, isPrivacyMode)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-slate-400">After Settlement</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-emerald-400 mt-0.5">
                      {formatMoney(remainingAfter, isPrivacyMode)}
                    </div>
                  </div>
                </div>

                {cardOut > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSettleAmount(String(Number(cardOut.toFixed(2))))}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap ${
                        Math.abs(parsedSettle - cardOut) < 0.05
                          ? 'bg-emerald-400 text-slate-950 border-emerald-400 font-semibold'
                          : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20'
                      }`}
                    >
                      Full ({formatMoney(cardOut, isPrivacyMode)})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettleAmount(String(Math.round((cardOut * 0.5) * 100) / 100))}
                      className="px-2.5 py-1 text-[11px] font-medium rounded-md border bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20 whitespace-nowrap"
                    >
                      50% Partial ({formatMoney(cardOut * 0.5, isPrivacyMode)})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettleAmount(String(Math.max(100, Math.round(cardOut * 0.05))))}
                      className="px-2.5 py-1 text-[11px] font-medium rounded-md border bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20 whitespace-nowrap"
                    >
                      Min 5% ({formatMoney(Math.max(100, Math.round(cardOut * 0.05)), isPrivacyMode)})
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Settlement Amount (₹) {isPartial ? '· Partial' : parsedSettle > 0 && cardOut > 0 ? '· Full' : ''}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      required
                      value={settleAmount}
                      onChange={(e) => setSettleAmount(e.target.value)}
                      placeholder="Enter ₹ amount"
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Payment Date</label>
                    <input
                      type="date"
                      required
                      value={settleDate}
                      onChange={(e) => setSettleDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg field-input"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Pay From Account</label>
                  <select
                    value={settleFromAccount}
                    onChange={(e) => setSettleFromAccount(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg field-input"
                  >
                    {bankAndCash.map((acc) => (
                      <option key={acc.accountId} value={acc.accountId} className="bg-[#111827]">
                        {acc.shortName} ({formatMoney(acc.currentBalance, isPrivacyMode)})
                      </option>
                    ))}
                    <option value="EXTERNAL" className="bg-[#111827]">
                      External / Already Paid (Don&apos;t deduct tracked bank)
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Note (optional)</label>
                  <input
                    type="text"
                    value={settleNote}
                    onChange={(e) => setSettleNote(e.target.value)}
                    placeholder="e.g. Statement due, partial EMI pay"
                    className="w-full px-3 py-2 text-sm rounded-lg field-input"
                  />
                </div>

                <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
                  <span>New Available Card Limit:</span>
                  <span className="font-mono tabular-nums text-sky-400 font-semibold">
                    {formatMoney(newAvailLimit, isPrivacyMode)}
                  </span>
                </div>

                {settleCardError && <p className="text-xs text-rose-400">{settleCardError}</p>}

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setSettlingCard(null)}
                    className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg whitespace-nowrap"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSettlingCard}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg whitespace-nowrap disabled:opacity-50"
                  >
                    {isSettlingCard
                      ? 'Settling...'
                      : isPartial
                      ? 'Settle Partial Due'
                      : 'Settle Card Due'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
