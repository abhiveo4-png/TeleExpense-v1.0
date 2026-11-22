import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Plus, Trash2 } from 'lucide-react';
import {
  InvestmentRecord,
  PiggyBankItem,
  PiggyBankSummary,
  Transaction,
  UdhaarRecord,
} from '../types';
import { ALL_ACCOUNTS } from '../utils/accounts';
import { safeFetchJson } from '../utils/api';
import { formatDate, formatMoney, getCurrentIstDate } from '../utils/formatters';
import { exportUdhaarStatementExcel } from '../utils/statementExport';
import { SettlementModal, SettlementPayload } from './SettlementModal';

interface WealthKhataViewProps {
  udhaars: UdhaarRecord[];
  investments: InvestmentRecord[];
  transactions: Transaction[];
  isPrivacyMode: boolean;
  onRefreshAll: () => Promise<void>;
  onSettleReimbursement: (id: string, payload: SettlementPayload | string) => Promise<void>;
  onSettleAllReimbursements: (account: string) => Promise<void>;
}

export const WealthKhataView: React.FC<WealthKhataViewProps> = ({
  udhaars,
  investments,
  transactions,
  isPrivacyMode,
  onRefreshAll,
  onSettleReimbursement,
  onSettleAllReimbursements,
}) => {
  const [subTab, setSubTab] = useState<'udhaar' | 'investments' | 'piggy' | 'reimbursements'>('udhaar');

  // Udhaar form
  const [udhType, setUdhType] = useState<'lent' | 'borrowed'>('lent');
  const [udhPerson, setUdhPerson] = useState('');
  const [udhAmount, setUdhAmount] = useState('');
  const [udhAccount, setUdhAccount] = useState('AX Bank');
  const [udhDesc, setUdhDesc] = useState('');
  const [isDeletingAllUdhaar, setIsDeletingAllUdhaar] = useState(false);

  // Investment form
  const [invType, setInvType] = useState<InvestmentRecord['type']>('Mutual Fund');
  const [invName, setInvName] = useState('');
  const [invAmount, setInvAmount] = useState('');
  const [invMonthly, setInvMonthly] = useState('');
  const [invAccount, setInvAccount] = useState('AX Bank');
  const [invAutoDay, setInvAutoDay] = useState('');

  // Piggy Bank
  const [piggyFunds, setPiggyFunds] = useState<PiggyBankItem[]>([]);
  const [piggySummary, setPiggySummary] = useState<PiggyBankSummary | null>(null);
  const [pbName, setPbName] = useState('');
  const [pbTarget, setPbTarget] = useState('');

  // Bulk Reimbursement settle account
  const [rimAccount, setRimAccount] = useState('AX Bank');
  // Partial / Full settlement modals
  const [settlingUdhaar, setSettlingUdhaar] = useState<UdhaarRecord | null>(null);
  const [settlingRimTx, setSettlingRimTx] = useState<Transaction | null>(null);
  const [invPayAccounts, setInvPayAccounts] = useState<Record<string, string>>({});

  const loadPiggyBank = async () => {
    const { data } = await safeFetchJson<{ funds: PiggyBankItem[]; summary: PiggyBankSummary }>('/api/piggy-bank');
    if (data) {
      setPiggyFunds(data.funds || []);
      setPiggySummary(data.summary || null);
    }
  };

  useEffect(() => {
    loadPiggyBank();
  }, []);

  const reimbursements = transactions.filter((t) => t.type === 'expense' && t.isReimbursement);
  const pendingRims = reimbursements.filter((t) => t.reimbursementStatus !== 'settled');

  const totalLentPending = udhaars
    .filter((u) => u.type === 'lent' && u.status !== 'settled')
    .reduce((s, u) => s + Math.max(0, u.amount - (u.settledAmount || 0)), 0);
  const totalBorrowedPending = udhaars
    .filter((u) => u.type === 'borrowed' && u.status !== 'settled')
    .reduce((s, u) => s + Math.max(0, u.amount - (u.settledAmount || 0)), 0);
  const totalInvested = investments.reduce((s, i) => s + Number(i.amount || 0), 0);

  return (
    <div className="space-y-6">
      <div className="inline-flex flex-wrap p-1 bg-[#111827] border border-white/[0.08] rounded-lg">
        {[
          { id: 'udhaar', label: `Udhaar Khata (${udhaars.filter((u) => u.status !== 'settled').length})` },
          { id: 'investments', label: `Investments & SIPs (${investments.length})` },
          { id: 'piggy', label: `Goal Funds (${piggyFunds.length})` },
          { id: 'reimbursements', label: `Reimbursements (${pendingRims.length})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id as any)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === t.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'udhaar' && (
        <div className="space-y-6">
          <section className="surface-panel rounded-xl grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
            <div className="p-5">
              <div className="text-xs text-slate-400">You Will Receive (Lent)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-amber-400 mt-1">
                {formatMoney(totalLentPending, isPrivacyMode)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-400">You Owe (Borrowed)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-rose-400 mt-1">
                {formatMoney(totalBorrowedPending, isPrivacyMode)}
              </div>
            </div>
          </section>

          <section className="surface-panel rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-semibold text-white">Log Udhaar Entry</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportUdhaarStatementExcel(udhaars)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Udhaar Statement (.xlsx)</span>
                </button>
                {udhaars.length > 0 && (
                  <button
                    type="button"
                    disabled={isDeletingAllUdhaar}
                    onClick={async () => {
                      if (isDeletingAllUdhaar) return;
                      setIsDeletingAllUdhaar(true);
                      try {
                        await safeFetchJson('/api/udhaar', { method: 'DELETE' });
                        await onRefreshAll();
                      } finally {
                        setIsDeletingAllUdhaar(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-200 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isDeletingAllUdhaar ? 'Deleting All...' : `Delete All (${udhaars.length})`}</span>
                  </button>
                )}
              </div>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!udhPerson.trim() || !udhAmount) return;
                await safeFetchJson('/api/udhaar', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: udhType,
                    personName: udhPerson.trim(),
                    amount: Number(udhAmount),
                    account: udhAccount,
                    description: udhDesc.trim(),
                    date: getCurrentIstDate(),
                  }),
                });
                setUdhPerson('');
                setUdhAmount('');
                setUdhDesc('');
                await onRefreshAll();
              }}
              className="grid grid-cols-1 sm:grid-cols-6 gap-2"
            >
              <select
                value={udhType}
                onChange={(e) => setUdhType(e.target.value as any)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              >
                <option value="lent" className="bg-[#111827]">Lent (Diya)</option>
                <option value="borrowed" className="bg-[#111827]">Borrowed (Liya)</option>
              </select>
              <input
                type="text"
                placeholder="Person Name"
                value={udhPerson}
                onChange={(e) => setUdhPerson(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <input
                type="number"
                placeholder="Amount ₹"
                value={udhAmount}
                onChange={(e) => setUdhAmount(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <select
                value={udhAccount}
                onChange={(e) => setUdhAccount(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              >
                {ALL_ACCOUNTS.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[#111827]">
                    {a.shortName}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Note (optional)"
                value={udhDesc}
                onChange={(e) => setUdhDesc(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
              >
                Add Entry
              </button>
            </form>

            {udhaars.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">No Udhaar records logged yet.</p>
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {udhaars.map((u) => {
                  const remaining = Math.max(0, u.amount - (u.settledAmount || 0));
                  return (
                    <div key={u.id} className="py-3.5 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-white">
                          {u.personName}{' '}
                          <span className="text-xs font-normal text-slate-400">
                            · {u.type === 'lent' ? 'Lent' : 'Borrowed'} · {formatDate(u.date)}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500">
                          {u.description || 'No description'} · Status:{' '}
                          <span className={u.status === 'settled' ? 'text-emerald-400' : 'text-amber-400'}>
                            {u.status === 'partial'
                              ? `partial (${formatMoney(u.settledAmount || 0, isPrivacyMode)} settled)`
                              : u.status}
                          </span>
                          {u.settledInAccount ? ` · ${u.settledInAccount}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-sm font-semibold text-white">
                            {formatMoney(remaining, isPrivacyMode)}
                          </div>
                          {u.settledAmount ? (
                            <div className="text-[11px] text-slate-500">
                              of {formatMoney(u.amount, isPrivacyMode)}
                            </div>
                          ) : null}
                        </div>
                        {u.status !== 'settled' && (
                          <button
                            type="button"
                            onClick={() => setSettlingUdhaar(u)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 rounded-md whitespace-nowrap"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Settle</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            await safeFetchJson(`/api/udhaar/${u.id}`, { method: 'DELETE' });
                            await onRefreshAll();
                          }}
                          className="p-1.5 text-slate-400 hover:text-rose-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {subTab === 'investments' && (
        <div className="space-y-6">
          <section className="surface-panel rounded-xl p-5 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400">Total Tracked Portfolio Principal</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1">
                {formatMoney(totalInvested, isPrivacyMode)}
              </div>
            </div>
          </section>

          <section className="surface-panel rounded-xl p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-white">Add Investment / SIP</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!invName.trim()) return;
                await safeFetchJson('/api/investments', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: invType,
                    name: invName.trim(),
                    amount: Number(invAmount || 0),
                    monthlyAmount: invMonthly ? Number(invMonthly) : undefined,
                    account: invAccount,
                    autoDebitEnabled: Boolean(invAutoDay),
                    autoDebitDay: invAutoDay ? Number(invAutoDay) : undefined,
                    date: getCurrentIstDate(),
                  }),
                });
                setInvName('');
                setInvAmount('');
                setInvMonthly('');
                setInvAutoDay('');
                await onRefreshAll();
              }}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2"
            >
              <select
                value={invType}
                onChange={(e) => setInvType(e.target.value as any)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              >
                {['Mutual Fund', 'RD', 'FD', 'PPF', 'Gold', 'Insurance', 'Other'].map((t) => (
                  <option key={t} value={t} className="bg-[#111827]">
                    {t}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Scheme / Instrument Name"
                value={invName}
                onChange={(e) => setInvName(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <input
                type="number"
                placeholder="Invested ₹"
                value={invAmount}
                onChange={(e) => setInvAmount(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <input
                type="number"
                placeholder="Monthly SIP ₹"
                value={invMonthly}
                onChange={(e) => setInvMonthly(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <select
                aria-label="Investment payment account"
                value={invAccount}
                onChange={(e) => setInvAccount(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              >
                {ALL_ACCOUNTS.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[#111827]">
                    {a.shortName}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                max="28"
                placeholder="Auto Day (1-28)"
                value={invAutoDay}
                onChange={(e) => setInvAutoDay(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap"
              >
                Add Portfolio
              </button>
            </form>

            {investments.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">No investments added yet.</p>
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {investments.map((inv) => (
                  <div key={inv.id} className="py-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-white">
                        {inv.name}{' '}
                        <span className="text-xs font-normal text-slate-400">
                          · {inv.type} · {inv.account}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        {inv.monthlyAmount
                          ? `SIP ${formatMoney(inv.monthlyAmount, isPrivacyMode)}/mo`
                          : 'Lump Sum'}
                        {inv.autoDebitEnabled && inv.autoDebitDay
                          ? ` · Auto-debit on day ${inv.autoDebitDay}`
                          : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono tabular-nums text-sm font-semibold text-emerald-400 mr-1">
                        {formatMoney(inv.amount, isPrivacyMode)}
                      </span>
                      {inv.monthlyAmount && inv.monthlyAmount > 0 && (
                        <div className="flex items-center gap-1.5">
                          <select
                            aria-label={`SIP payment account for ${inv.name}`}
                            value={invPayAccounts[inv.id] ?? inv.account ?? 'AX Bank'}
                            onChange={(e) =>
                              setInvPayAccounts((prev) => ({ ...prev, [inv.id]: e.target.value }))
                            }
                            className="px-2 py-1 text-[11px] rounded-md field-input"
                          >
                            {ALL_ACCOUNTS.map((a) => (
                              <option key={a.id} value={a.id} className="bg-[#111827]">
                                {a.shortName}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={async () => {
                              const payAcc = invPayAccounts[inv.id] ?? inv.account ?? 'AX Bank';
                              await safeFetchJson(`/api/investments/${inv.id}/pay-installment`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ amount: inv.monthlyAmount, account: payAcc }),
                              });
                              await onRefreshAll();
                            }}
                            className="px-2.5 py-1 text-xs font-medium text-sky-300 bg-sky-500/15 hover:bg-sky-500/25 rounded-md whitespace-nowrap"
                          >
                            Pay SIP
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          await safeFetchJson(`/api/investments/${inv.id}`, { method: 'DELETE' });
                          await onRefreshAll();
                        }}
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
        </div>
      )}

      {subTab === 'piggy' && (
        <div className="space-y-6">
          <section className="surface-panel rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs text-slate-400">Total in Goal Funds</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1">
                {formatMoney(piggySummary?.totalInAllFunds || 0, isPrivacyMode)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Uncollected Month Surplus: {formatMoney(piggySummary?.currentMonthUncollectedSurplus || 0, isPrivacyMode)}
              </div>
            </div>
            {(piggySummary?.currentMonthUncollectedSurplus || 0) > 0 && (
              <button
                type="button"
                onClick={async () => {
                  await safeFetchJson('/api/piggy-bank/collect-surplus', { method: 'POST' });
                  await loadPiggyBank();
                }}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg"
              >
                Collect Monthly Surplus
              </button>
            )}
          </section>

          <section className="surface-panel rounded-xl p-5 space-y-4">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!pbName.trim()) return;
                await safeFetchJson('/api/piggy-bank', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name: pbName.trim(),
                    targetAmount: pbTarget ? Number(pbTarget) : undefined,
                  }),
                });
                setPbName('');
                setPbTarget('');
                await loadPiggyBank();
              }}
              className="flex flex-wrap gap-2"
            >
              <input
                type="text"
                placeholder="Goal Fund Name (e.g. Emergency Fund, Goa Trip)"
                value={pbName}
                onChange={(e) => setPbName(e.target.value)}
                className="flex-1 min-w-[200px] px-3 py-2 text-xs rounded-lg field-input"
              />
              <input
                type="number"
                placeholder="Target ₹ (optional)"
                value={pbTarget}
                onChange={(e) => setPbTarget(e.target.value)}
                className="w-36 px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create Goal</span>
              </button>
            </form>

            {piggyFunds.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">Create your first goal bucket above.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {piggyFunds.map((f) => {
                  const pct = f.targetAmount ? Math.min(100, Math.round((f.currentBalance / f.targetAmount) * 100)) : 0;
                  return (
                    <div key={f.id} className="surface-elevated rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-sm font-semibold text-white">{f.name}</div>
                          <div className="text-xs text-slate-400">
                            {f.targetAmount
                              ? `Target ${formatMoney(f.targetAmount, isPrivacyMode)} (${pct}%)`
                              : 'Flexible bucket'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            await safeFetchJson(`/api/piggy-bank/${f.id}`, { method: 'DELETE' });
                            await loadPiggyBank();
                          }}
                          className="p-1 text-slate-400 hover:text-rose-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="text-xl font-bold font-mono tabular-nums text-emerald-400">
                        {formatMoney(f.currentBalance, isPrivacyMode)}
                      </div>
                      {f.targetAmount && (
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-400" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={async () => {
                            const amt = window.prompt(`Deposit into ${f.name} (₹):`, '1000');
                            if (!amt || Number(amt) <= 0) return;
                            await safeFetchJson(`/api/piggy-bank/${f.id}/transact`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ type: 'deposit', amount: Number(amt) }),
                            });
                            await loadPiggyBank();
                          }}
                          className="px-3 py-1.5 text-xs font-medium bg-emerald-500/15 text-emerald-300 rounded-md hover:bg-emerald-500/25"
                        >
                          + Deposit
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const amt = window.prompt(`Withdraw from ${f.name} (₹):`, '500');
                            if (!amt || Number(amt) <= 0) return;
                            await safeFetchJson(`/api/piggy-bank/${f.id}/transact`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ type: 'withdraw', amount: Number(amt) }),
                            });
                            await loadPiggyBank();
                          }}
                          className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-slate-300 rounded-md hover:text-white"
                        >
                          Withdraw
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {subTab === 'reimbursements' && (
        <section className="surface-panel rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-semibold text-white">Reimbursable Office Claims</h2>
              <p className="text-xs text-slate-400">
                Pending Claim Total:{' '}
                <span className="font-mono tabular-nums text-amber-400 font-semibold">
                  {formatMoney(
                    pendingRims.reduce((s, t) => s + Math.max(0, t.amount - (t.reimbursementSettledAmount || 0)), 0),
                    isPrivacyMode
                  )}
                </span>
              </p>
            </div>
            {pendingRims.length > 0 && (
              <div className="flex items-center gap-2">
                <select
                  value={rimAccount}
                  onChange={(e) => setRimAccount(e.target.value)}
                  className="px-3 py-1.5 text-xs rounded-lg field-input"
                >
                  {ALL_ACCOUNTS.map((a) => (
                    <option key={a.id} value={a.id} className="bg-[#111827]">
                      {a.shortName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onSettleAllReimbursements(rimAccount)}
                  className="px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg whitespace-nowrap"
                >
                  Settle All
                </button>
              </div>
            )}
          </div>

          {reimbursements.length === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">
              No reimbursement claims yet. Start any Telegram or quick-log message with &ldquo;rim&rdquo;.
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {reimbursements.map((tx) => {
                const settledAmt = Number(tx.reimbursementSettledAmount || 0);
                const remainingAmt = Math.max(0, Number(tx.amount) - settledAmt);
                const isSettled = tx.reimbursementStatus === 'settled';
                const isPartial = tx.reimbursementStatus === 'partial';

                return (
                  <div key={tx.id} className="py-3.5 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-white">{tx.description}</div>
                      <div className="text-xs text-slate-400">
                        {formatDate(tx.date)} · {tx.account} ·{' '}
                        <span className={isSettled ? 'text-emerald-400' : 'text-amber-400'}>
                          {isSettled
                            ? `Settled in ${tx.settledInAccount || 'Bank'}`
                            : isPartial
                            ? `Partial (${formatMoney(settledAmt, isPrivacyMode)} in ${tx.settledInAccount || 'Bank'})`
                            : 'Pending Claim'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right font-mono tabular-nums">
                        <div className="text-sm font-semibold text-white">
                          {formatMoney(isSettled ? tx.amount : remainingAmt, isPrivacyMode)}
                        </div>
                        {isPartial && (
                          <div className="text-[11px] text-slate-500">
                            of {formatMoney(tx.amount, isPrivacyMode)}
                          </div>
                        )}
                      </div>
                      {!isSettled && (
                        <button
                          type="button"
                          onClick={() => setSettlingRimTx(tx)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 rounded-md whitespace-nowrap"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Settle</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <SettlementModal
        isOpen={Boolean(settlingUdhaar)}
        kind="udhaar"
        title={settlingUdhaar?.personName || ''}
        subtitle={
          settlingUdhaar
            ? `${settlingUdhaar.type === 'lent' ? 'Lent (Recovery)' : 'Borrowed (Repay)'} · ${formatDate(
                settlingUdhaar.date
              )}${settlingUdhaar.description ? ` · ${settlingUdhaar.description}` : ''}`
            : undefined
        }
        totalAmount={Number(settlingUdhaar?.amount || 0)}
        alreadySettled={Number(settlingUdhaar?.settledAmount || 0)}
        defaultAccount={settlingUdhaar?.settledInAccount || settlingUdhaar?.account || 'AX Bank'}
        udhaarDirection={settlingUdhaar?.type || 'lent'}
        isPrivacyMode={isPrivacyMode}
        onClose={() => setSettlingUdhaar(null)}
        onConfirm={async (payload) => {
          if (!settlingUdhaar) return;
          const { error } = await safeFetchJson(`/api/udhaar/${settlingUdhaar.id}/settle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: payload.amount,
              account: payload.account,
              date: payload.date,
              notes: payload.note,
            }),
          });
          if (error) throw new Error(error);
          await onRefreshAll();
        }}
      />

      <SettlementModal
        isOpen={Boolean(settlingRimTx)}
        kind="reimbursement"
        title={settlingRimTx?.description || ''}
        subtitle={
          settlingRimTx
            ? `${formatDate(settlingRimTx.date)} · Paid via ${settlingRimTx.account || 'AX Bank'}`
            : undefined
        }
        totalAmount={Number(settlingRimTx?.amount || 0)}
        alreadySettled={Number(settlingRimTx?.reimbursementSettledAmount || 0)}
        defaultAccount={settlingRimTx?.settledInAccount || rimAccount || 'AX Bank'}
        isPrivacyMode={isPrivacyMode}
        onClose={() => setSettlingRimTx(null)}
        onConfirm={async (payload) => {
          if (!settlingRimTx) return;
          await onSettleReimbursement(settlingRimTx.id, payload);
        }}
      />
    </div>
  );
};
