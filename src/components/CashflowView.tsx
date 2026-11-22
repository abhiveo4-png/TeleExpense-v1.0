import React, { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, RotateCcw, Search } from 'lucide-react';
import { AccountBalancesData, Transaction, UserRole } from '../types';
import { ALL_ACCOUNTS, isWifeAccount } from '../utils/accounts';
import { formatDate, formatMoney } from '../utils/formatters';

interface CashflowViewProps {
  transactions: Transaction[];
  balances: AccountBalancesData | null;
  selectedMonth: string;
  userRole: UserRole;
  activeFamilyMemberName: string;
  isPrivacyMode: boolean;
}

type CashflowScope = 'banks_only' | 'banks_cash' | 'all_excl_wife';
type CashflowEntryTab = 'all' | 'inflow' | 'outflow' | 'cc_paid' | 'card_swipes' | 'wife_excluded';

export const CashflowView: React.FC<CashflowViewProps> = ({
  transactions,
  balances,
  selectedMonth,
  userRole,
  activeFamilyMemberName,
  isPrivacyMode,
}) => {
  const [scope, setScope] = useState<CashflowScope>('banks_only');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [entryTab, setEntryTab] = useState<CashflowEntryTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const isDateRangeActive = Boolean(dateFrom || dateTo);

  const getBucket = (rawAccount?: string): 'wife' | 'cash' | 'card' | 'bank' => {
    const accId = (rawAccount || 'AX Bank').trim();
    const lower = accId.toLowerCase();
    if (isWifeAccount(accId)) return 'wife';
    const metaType =
      balances?.accounts?.[accId]?.type ??
      ALL_ACCOUNTS.find((a) => a.id.toLowerCase() === lower)?.type;
    if (metaType === 'cash' || lower === 'cash') return 'cash';
    if (metaType === 'credit_card' || metaType === 'rupay_card' || /\b(cc|card)\b/i.test(lower)) {
      return 'card';
    }
    return 'bank';
  };

  const isWifeExcludedTx = (tx: Transaction): boolean => {
    const acc = (tx.account || 'AX Bank').trim();
    const pmLower = (tx.paymentMethod || '').trim().toLowerCase();
    // Exclude Wife bank account AND Wife's card (Axis 2904)
    if (isWifeAccount(acc) || pmLower === 'wife') return true;
    const isCcSettle = Boolean(tx.isCcPayment || tx.category === 'CC Payment');
    if (
      isCcSettle &&
      /\b(from|via|by)\s+wife\b|\bwife\s*se\b|\(wife\)/i.test(
        `${tx.description || ''} ${tx.rawMessage || ''}`
      )
    ) {
      return true;
    }
    return false;
  };

  const stats = useMemo(() => {
    let totalInflow = 0;
    let totalOutflow = 0;
    let inflowCount = 0;
    let outflowCount = 0;

    let bankInflow = 0;
    let cashInflow = 0;
    let cardInflow = 0;

    let bankOutflow = 0;
    let cashOutflow = 0;
    let cardOutflow = 0;

    let ccPaidFromScopeTotal = 0;
    let ccPaidFromScopeCount = 0;

    let myCardSwipesTotal = 0;
    let myCardInflowTotal = 0;
    let cashSkippedOutflow = 0;
    let cashSkippedInflow = 0;

    let wifeInflowExcluded = 0;
    let wifeOutflowExcluded = 0;
    let wifeCard2904Excluded = 0;

    const countedTxs: Transaction[] = [];
    const myCardSwipeTxs: Transaction[] = [];
    const wifeExcludedTxs: Transaction[] = [];

    const byAccount = new Map<
      string,
      { account: string; inflow: number; outflow: number; count: number }
    >();
    const byCategory = new Map<
      string,
      { category: string; inflow: number; outflow: number; count: number }
    >();

    for (const tx of transactions) {
      if (isDateRangeActive) {
        const d = tx.date || '';
        if (!d) continue;
        if (dateFrom && d < dateFrom) continue;
        if (dateTo && d > dateTo) continue;
      } else if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) {
        continue;
      }

      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) continue;
      }

      const amt = Number(tx.amount || 0);
      if (amt <= 0) continue;

      const isCcSettle = Boolean(tx.isCcPayment || tx.category === 'CC Payment');

      if (isWifeExcludedTx(tx)) {
        wifeExcludedTxs.push(tx);
        const is2904 = /\b2904\b/.test((tx.account || '').toLowerCase());
        if (tx.type === 'income') {
          wifeInflowExcluded += amt;
        } else {
          wifeOutflowExcluded += amt;
          if (is2904) wifeCard2904Excluded += amt;
        }
        continue;
      }

      const acc = tx.account || 'AX Bank';
      const bucket = getBucket(acc);

      // Track your own Credit Card swipes separately (deferred until paid from bank)
      if (bucket === 'card') {
        myCardSwipeTxs.push(tx);
        if (tx.type === 'income') myCardInflowTotal += amt;
        else myCardSwipesTotal += amt;
      }

      const isIncludedInScope =
        scope === 'banks_only'
          ? bucket === 'bank'
          : scope === 'banks_cash'
          ? bucket === 'bank' || bucket === 'cash'
          : true;

      if (!isIncludedInScope) {
        if (bucket === 'cash') {
          if (tx.type === 'income') cashSkippedInflow += amt;
          else cashSkippedOutflow += amt;
        }
        continue;
      }

      countedTxs.push(tx);
      const cat = tx.category || (tx.type === 'income' ? 'Other Income' : 'Other Expense');

      const accEntry = byAccount.get(acc) || { account: acc, inflow: 0, outflow: 0, count: 0 };
      const catEntry = byCategory.get(cat) || { category: cat, inflow: 0, outflow: 0, count: 0 };
      accEntry.count += 1;
      catEntry.count += 1;

      if (tx.type === 'income') {
        totalInflow += amt;
        inflowCount += 1;
        accEntry.inflow += amt;
        catEntry.inflow += amt;
        if (bucket === 'bank') bankInflow += amt;
        else if (bucket === 'cash') cashInflow += amt;
        else if (bucket === 'card') cardInflow += amt;
      } else {
        totalOutflow += amt;
        outflowCount += 1;
        accEntry.outflow += amt;
        catEntry.outflow += amt;
        if (bucket === 'bank') bankOutflow += amt;
        else if (bucket === 'cash') cashOutflow += amt;
        else if (bucket === 'card') cardOutflow += amt;
        if (isCcSettle) {
          ccPaidFromScopeTotal += amt;
          ccPaidFromScopeCount += 1;
        }
      }

      byAccount.set(acc, accEntry);
      byCategory.set(cat, catEntry);
    }

    const netSavings = totalInflow - totalOutflow;
    const savingsRate =
      totalInflow > 0 ? Math.max(-999, Math.min(100, (netSavings / totalInflow) * 100)) : 0;

    return {
      totalInflow,
      totalOutflow,
      netSavings,
      savingsRate,
      inflowCount,
      outflowCount,
      bankInflow,
      cashInflow,
      cardInflow,
      bankOutflow,
      cashOutflow,
      cardOutflow,
      ccPaidFromScopeTotal,
      ccPaidFromScopeCount,
      myCardSwipesTotal,
      myCardInflowTotal,
      cashSkippedInflow,
      cashSkippedOutflow,
      wifeInflowExcluded,
      wifeOutflowExcluded,
      wifeCard2904Excluded,
      countedTxs,
      myCardSwipeTxs,
      wifeExcludedTxs,
      accountRows: Array.from(byAccount.values()).sort(
        (a, b) => b.outflow + b.inflow - (a.outflow + a.inflow)
      ),
      categoryRows: Array.from(byCategory.values()).sort(
        (a, b) => b.outflow + b.inflow - (a.outflow + a.inflow)
      ),
    };
  }, [
    transactions,
    balances,
    scope,
    selectedMonth,
    isDateRangeActive,
    dateFrom,
    dateTo,
    userRole,
    activeFamilyMemberName,
  ]);

  const filteredEntries = useMemo(() => {
    const base =
      entryTab === 'wife_excluded'
        ? stats.wifeExcludedTxs
        : entryTab === 'card_swipes'
        ? stats.myCardSwipeTxs
        : stats.countedTxs.filter((tx) => {
            if (entryTab === 'inflow') return tx.type === 'income';
            if (entryTab === 'outflow') return tx.type === 'expense';
            if (entryTab === 'cc_paid') {
              return tx.type === 'expense' && Boolean(tx.isCcPayment || tx.category === 'CC Payment');
            }
            return true;
          });

    return base.filter((tx) => {
      if (accountFilter !== 'all' && (tx.account || 'AX Bank') !== accountFilter) return false;
      if (categoryFilter !== 'all' && (tx.category || '') !== categoryFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = `${tx.description} ${tx.category} ${tx.account || ''} ${tx.paymentMethod || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [stats, entryTab, accountFilter, categoryFilter, searchQuery]);

  const filteredSubtotal = useMemo(() => {
    let inc = 0;
    let out = 0;
    for (const tx of filteredEntries) {
      if (tx.type === 'income') inc += Number(tx.amount || 0);
      else out += Number(tx.amount || 0);
    }
    return { inc, out, net: inc - out };
  }, [filteredEntries]);

  const periodLabel = isDateRangeActive
    ? `${dateFrom || 'Start'} → ${dateTo || 'Now'}`
    : selectedMonth === 'all'
    ? 'All Time'
    : selectedMonth;

  return (
    <div className="space-y-6">
      {/* Header, Scope Toggle & Date Range Filter */}
      <section className="surface-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-sky-400" />
              <h2 className="font-display text-base font-semibold text-white">
                {scope === 'banks_only'
                  ? 'Monthly Bank Bachat (My Banks Inflow − Outflow)'
                  : scope === 'banks_cash'
                  ? 'Monthly Liquid Bachat (My Banks + Cash)'
                  : 'All Cashflow (Banks + Cash + Cards − Wife)'}
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              {scope === 'banks_only'
                ? 'Sirf aapke Bank accounts me kitna aaya minus aapke Bank se kitna gaya (incl. is mahine bank se pay kiye Card bills). Card swipes next month jab bank se pay honge tab minus honge. Wife & Axis 2904 excluded.'
                : scope === 'banks_cash'
                ? 'Aapke Bank accounts + Cash wallet ka actual Inflow minus Outflow (card bills jab bank/cash se pay honge tab count honge). Wife & Axis 2904 excluded.'
                : 'Aapke saare Banks, Credit Cards & Cash ka combined Inflow minus Outflow. Wife account & Axis 2904 excluded.'}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[10px] text-slate-400 mb-1">From Date</label>
              <input
                type="date"
                aria-label="From Date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="px-2.5 py-1.5 text-xs font-mono rounded-lg field-input"
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-1">To Date</label>
              <input
                type="date"
                aria-label="To Date"
                min={dateFrom || undefined}
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="px-2.5 py-1.5 text-xs font-mono rounded-lg field-input"
              />
            </div>
            {(isDateRangeActive || accountFilter !== 'all' || categoryFilter !== 'all' || searchQuery) && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom('');
                  setDateTo('');
                  setAccountFilter('all');
                  setCategoryFilter('all');
                  setSearchQuery('');
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg h-[31px]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>

        {/* Scope Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
          <div className="inline-flex flex-wrap p-0.5 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
            {[
              { id: 'banks_only', label: 'My Banks Only (Bank Bachat)' },
              { id: 'banks_cash', label: 'My Banks + Cash' },
              { id: 'all_excl_wife', label: 'All Incl. Cards (Excl. Wife)' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setScope(opt.id as CashflowScope);
                  setAccountFilter('all');
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  scope === opt.id
                    ? 'bg-sky-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] font-mono text-slate-400">Period: {periodLabel}</span>
        </div>
      </section>

      {/* 4-Column Summary KPI Strip */}
      <section className="surface-panel rounded-xl grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            {scope === 'banks_only'
              ? `My Bank Inflow (${stats.inflowCount})`
              : scope === 'banks_cash'
              ? `Bank + Cash Inflow (${stats.inflowCount})`
              : `Total Inflow (${stats.inflowCount})`}
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
            {formatMoney(stats.totalInflow, isPrivacyMode)}
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            {scope === 'banks_only' ? (
              <span>
                Your Banks only
                {stats.cashSkippedInflow > 0
                  ? ` · Cash ${formatMoney(stats.cashSkippedInflow, isPrivacyMode)} excl.`
                  : ''}
              </span>
            ) : scope === 'banks_cash' ? (
              <span>
                Bank {formatMoney(stats.bankInflow, isPrivacyMode)} · Cash{' '}
                {formatMoney(stats.cashInflow, isPrivacyMode)}
              </span>
            ) : (
              <span>
                Bank {formatMoney(stats.bankInflow, isPrivacyMode)} · Card{' '}
                {formatMoney(stats.cardInflow, isPrivacyMode)} · Cash{' '}
                {formatMoney(stats.cashInflow, isPrivacyMode)}
              </span>
            )}
          </div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            {scope === 'banks_only'
              ? `My Bank Outflow (${stats.outflowCount})`
              : scope === 'banks_cash'
              ? `Bank + Cash Outflow (${stats.outflowCount})`
              : `Total Outflow (${stats.outflowCount})`}
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-rose-400">
            {formatMoney(stats.totalOutflow, isPrivacyMode)}
          </div>
          <div className="space-y-0.5 text-xs text-slate-500 font-mono tabular-nums">
            {scope === 'banks_only' ? (
              <div>
                Direct Bank Debits
                {stats.cashSkippedOutflow > 0
                  ? ` · Cash ${formatMoney(stats.cashSkippedOutflow, isPrivacyMode)} excl.`
                  : ''}
              </div>
            ) : scope === 'banks_cash' ? (
              <div>
                Bank {formatMoney(stats.bankOutflow, isPrivacyMode)} · Cash{' '}
                {formatMoney(stats.cashOutflow, isPrivacyMode)}
              </div>
            ) : (
              <div>
                Bank {formatMoney(stats.bankOutflow, isPrivacyMode)} · Card{' '}
                {formatMoney(stats.cardOutflow, isPrivacyMode)} · Cash{' '}
                {formatMoney(stats.cashOutflow, isPrivacyMode)}
              </div>
            )}
            {stats.ccPaidFromScopeTotal > 0 && (
              <div className="text-[11px] text-amber-300/90">
                Incl. Card Bills Paid: {formatMoney(stats.ccPaidFromScopeTotal, isPrivacyMode)} (
                {stats.ccPaidFromScopeCount})
              </div>
            )}
          </div>
        </div>

        <div className="p-5 space-y-1.5 bg-sky-500/[0.04]">
          <div className="text-xs font-semibold text-sky-300">
            {scope === 'banks_only'
              ? 'Is Mahine Ki Bank Bachat'
              : scope === 'banks_cash'
              ? 'Net Liquid Bachat (Bank + Cash)'
              : 'Total Inflow − Total Outflow'}
          </div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums ${
              stats.netSavings >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {stats.netSavings >= 0 ? '+' : ''}
            {formatMoney(stats.netSavings, isPrivacyMode)}
          </div>
          <div className="text-xs text-slate-400 font-mono tabular-nums">
            {stats.totalInflow > 0
              ? `${stats.savingsRate.toFixed(1)}% of inflow saved`
              : 'No bank inflow logged in period'}
          </div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            {scope === 'all_excl_wife'
              ? `Wife Excluded (${stats.wifeExcludedTxs.length})`
              : `Your Card Swipes (Next Month Bill)`}
          </div>
          {scope === 'all_excl_wife' ? (
            <>
              <div className="text-lg font-semibold font-mono tabular-nums text-slate-300">
                Out {formatMoney(stats.wifeOutflowExcluded, isPrivacyMode)}
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                In {formatMoney(stats.wifeInflowExcluded, isPrivacyMode)}
                {stats.wifeCard2904Excluded > 0
                  ? ` · Axis 2904 ${formatMoney(stats.wifeCard2904Excluded, isPrivacyMode)}`
                  : ''}
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-bold font-mono tabular-nums text-amber-300">
                {formatMoney(stats.myCardSwipesTotal, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-500 font-mono tabular-nums space-y-0.5">
                <div>Not deducted from this month&apos;s Bank Bachat</div>
                <div>
                  Wife &amp; Axis 2904 excl.: {formatMoney(stats.wifeOutflowExcluded, isPrivacyMode)}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Account-wise & Category-wise Breakup */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="surface-panel rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">
              Account-wise Flow ({stats.accountRows.length})
            </h3>
            {accountFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setAccountFilter('all')}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                Clear ({accountFilter})
              </button>
            )}
          </div>
          {stats.accountRows.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No counted entries in this period.</p>
          ) : (
            <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-64 overflow-y-auto">
              {stats.accountRows.map((row) => {
                const net = row.inflow - row.outflow;
                const active = accountFilter === row.account;
                return (
                  <button
                    key={row.account}
                    type="button"
                    onClick={() => setAccountFilter(active ? 'all' : row.account)}
                    className={`w-full py-2.5 px-2 flex items-center justify-between gap-3 text-xs text-left rounded transition-colors ${
                      active ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-200">{row.account}</span>
                      <span className="text-slate-500 ml-1.5">({row.count})</span>
                    </div>
                    <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                      {row.inflow > 0 && (
                        <span className="text-emerald-400">+{formatMoney(row.inflow, isPrivacyMode)}</span>
                      )}
                      {row.outflow > 0 && (
                        <span className="text-rose-400">−{formatMoney(row.outflow, isPrivacyMode)}</span>
                      )}
                      <span
                        className={`font-semibold min-w-[78px] text-right ${
                          net >= 0 ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {net >= 0 ? '+' : ''}
                        {formatMoney(net, isPrivacyMode)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="surface-panel rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">
              Category-wise Flow ({stats.categoryRows.length})
            </h3>
            {categoryFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setCategoryFilter('all')}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                Clear ({categoryFilter})
              </button>
            )}
          </div>
          {stats.categoryRows.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">No counted categories in this period.</p>
          ) : (
            <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-64 overflow-y-auto">
              {stats.categoryRows.map((row) => {
                const active = categoryFilter === row.category;
                return (
                  <button
                    key={row.category}
                    type="button"
                    onClick={() => setCategoryFilter(active ? 'all' : row.category)}
                    className={`w-full py-2.5 px-2 flex items-center justify-between gap-3 text-xs text-left rounded transition-colors ${
                      active ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-slate-200">{row.category}</span>
                      <span className="text-slate-500 ml-1.5">({row.count})</span>
                    </div>
                    <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                      {row.inflow > 0 && (
                        <span className="text-emerald-400">+{formatMoney(row.inflow, isPrivacyMode)}</span>
                      )}
                      {row.outflow > 0 && (
                        <span className="text-rose-400">−{formatMoney(row.outflow, isPrivacyMode)}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Transactions Table */}
      <section className="surface-panel rounded-xl overflow-hidden">
        <div className="p-4 sm:px-6 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap p-0.5 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
            {[
              { id: 'all', label: `All Counted (${stats.countedTxs.length})` },
              { id: 'inflow', label: `Inflows (${stats.inflowCount})` },
              { id: 'outflow', label: `Outflows (${stats.outflowCount})` },
              { id: 'cc_paid', label: `Card Bills Paid (${stats.ccPaidFromScopeCount})` },
              { id: 'card_swipes', label: `Card Swipes Deferred (${stats.myCardSwipeTxs.length})` },
              { id: 'wife_excluded', label: `Wife & 2904 Excl. (${stats.wifeExcludedTxs.length})` },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setEntryTab(t.id as CashflowEntryTab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  entryTab === t.id
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              placeholder="Search description, category, account..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg field-input"
            />
          </div>
        </div>

        {/* Live Filtered Sum Strip */}
        <div className="px-6 py-2.5 bg-[#0B0F17] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums">
          <span className="text-slate-400">
            Showing <strong className="text-slate-200">{filteredEntries.length}</strong> entries
            {entryTab === 'card_swipes' && scope !== 'all_excl_wife' && ' (Deferred until paid from Bank)'}
            {entryTab === 'wife_excluded' && ' (Excluded — Wife Bank & Axis 2904)'}
          </span>
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-emerald-400">
              Inflow +{formatMoney(filteredSubtotal.inc, isPrivacyMode)}
            </span>
            <span className="text-rose-400">
              Outflow −{formatMoney(filteredSubtotal.out, isPrivacyMode)}
            </span>
            <span
              className={
                filteredSubtotal.net >= 0 ? 'text-white font-semibold' : 'text-rose-300 font-semibold'
              }
            >
              Net {filteredSubtotal.net >= 0 ? '+' : ''}
              {formatMoney(filteredSubtotal.net, isPrivacyMode)}
            </span>
          </div>
        </div>

        {filteredEntries.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            No matching entries for the current selection.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[520px]">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-[#111827] border-b border-white/[0.08] text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-2.5 pl-6 pr-3">Date</th>
                  <th className="py-2.5 px-3">Description</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Account</th>
                  <th className="py-2.5 pr-6 pl-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filteredEntries.map((tx) => {
                  const isInc = tx.type === 'income';
                  const isCcByYou =
                    !isInc &&
                    Boolean(tx.isCcPayment || tx.category === 'CC Payment') &&
                    entryTab !== 'wife_excluded';
                  const isPayingWifeCard =
                    isCcByYou &&
                    (isWifeAccount(tx.ccSettledCardId) || /\b2904\b/.test(tx.description || ''));
                  const isWifeCardRow =
                    entryTab === 'wife_excluded' && /\b2904\b/.test(tx.account || '');
                  return (
                    <tr key={tx.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-2.5 pl-6 pr-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {formatDate(tx.date)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-200 max-w-xs truncate">
                        <div className="flex items-center gap-1.5">
                          {isInc ? (
                            <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          )}
                          <span className="truncate">{tx.description}</span>
                          {isCcByYou && (
                            <span className="text-[10px] text-amber-300 shrink-0">
                              {isPayingWifeCard ? '· Wife card bill paid' : '· Card bill paid'}
                            </span>
                          )}
                          {isWifeCardRow && (
                            <span className="text-[10px] text-slate-400 shrink-0">· Wife Card</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{tx.category}</td>
                      <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                        {tx.account || 'AX Bank'}
                      </td>
                      <td
                        className={`py-2.5 pr-6 pl-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                          isInc ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isInc ? '+' : '−'}
                        {formatMoney(tx.amount, isPrivacyMode)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
