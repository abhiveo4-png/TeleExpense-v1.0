import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Pencil, Plus, Trash2, TrendingUp, X } from 'lucide-react';
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
import { addMonthsToYmd, calculateInvestmentMetrics } from '../utils/investmentCalculator';
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
  const [invRoi, setInvRoi] = useState('');
  const [invDate, setInvDate] = useState(() => getCurrentIstDate());
  const [invMaturityDate, setInvMaturityDate] = useState('');
  const [invCurrentValue, setInvCurrentValue] = useState('');
  const [invAccount, setInvAccount] = useState('AX Bank');
  const [invAutoDay, setInvAutoDay] = useState('');
  const [invError, setInvError] = useState<string | null>(null);
  const [editingInv, setEditingInv] = useState<InvestmentRecord | null>(null);
  const [editInvDraft, setEditInvDraft] = useState<{
    type: InvestmentRecord['type'];
    name: string;
    amount: string;
    monthlyAmount: string;
    interestRate: string;
    date: string;
    maturityDate: string;
    currentValue: string;
    account: string;
    autoDebitDay: string;
  } | null>(null);
  const [isSavingInvEdit, setIsSavingInvEdit] = useState(false);

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

  const investmentSummaries = useMemo(() => {
    const items = investments.map((inv) => ({
      inv,
      metrics: calculateInvestmentMetrics(inv),
    }));
    const totalInvested = items.reduce((s, x) => s + x.metrics.depositedPrincipal, 0);
    const totalCurrentValue = items.reduce((s, x) => s + x.metrics.currentValue, 0);
    const totalGain = totalCurrentValue - totalInvested;
    const overallAbsRoi =
      totalInvested > 0 ? Number(((totalGain / totalInvested) * 100).toFixed(2)) : 0;
    const weightedAnnualRoiNumerator = items.reduce(
      (s, x) => s + x.metrics.depositedPrincipal * (x.metrics.effectiveAnnualRoiPercent || 0),
      0
    );
    const weightedAnnualRoi =
      totalInvested > 0
        ? Number((weightedAnnualRoiNumerator / totalInvested).toFixed(2))
        : 0;
    const totalProjectedMaturity = items.reduce((s, x) => s + x.metrics.maturityAmount, 0);
    return {
      items,
      totalInvested,
      totalCurrentValue,
      totalGain,
      overallAbsRoi,
      weightedAnnualRoi,
      totalProjectedMaturity,
    };
  }, [investments]);

  const liveAddPreview = useMemo(() => {
    const amt = Number(invAmount || 0);
    const monthly = Number(invMonthly || 0);
    if (amt <= 0 && monthly <= 0) return null;
    return calculateInvestmentMetrics({
      type: invType,
      amount: amt,
      monthlyAmount: monthly > 0 ? monthly : undefined,
      interestRate: invRoi !== '' ? Number(invRoi) : undefined,
      date: invDate || getCurrentIstDate(),
      maturityDate: invMaturityDate || undefined,
      currentValue: invCurrentValue !== '' ? Number(invCurrentValue) : undefined,
      autoDebitEnabled: Boolean(invAutoDay),
    });
  }, [
    invType,
    invAmount,
    invMonthly,
    invRoi,
    invDate,
    invMaturityDate,
    invCurrentValue,
    invAutoDay,
  ]);

  const liveEditPreview = useMemo(() => {
    if (!editInvDraft) return null;
    const amt = Number(editInvDraft.amount || 0);
    const monthly = Number(editInvDraft.monthlyAmount || 0);
    if (amt <= 0 && monthly <= 0) return null;
    return calculateInvestmentMetrics({
      type: editInvDraft.type,
      amount: amt,
      monthlyAmount: monthly > 0 ? monthly : undefined,
      interestRate: editInvDraft.interestRate !== '' ? Number(editInvDraft.interestRate) : undefined,
      date: editInvDraft.date || getCurrentIstDate(),
      maturityDate: editInvDraft.maturityDate || undefined,
      currentValue: editInvDraft.currentValue !== '' ? Number(editInvDraft.currentValue) : undefined,
      autoDebitEnabled: Boolean(editInvDraft.autoDebitDay),
    });
  }, [editInvDraft]);

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
          <section className="surface-panel rounded-xl grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
            <div className="p-5">
              <div className="text-xs text-slate-400">Invested Principal ({investments.length})</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                {formatMoney(investmentSummaries.totalInvested, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Base deposited capital across holdings
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-400">Current Portfolio Value</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1">
                {formatMoney(investmentSummaries.totalCurrentValue, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                Est. Maturity: {formatMoney(investmentSummaries.totalProjectedMaturity, isPrivacyMode)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-400">Total Gains &amp; Avg ROI</div>
              <div
                className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
                  investmentSummaries.totalGain >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {investmentSummaries.totalGain >= 0 ? '+' : ''}
                {formatMoney(investmentSummaries.totalGain, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums">
                {investmentSummaries.overallAbsRoi >= 0 ? '+' : ''}
                {investmentSummaries.overallAbsRoi}% abs · ~{investmentSummaries.weightedAnnualRoi}% p.a.
              </div>
            </div>
          </section>

          <section className="surface-panel rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold text-white">Add Investment / SIP</h2>
              <span className="text-[11px] text-slate-400">
                Enter ROI % p.a. to auto-calculate Current Value &amp; Maturity (or enter Current ₹ for auto ROI)
              </span>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setInvError(null);
                if (!invName.trim()) {
                  setInvError('Scheme / Instrument Name is required.');
                  return;
                }
                if (invMaturityDate && invDate && invMaturityDate <= invDate) {
                  setInvError('Maturity Date must be after Start Date.');
                  return;
                }
                const { error } = await safeFetchJson('/api/investments', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: invType,
                    name: invName.trim(),
                    amount: Number(invAmount || 0),
                    monthlyAmount: invMonthly ? Number(invMonthly) : undefined,
                    interestRate: invRoi !== '' ? Number(invRoi) : undefined,
                    date: invDate || getCurrentIstDate(),
                    maturityDate: invMaturityDate || undefined,
                    currentValue: invCurrentValue !== '' ? Number(invCurrentValue) : undefined,
                    account: invAccount,
                    autoDebitEnabled: Boolean(invAutoDay),
                    autoDebitDay: invAutoDay ? Number(invAutoDay) : undefined,
                  }),
                });
                if (error) {
                  setInvError(error);
                  return;
                }
                setInvName('');
                setInvAmount('');
                setInvMonthly('');
                setInvRoi('');
                setInvDate(getCurrentIstDate());
                setInvMaturityDate('');
                setInvCurrentValue('');
                setInvAutoDay('');
                await onRefreshAll();
              }}
              className="space-y-3"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
                <select
                  aria-label="Investment type"
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
                  className="px-3 py-2 text-xs rounded-lg field-input lg:col-span-2"
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Invested Principal ₹"
                  value={invAmount}
                  onChange={(e) => setInvAmount(e.target.value)}
                  className="px-3 py-2 text-xs font-mono rounded-lg field-input"
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Monthly SIP / RD ₹"
                  value={invMonthly}
                  onChange={(e) => setInvMonthly(e.target.value)}
                  className="px-3 py-2 text-xs font-mono rounded-lg field-input"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="ROI % (p.a.) e.g. 12"
                  value={invRoi}
                  onChange={(e) => setInvRoi(e.target.value)}
                  className="px-3 py-2 text-xs font-mono rounded-lg field-input"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 items-end">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Start Date</label>
                  <input
                    type="date"
                    aria-label="Start Date"
                    title="Investment Start Date"
                    value={invDate}
                    onChange={(e) => setInvDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">
                    Maturity Date (Auto Tenure)
                  </label>
                  <input
                    type="date"
                    aria-label="Maturity Date"
                    title="Maturity Date — Tenure is auto-calculated"
                    min={invDate || undefined}
                    value={invMaturityDate}
                    onChange={(e) => setInvMaturityDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Current Value ₹</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Auto if empty"
                    value={invCurrentValue}
                    onChange={(e) => setInvCurrentValue(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Account</label>
                  <select
                    aria-label="Investment payment account"
                    value={invAccount}
                    onChange={(e) => setInvAccount(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg field-input"
                  >
                    {ALL_ACCOUNTS.map((a) => (
                      <option key={a.id} value={a.id} className="bg-[#111827]">
                        {a.shortName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Auto SIP Day</label>
                  <input
                    type="number"
                    min="1"
                    max="28"
                    placeholder="1-28 (optional)"
                    value={invAutoDay}
                    onChange={(e) => setInvAutoDay(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap h-[34px]"
                >
                  Add Portfolio
                </button>
              </div>

              {invError && <div className="text-xs text-rose-400">{invError}</div>}

              {liveAddPreview && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-emerald-300 font-medium">
                    <TrendingUp className="w-3.5 h-3.5 shrink-0" />
                    <span>Auto ROI &amp; Tenure Preview:</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums">
                    {liveAddPreview.tenureLabel && (
                      <span className="text-slate-300">
                        Tenure:{' '}
                        <strong className="text-amber-300">
                          {liveAddPreview.tenureLabel} ({liveAddPreview.tenureMonths}m)
                        </strong>
                      </span>
                    )}
                    <span className="text-slate-300">
                      Current: <strong className="text-emerald-300">{formatMoney(liveAddPreview.currentValue, isPrivacyMode)}</strong>
                    </span>
                    <span className="text-slate-300">
                      Gain:{' '}
                      <strong className={liveAddPreview.gainAmount >= 0 ? 'text-emerald-300' : 'text-rose-400'}>
                        {liveAddPreview.gainAmount >= 0 ? '+' : ''}
                        {formatMoney(liveAddPreview.gainAmount, isPrivacyMode)} ({liveAddPreview.absoluteRoiPercent}%)
                      </strong>
                    </span>
                    <span className="text-slate-300">
                      ROI: <strong className="text-sky-300">{liveAddPreview.effectiveAnnualRoiPercent}% p.a.</strong>
                    </span>
                    {liveAddPreview.hasMaturityProjection && (
                      <span className="text-slate-300">
                        Est. Maturity: <strong className="text-white">{formatMoney(liveAddPreview.maturityAmount, isPrivacyMode)}</strong>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </form>

            {investments.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">No investments added yet.</p>
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {investmentSummaries.items.map(({ inv, metrics }) => (
                  <div key={inv.id} className="py-4 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="text-sm font-medium text-white">
                          {inv.name}{' '}
                          <span className="text-xs font-normal text-slate-400">
                            · {inv.type} · {inv.account} · {formatDate(inv.date)}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono tabular-nums">
                          <span>Invested: {formatMoney(metrics.depositedPrincipal, isPrivacyMode)}</span>
                          <span>·</span>
                          <span className="text-sky-300">
                            ROI:{' '}
                            {metrics.effectiveAnnualRoiPercent > 0
                              ? `${metrics.effectiveAnnualRoiPercent}% p.a.${
                                  metrics.isRoiAutoInferred ? ' (auto)' : ''
                                }`
                              : 'Not set'}
                          </span>
                          {metrics.effectiveMaturityDate && (
                            <>
                              <span>·</span>
                              <span className={metrics.isMatured ? 'text-emerald-300 font-medium' : 'text-slate-300'}>
                                {metrics.isMatured ? 'Matured' : 'Mat'}: {formatDate(metrics.effectiveMaturityDate)}
                                {metrics.tenureLabel ? ` (${metrics.tenureLabel})` : ''}
                              </span>
                            </>
                          )}
                          <span>·</span>
                          <span className="font-sans text-slate-500">
                            {inv.monthlyAmount
                              ? `SIP ${formatMoney(inv.monthlyAmount, isPrivacyMode)}/mo`
                              : 'Lump Sum'}
                            {inv.autoDebitEnabled && inv.autoDebitDay
                              ? ` · Auto day ${inv.autoDebitDay}`
                              : ''}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="text-right font-mono tabular-nums mr-1">
                          <div className="text-sm font-semibold text-emerald-400">
                            {formatMoney(metrics.currentValue, isPrivacyMode)}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            <span className={metrics.gainAmount >= 0 ? 'text-emerald-300' : 'text-rose-400'}>
                              {metrics.gainAmount >= 0 ? '+' : ''}
                              {formatMoney(metrics.gainAmount, isPrivacyMode)} ({metrics.absoluteRoiPercent >= 0 ? '+' : ''}
                              {metrics.absoluteRoiPercent}%)
                            </span>
                            {metrics.hasMaturityProjection && metrics.maturityAmount > metrics.currentValue && (
                              <span className="text-slate-500">
                                {' '}· Mat {formatMoney(metrics.maturityAmount, isPrivacyMode)}
                              </span>
                            )}
                          </div>
                        </div>

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
                          title="Edit investment & ROI"
                          onClick={() => {
                            const startYmd = inv.date || getCurrentIstDate();
                            const fallbackMaturity =
                              !inv.maturityDate && inv.totalInstallments && inv.totalInstallments > 1
                                ? addMonthsToYmd(startYmd, inv.totalInstallments)
                                : '';
                            setEditingInv(inv);
                            setEditInvDraft({
                              type: inv.type,
                              name: inv.name,
                              amount: String(inv.amount ?? 0),
                              monthlyAmount: inv.monthlyAmount ? String(inv.monthlyAmount) : '',
                              interestRate:
                                inv.interestRate !== undefined && inv.interestRate !== null
                                  ? String(inv.interestRate)
                                  : '',
                              date: startYmd,
                              maturityDate: inv.maturityDate || fallbackMaturity,
                              currentValue:
                                inv.currentValue !== undefined && inv.currentValue !== null && inv.currentValue > 0
                                  ? String(inv.currentValue)
                                  : '',
                              account: inv.account || 'AX Bank',
                              autoDebitDay: inv.autoDebitDay ? String(inv.autoDebitDay) : '',
                            });
                          }}
                          className="p-1.5 text-slate-400 hover:text-sky-300"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Delete investment"
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

                    {metrics.hasMaturityProjection && (metrics.progressPercent > 0 || metrics.tenureLabel) && (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-400/80"
                            style={{ width: `${metrics.progressPercent}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono tabular-nums text-slate-500">
                          {metrics.isRecurring
                            ? `${metrics.paidInstallments}/${metrics.totalInstallments} inst${
                                metrics.tenureLabel ? ` · ${metrics.tenureLabel}` : ''
                              } (${metrics.progressPercent}%)`
                            : `${metrics.tenureLabel ? `${metrics.tenureLabel} · ` : ''}${metrics.progressPercent}% elapsed`}
                        </span>
                      </div>
                    )}
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

      {editingInv && editInvDraft && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => {
            if (!isSavingInvEdit) {
              setEditingInv(null);
              setEditInvDraft(null);
            }
          }}
        >
          <div
            className="w-full max-w-lg surface-panel rounded-xl border border-white/[0.1] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-white">
                  Edit Investment &amp; ROI
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Leave Current Value empty to auto-calculate from ROI % &amp; Start Date
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingInv(null);
                  setEditInvDraft(null);
                }}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editingInv || !editInvDraft.name.trim()) return;
                setIsSavingInvEdit(true);
                try {
                  await safeFetchJson(`/api/investments/${editingInv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      type: editInvDraft.type,
                      name: editInvDraft.name.trim(),
                      amount: Number(editInvDraft.amount || 0),
                      monthlyAmount: editInvDraft.monthlyAmount !== '' ? Number(editInvDraft.monthlyAmount) : null,
                      interestRate: editInvDraft.interestRate !== '' ? Number(editInvDraft.interestRate) : null,
                      date: editInvDraft.date || getCurrentIstDate(),
                      maturityDate: editInvDraft.maturityDate || null,
                      currentValue: editInvDraft.currentValue !== '' ? Number(editInvDraft.currentValue) : null,
                      account: editInvDraft.account,
                      autoDebitEnabled: Boolean(editInvDraft.autoDebitDay),
                      autoDebitDay: editInvDraft.autoDebitDay !== '' ? Number(editInvDraft.autoDebitDay) : null,
                    }),
                  });
                  setEditingInv(null);
                  setEditInvDraft(null);
                  await onRefreshAll();
                } finally {
                  setIsSavingInvEdit(false);
                }
              }}
              className="space-y-3"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Type</label>
                  <select
                    value={editInvDraft.type}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, type: e.target.value as any } : prev))
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg field-input"
                  >
                    {['Mutual Fund', 'RD', 'FD', 'PPF', 'Gold', 'Insurance', 'Other'].map((t) => (
                      <option key={t} value={t} className="bg-[#111827]">
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Scheme Name</label>
                  <input
                    type="text"
                    value={editInvDraft.name}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Invested Principal ₹</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={editInvDraft.amount}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, amount: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">ROI % (p.a.)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="e.g. 12.5"
                    value={editInvDraft.interestRate}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, interestRate: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={editInvDraft.date}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, date: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Maturity Date (Auto Tenure)
                  </label>
                  <input
                    type="date"
                    min={editInvDraft.date || undefined}
                    value={editInvDraft.maturityDate}
                    onChange={(e) =>
                      setEditInvDraft((prev) =>
                        prev ? { ...prev, maturityDate: e.target.value } : prev
                      )
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Monthly SIP / RD ₹</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Optional"
                    value={editInvDraft.monthlyAmount}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, monthlyAmount: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Current Value ₹ (Auto if blank)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Auto from ROI %"
                    value={editInvDraft.currentValue}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, currentValue: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Account</label>
                  <select
                    value={editInvDraft.account}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, account: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg field-input"
                  >
                    {ALL_ACCOUNTS.map((a) => (
                      <option key={a.id} value={a.id} className="bg-[#111827]">
                        {a.shortName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Auto-debit Day (1-28)</label>
                  <input
                    type="number"
                    min="1"
                    max="28"
                    placeholder="Optional"
                    value={editInvDraft.autoDebitDay}
                    onChange={(e) =>
                      setEditInvDraft((prev) => (prev ? { ...prev, autoDebitDay: e.target.value } : prev))
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg field-input"
                  />
                </div>
              </div>

              {liveEditPreview && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums">
                  {liveEditPreview.tenureLabel && (
                    <span className="text-slate-300">
                      Tenure:{' '}
                      <strong className="text-amber-300">
                        {liveEditPreview.tenureLabel} ({liveEditPreview.tenureMonths}m)
                      </strong>
                    </span>
                  )}
                  <span className="text-slate-300">
                    Current: <strong className="text-emerald-300">{formatMoney(liveEditPreview.currentValue, isPrivacyMode)}</strong>
                  </span>
                  <span className="text-slate-300">
                    Gain:{' '}
                    <strong className={liveEditPreview.gainAmount >= 0 ? 'text-emerald-300' : 'text-rose-400'}>
                      {liveEditPreview.gainAmount >= 0 ? '+' : ''}
                      {formatMoney(liveEditPreview.gainAmount, isPrivacyMode)} ({liveEditPreview.absoluteRoiPercent}%)
                    </strong>
                  </span>
                  <span className="text-sky-300">
                    ROI: {liveEditPreview.effectiveAnnualRoiPercent}% p.a.
                  </span>
                  {liveEditPreview.hasMaturityProjection && (
                    <span className="text-slate-300">
                      Mat: <strong className="text-white">{formatMoney(liveEditPreview.maturityAmount, isPrivacyMode)}</strong>
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingInv(null);
                    setEditInvDraft(null);
                  }}
                  className="px-3.5 py-2 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingInvEdit}
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg disabled:opacity-50"
                >
                  {isSavingInvEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
