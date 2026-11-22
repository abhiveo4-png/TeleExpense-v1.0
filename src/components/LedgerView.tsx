import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  AccountBalancesData,
  CategoryDef,
  FinancialSummary,
  InvestmentRecord,
  Transaction,
  UdhaarRecord,
  UserRole,
} from '../types';
import { ALL_ACCOUNTS } from '../utils/accounts';
import { getActiveUserId, getAuthToken } from '../utils/api';
import { formatDate, formatMoney } from '../utils/formatters';
import { CurrentWorthCard } from './CurrentWorthCard';
import { SettlementModal, SettlementPayload } from './SettlementModal';

interface LedgerViewProps {
  transactions: Transaction[];
  summary: FinancialSummary;
  categories: CategoryDef[];
  balances: AccountBalancesData | null;
  investments: InvestmentRecord[];
  udhaars: UdhaarRecord[];
  selectedMonth: string;
  userRole: UserRole;
  activeFamilyMemberName: string;
  isPrivacyMode: boolean;
  isLoading: boolean;
  onQuickParse: (text: string) => Promise<void>;
  onOpenAddModal: () => void;
  onOpenBulkImport: () => void;
  onEditTransaction: (tx: Transaction) => void;
  onDeleteTransaction: (id: string) => Promise<void>;
  onBulkDeleteTransactions: (ids: string[]) => Promise<void>;
  onUpdateCategory: (id: string, category: string) => Promise<void>;
  onToggleCategoryExclude?: (id: string, excludeFromBudget: boolean) => Promise<void>;
  onBulkToggleCategoryExclude?: (excludeFromBudget: boolean) => Promise<void>;
  onSettleReimbursement: (id: string, payload: SettlementPayload | string) => Promise<void>;
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  transactions,
  summary,
  categories,
  balances,
  investments,
  udhaars,
  selectedMonth,
  userRole,
  activeFamilyMemberName,
  isPrivacyMode,
  isLoading,
  onQuickParse,
  onOpenAddModal,
  onOpenBulkImport,
  onEditTransaction,
  onDeleteTransaction,
  onBulkDeleteTransactions,
  onUpdateCategory,
  onToggleCategoryExclude,
  onBulkToggleCategoryExclude,
  onSettleReimbursement,
}) => {
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isSpendRulesOpen, setIsSpendRulesOpen] = useState(false);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [isBulkTogglingRules, setIsBulkTogglingRules] = useState(false);
  const [spendViewMode, setSpendViewMode] = useState<'personal' | 'all_outflows'>('personal');
  const [settlingRimTx, setSettlingRimTx] = useState<Transaction | null>(null);
  const [quickInput, setQuickInput] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [parseFeedback, setParseFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');

  const PAGE_SIZE = 50;
  const [currentPage, setCurrentPage] = useState(1);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  const visibleTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) {
        return false;
      }
      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) {
          return false;
        }
      }
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false;
      if (categoryFilter !== 'all' && tx.category !== categoryFilter) return false;
      if (accountFilter !== 'all' && (tx.account || 'AX Bank') !== accountFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = `${tx.description} ${tx.category} ${tx.account || ''} ${tx.telegramUser || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, selectedMonth, userRole, activeFamilyMemberName, typeFilter, categoryFilter, accountFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(visibleTransactions.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedMonth, userRole, activeFamilyMemberName, typeFilter, categoryFilter, accountFilter, searchQuery]);

  const paginatedTransactions = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return visibleTransactions.slice(start, start + PAGE_SIZE);
  }, [visibleTransactions, safePage]);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(clamped);
    tableScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const { excludedExpenseCats, includedExpenseCats, categoryDefByLower } = useMemo(() => {
    const expenseCats = categories.filter((c) => c.type !== 'income');
    const excluded = expenseCats.filter((c) => Boolean(c.excludeFromBudget));
    const included = expenseCats.filter((c) => !c.excludeFromBudget);
    const map = new Map<string, CategoryDef>();
    for (const c of categories) {
      map.set(c.name.trim().toLowerCase(), c);
    }
    return { excludedExpenseCats: excluded, includedExpenseCats: included, categoryDefByLower: map };
  }, [categories]);

  const handleToggleRule = async (cat: CategoryDef) => {
    if (!onToggleCategoryExclude || togglingRuleId || isBulkTogglingRules) return;
    setTogglingRuleId(cat.id);
    try {
      await onToggleCategoryExclude(cat.id, !Boolean(cat.excludeFromBudget));
    } finally {
      setTogglingRuleId(null);
    }
  };

  const handleBulkToggleRules = async (excludeFromBudget: boolean) => {
    if (!onBulkToggleCategoryExclude || isBulkTogglingRules) return;
    setIsBulkTogglingRules(true);
    try {
      await onBulkToggleCategoryExclude(excludeFromBudget);
    } finally {
      setIsBulkTogglingRules(false);
    }
  };

  const periodStats = useMemo(() => {
    if (selectedMonth === 'all') {
      return {
        income: summary.totalIncome,
        expense: summary.personalExpense ?? summary.totalExpense,
        net: summary.netSavings,
        rate: summary.savingsRate,
      };
    }
    const inc = summary.currentMonthIncome ?? 0;
    const exp = summary.currentMonthPersonalExpense ?? 0;
    const net = inc - exp;
    const rate = inc > 0 ? Math.max(0, Math.min(100, (net / inc) * 100)) : 0;
    return { income: inc, expense: exp, net, rate };
  }, [summary, selectedMonth]);

  const allOutflowStats = useMemo(() => {
    let myIncome = 0;
    let myIncomeCount = 0;
    let totalKharcha = 0;
    let myOutflowCount = 0;
    let bankOutflow = 0;
    let cardOutflow = 0;
    let cashOutflow = 0;
    let wifeOutflow = 0;

    const getBucket = (rawAccount?: string): 'wife' | 'cash' | 'card' | 'bank' => {
      const accId = (rawAccount || 'AX Bank').trim();
      const lower = accId.toLowerCase();
      if (lower === 'wife') return 'wife';
      const metaType =
        balances?.accounts?.[accId]?.type ??
        ALL_ACCOUNTS.find((a) => a.id.toLowerCase() === lower)?.type;
      if (metaType === 'cash' || lower === 'cash') return 'cash';
      if (metaType === 'credit_card' || metaType === 'rupay_card' || /\b(cc|card)\b/i.test(lower)) {
        return 'card';
      }
      return 'bank';
    };

    for (const tx of transactions) {
      if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) continue;
      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) continue;
      }

      const amt = Number(tx.amount || 0);
      if (amt <= 0) continue;
      const bucket = getBucket(tx.account);

      if (tx.type === 'income') {
        const isReimbInflow = Boolean(tx.isReimbursementInflow || tx.category === 'Reimbursement');
        const isUdhaarRec = Boolean(tx.isUdhaarRecovery || tx.category === 'Udhaar Received');
        const isCcSettlementInflow = Boolean(tx.isCcPayment || tx.category === 'CC Payment');
        if (!isReimbInflow && !isUdhaarRec && !isCcSettlementInflow && bucket !== 'wife') {
          myIncome += amt;
          myIncomeCount++;
        }
      } else {
        if (bucket === 'wife') {
          wifeOutflow += amt;
        } else {
          totalKharcha += amt;
          myOutflowCount++;
          if (bucket === 'bank') bankOutflow += amt;
          else if (bucket === 'card') cardOutflow += amt;
          else cashOutflow += amt;
        }
      }
    }

    const netCashflow = myIncome - totalKharcha;
    const outflowPct = myIncome > 0 ? Math.min(999, (totalKharcha / myIncome) * 100) : 0;

    return {
      myIncome,
      myIncomeCount,
      totalKharcha,
      myOutflowCount,
      bankOutflow,
      cardOutflow,
      cashOutflow,
      wifeOutflow,
      netCashflow,
      outflowPct,
    };
  }, [transactions, balances, selectedMonth, userRole, activeFamilyMemberName]);

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim() || isParsing) return;
    setIsParsing(true);
    setParseFeedback(null);
    try {
      await onQuickParse(quickInput.trim());
      setQuickInput('');
      setParseFeedback({ type: 'ok', msg: 'Entry logged to ledger.' });
      setTimeout(() => setParseFeedback(null), 3500);
    } catch (err: any) {
      setParseFeedback({ type: 'err', msg: err?.message || 'Unable to parse entry.' });
    } finally {
      setIsParsing(false);
    }
  };

  const handleExportCsv = async () => {
    if (isExportingCsv) return;
    setIsExportingCsv(true);
    try {
      const headers: Record<string, string> = {};
      const uid = getActiveUserId();
      const token = getAuthToken();
      if (uid) headers['x-user-id'] = uid;
      if (token) headers['authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/transactions/export-csv', { headers });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disp = res.headers.get('content-disposition') || '';
      const nameMatch = disp.match(/filename="([^"]+)"/);
      a.download = nameMatch?.[1] || `teleexpense_export_${selectedMonth}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setIsExportingCsv(false);
    }
  };

  useEffect(() => {
    const validIds = new Set(transactions.map((t) => t.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [transactions]);

  const allPageSelected =
    paginatedTransactions.length > 0 && paginatedTransactions.every((t) => selectedIds.has(t.id));

  const allVisibleSelected =
    visibleTransactions.length > 0 && visibleTransactions.every((t) => selectedIds.has(t.id));

  const selectedSummary = useMemo(() => {
    let count = 0;
    let totalAmount = 0;
    for (const tx of transactions) {
      if (selectedIds.has(tx.id)) {
        count++;
        totalAmount += Number(tx.amount || 0);
      }
    }
    return { count, totalAmount };
  }, [transactions, selectedIds]);

  const toggleSelectOne = (id: string) => {
    setConfirmBulkDelete(false);
    setBulkDeleteError('');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectPage = () => {
    setConfirmBulkDelete(false);
    setBulkDeleteError('');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        paginatedTransactions.forEach((t) => next.delete(t.id));
      } else {
        paginatedTransactions.forEach((t) => next.add(t.id));
      }
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setConfirmBulkDelete(false);
    setBulkDeleteError('');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleTransactions.forEach((t) => next.delete(t.id));
      } else {
        visibleTransactions.forEach((t) => next.add(t.id));
      }
      return next;
    });
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedIds.size === 0 || isBulkDeleting) return;
    setIsBulkDeleting(true);
    setBulkDeleteError('');
    try {
      await onBulkDeleteTransactions(Array.from(selectedIds));
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    } catch (err: any) {
      setBulkDeleteError(err?.message || 'Unable to delete selected entries.');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Clickable Current Worth Card (Bank You + Wife, Cash, Investments, Udhaar, Reimbursement) */}
      <CurrentWorthCard
        balances={balances}
        investments={investments}
        udhaars={udhaars}
        transactions={transactions}
        isPrivacyMode={isPrivacyMode}
      />

      {/* 1-Click Toggle: Personal Spend (Excluded Applied) vs Total Kharcha (My Cash · Card · Bank Outflows) */}
      <div className="surface-panel rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex p-0.5 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
            <button
              type="button"
              onClick={() => setSpendViewMode('personal')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                spendViewMode === 'personal'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Personal Spend (Excluded Applied)
            </button>
            <button
              type="button"
              onClick={() => setSpendViewMode('all_outflows')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                spendViewMode === 'all_outflows'
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Include All · Total Kharcha (Cash · Card · Bank)
            </button>
          </div>
          <span className="text-[11px] text-slate-400 hidden sm:inline">
            {spendViewMode === 'all_outflows'
              ? 'Counting all outflows from your Banks, Credit Cards & Cash (Wife excluded)'
              : `${excludedExpenseCats.length} categories excluded from Personal Spend`}
          </span>
        </div>

        <button
          type="button"
          onClick={() =>
            setSpendViewMode((prev) => (prev === 'personal' ? 'all_outflows' : 'personal'))
          }
          className="text-xs font-mono tabular-nums text-slate-300 hover:text-sky-300 transition-colors whitespace-nowrap shrink-0"
        >
          {spendViewMode === 'all_outflows' ? (
            <span>
              Income {formatMoney(allOutflowStats.myIncome, isPrivacyMode)} − Kharcha{' '}
              {formatMoney(allOutflowStats.totalKharcha, isPrivacyMode)} ={' '}
              <strong
                className={
                  allOutflowStats.netCashflow >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }
              >
                {formatMoney(allOutflowStats.netCashflow, isPrivacyMode)}
              </strong>
            </span>
          ) : (
            <span>
              All Outflows (Cash/Card/Bank):{' '}
              <strong className="text-amber-300">
                {formatMoney(allOutflowStats.totalKharcha, isPrivacyMode)}
              </strong>
            </span>
          )}
        </button>
      </div>

      {/* 4-Column KPI Summary Strip (Single Elevation, Hairline Dividers) */}
      <section className="surface-panel rounded-xl grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            {selectedMonth === 'all' ? 'Lifetime Income' : 'Monthly Income'}
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
            {formatMoney(
              spendViewMode === 'all_outflows' ? allOutflowStats.myIncome : periodStats.income,
              isPrivacyMode
            )}
          </div>
          <div className="text-xs text-slate-500">
            <span>
              {spendViewMode === 'all_outflows'
                ? `${allOutflowStats.myIncomeCount} inflows (my accounts)`
                : `${summary.incomeCount} inflows`}
            </span>
            <span className="mx-1.5">·</span>
            <span>Excludes claims &amp; recoveries</span>
          </div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-400">
              {spendViewMode === 'all_outflows'
                ? 'Total Kharcha (All Outflows)'
                : 'Personal Spend'}
            </span>
            <button
              type="button"
              onClick={() => setIsSpendRulesOpen(true)}
              className="text-[11px] font-medium text-amber-300 hover:text-amber-200 underline decoration-amber-400/40 underline-offset-2 whitespace-nowrap"
            >
              Excluded ({excludedExpenseCats.length}) · Mark
            </button>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-rose-400">
            {formatMoney(
              spendViewMode === 'all_outflows' ? allOutflowStats.totalKharcha : periodStats.expense,
              isPrivacyMode
            )}
          </div>
          {spendViewMode === 'all_outflows' ? (
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              <span>Bank {formatMoney(allOutflowStats.bankOutflow, isPrivacyMode)}</span>
              <span className="mx-1.5">·</span>
              <span>Card {formatMoney(allOutflowStats.cardOutflow, isPrivacyMode)}</span>
              <span className="mx-1.5">·</span>
              <span>Cash {formatMoney(allOutflowStats.cashOutflow, isPrivacyMode)}</span>
              {allOutflowStats.wifeOutflow > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="text-slate-600">
                    Wife {formatMoney(allOutflowStats.wifeOutflow, isPrivacyMode)} excl.
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              <span>Avg {formatMoney(summary.dailyAverageExpense || 0, isPrivacyMode)}/day</span>
              <span className="mx-1.5">·</span>
              <span>Budget {formatMoney(summary.monthlyBudget || 0, isPrivacyMode)}</span>
            </div>
          )}
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">
            {spendViewMode === 'all_outflows' ? 'Total Income − Total Kharcha' : 'Net Surplus'}
          </div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums ${
              (spendViewMode === 'all_outflows' ? allOutflowStats.netCashflow : periodStats.net) >= 0
                ? 'text-white'
                : 'text-rose-400'
            }`}
          >
            {formatMoney(
              spendViewMode === 'all_outflows' ? allOutflowStats.netCashflow : periodStats.net,
              isPrivacyMode
            )}
          </div>
          {spendViewMode === 'all_outflows' ? (
            <div className="text-xs text-slate-500">
              <span>{allOutflowStats.outflowPct.toFixed(1)}% of income outflow</span>
              <span className="mx-1.5">·</span>
              <span>Personal only {formatMoney(periodStats.expense, isPrivacyMode)}</span>
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              <span>{periodStats.rate.toFixed(1)}% savings rate</span>
              <span className="mx-1.5">·</span>
              <span>Pending claims {formatMoney(summary.pendingReimbursements || 0, isPrivacyMode)}</span>
            </div>
          )}
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs font-medium text-slate-400">Liquid Bank &amp; Cash</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-sky-400">
            {formatMoney(balances?.totalBankCashBalance ?? summary.totalCashBalance ?? 0, isPrivacyMode)}
          </div>
          <div className="text-xs text-slate-500">
            <span>Card dues {formatMoney(balances?.totalCardOutstanding ?? 0, isPrivacyMode)}</span>
            <span className="mx-1.5">·</span>
            <span>Udhaar {formatMoney(summary.pendingUdhaarBakaya || 0, isPrivacyMode)}</span>
          </div>
        </div>
      </section>

      {/* Quick Smart Entry Input */}
      <section className="surface-panel rounded-xl p-4 sm:p-5">
        <form onSubmit={handleQuickSubmit} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Sparkles className="w-4 h-4 text-sky-400 absolute left-3.5 top-3.5 pointer-events-none" />
            <input
              type="text"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              placeholder='Quick parse: "240 chai samosa cash", "rim 1200 cab icici 0000", "salary 85000 ax bank"'
              className="w-full pl-10 pr-4 py-2.5 text-sm rounded-lg field-input"
            />
          </div>
          <button
            type="submit"
            disabled={isParsing || !quickInput.trim()}
            className="px-5 py-2.5 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {isParsing ? 'Parsing...' : 'Quick Log'}
          </button>
        </form>
        {parseFeedback && (
          <p className={`mt-2 text-xs ${parseFeedback.type === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {parseFeedback.msg}
          </p>
        )}
      </section>

      {/* Ledger Filters & Table */}
      <section className="surface-panel rounded-xl overflow-hidden">
        <div className="p-4 sm:px-6 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[240px]">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search description, member..."
                className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg field-input"
              />
            </div>

            <div className="inline-flex p-0.5 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
              {(['all', 'expense', 'income'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter(t)}
                  className={`px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors ${
                    typeFilter === t ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <select
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-1.5 text-xs rounded-lg field-input"
            >
              <option value="all" className="bg-[#111827]">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name} className="bg-[#111827]">
                  {c.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by account"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="px-3 py-1.5 text-xs rounded-lg field-input"
            >
              <option value="all" className="bg-[#111827]">All Accounts</option>
              {ALL_ACCOUNTS.map((a) => (
                <option key={a.id} value={a.id} className="bg-[#111827]">
                  {a.shortName}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="text-xs text-slate-400 font-mono tabular-nums whitespace-nowrap">
              {visibleTransactions.length} entries
            </span>
            <button
              type="button"
              onClick={onOpenBulkImport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Bulk Import</span>
            </button>
            <button
              type="button"
              disabled={isExportingCsv || transactions.length === 0}
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0E1420] hover:bg-slate-800 border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-45"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingCsv ? 'Exporting...' : 'Export CSV'}</span>
            </button>
          </div>
        </div>

        {selectedSummary.count > 0 && (
          <div className="px-4 sm:px-6 py-2.5 bg-[#0E1420] border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-mono tabular-nums font-semibold text-white">
                {selectedSummary.count} selected
              </span>
              <span className="text-slate-500">·</span>
              <span className="font-mono tabular-nums text-slate-300">
                Total {formatMoney(selectedSummary.totalAmount, isPrivacyMode)}
              </span>
              {!allVisibleSelected && visibleTransactions.length > 1 && (
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  className="text-sky-400 hover:text-sky-300 font-medium whitespace-nowrap"
                >
                  Select all {visibleTransactions.length} filtered
                </button>
              )}
              {bulkDeleteError && (
                <span className="text-rose-400">{bulkDeleteError}</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isBulkDeleting}
                onClick={() => {
                  setSelectedIds(new Set());
                  setConfirmBulkDelete(false);
                  setBulkDeleteError('');
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white rounded-md whitespace-nowrap"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>

              {!confirmBulkDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-200 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Selected ({selectedSummary.count})</span>
                </button>
              ) : (
                <div className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isBulkDeleting}
                    onClick={() => setConfirmBulkDelete(false)}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg whitespace-nowrap"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isBulkDeleting}
                    onClick={handleConfirmBulkDelete}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isBulkDeleting ? 'Deleting...' : `Confirm Delete (${selectedSummary.count})`}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="divide-y divide-white/[0.06]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-6 py-4 flex items-center justify-between gap-4 animate-pulse">
                <div className="space-y-2 flex-1">
                  <div className="h-4 bg-slate-800 rounded w-1/3" />
                  <div className="h-3 bg-slate-800/70 rounded w-1/4" />
                </div>
                <div className="h-4 bg-slate-800 rounded w-20" />
              </div>
            ))}
          </div>
        ) : visibleTransactions.length === 0 ? (
          <div className="py-16 px-6 text-center space-y-3">
            <h3 className="text-sm font-semibold text-white">No transactions found</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {transactions.length === 0
                ? 'Log your first expense or income using the quick parser above, or send a message to your connected Telegram bot.'
                : 'Adjust your month, search term, or account filters to inspect other entries.'}
            </p>
            <div className="pt-2 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onOpenAddModal}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap"
              >
                Log First Entry
              </button>
              <button
                type="button"
                onClick={onOpenBulkImport}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg transition-colors whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Bulk Upload CSV / Grid</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={tableScrollRef}
              className="overflow-auto max-h-[min(560px,62vh)] border-b border-white/[0.06]"
            >
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-[#0E1420] shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]">
                  <tr className="text-xs font-medium text-slate-400">
                    <th className="py-3 pl-6 pr-2 w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all entries on this page"
                        checked={allPageSelected}
                        onChange={toggleSelectPage}
                        className="rounded border-slate-600 bg-slate-900 text-sky-400 focus:ring-sky-400 cursor-pointer"
                      />
                    </th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4">Account</th>
                    <th className="py-3 px-4 text-right">Amount</th>
                    <th className="py-3 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-sm">
                  {paginatedTransactions.map((tx) => {
                    const isReimbPending = tx.isReimbursement && tx.reimbursementStatus !== 'settled';
                    const isSelected = selectedIds.has(tx.id);
                    const matchedCatDef = categoryDefByLower.get((tx.category || '').trim().toLowerCase());
                    const isExcludedFromSpend =
                      tx.type === 'expense' &&
                      (matchedCatDef?.excludeFromBudget === true
                        ? true
                        : matchedCatDef?.excludeFromBudget === false
                        ? false
                        : Boolean(
                            tx.isReimbursement ||
                              tx.isCcPayment ||
                              tx.isUdhaarLent ||
                              tx.isWifeTransfer ||
                              tx.isSavingsTransfer
                          ));
                    return (
                      <tr
                        key={tx.id}
                        className={`transition-colors ${
                          isSelected ? 'bg-sky-500/[0.06]' : 'hover:bg-white/[0.02]'
                        }`}
                      >
                        <td className="py-3 pl-6 pr-2 w-10">
                          <input
                            type="checkbox"
                            aria-label={`Select ${tx.description}`}
                            checked={isSelected}
                            onChange={() => toggleSelectOne(tx.id)}
                            className="rounded border-slate-600 bg-slate-900 text-sky-400 focus:ring-sky-400 cursor-pointer"
                          />
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap font-mono tabular-nums text-xs text-slate-400">
                          <div>{formatDate(tx.date)}</div>
                          {tx.time && <div className="text-[11px] text-slate-500">{tx.time}</div>}
                        </td>
                        <td className="py-3 px-4 min-w-[200px]">
                          <div className="font-medium text-slate-100">{tx.description}</div>
                          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5 mt-0.5">
                            <span>{tx.paymentMethod || 'UPI'}</span>
                            <span>·</span>
                            <span className="capitalize">{tx.source}</span>
                            {tx.telegramUser && (
                              <>
                                <span>·</span>
                                <span>{tx.telegramUser}</span>
                              </>
                            )}
                            {isExcludedFromSpend && (
                              <>
                                <span>·</span>
                                <span className="text-amber-300/90 font-medium">Excluded from Spend</span>
                              </>
                            )}
                            {isReimbPending && (
                              <>
                                <span>·</span>
                                <span className="text-amber-400 font-medium">
                                  {tx.reimbursementStatus === 'partial'
                                    ? `Partial · ${formatMoney(
                                        Math.max(0, Number(tx.amount) - Number(tx.reimbursementSettledAmount || 0)),
                                        isPrivacyMode
                                      )} left`
                                    : 'Claim Pending'}
                                </span>
                              </>
                            )}
                            {tx.isReimbursement && tx.reimbursementStatus === 'settled' && (
                              <>
                                <span>·</span>
                                <span className="text-emerald-400 font-medium">
                                  Claim Settled{tx.settledInAccount ? ` (${tx.settledInAccount})` : ''}
                                </span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <select
                            aria-label={`Category for ${tx.description}`}
                            value={tx.category}
                            onChange={(e) => onUpdateCategory(tx.id, e.target.value)}
                            className="bg-transparent text-xs text-slate-300 border border-white/[0.08] rounded-md px-2 py-1 focus:outline-none focus:border-sky-400"
                          >
                            {categories
                              .filter((c) => c.type === tx.type || c.type === 'both')
                              .map((c) => (
                                <option key={c.id} value={c.name} className="bg-[#111827]">
                                  {c.excludeFromBudget && tx.type === 'expense' ? `${c.name} (Excluded)` : c.name}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap text-xs text-slate-300">
                          {tx.account || 'AX Bank'}
                        </td>
                        <td
                          className={`py-3 px-4 whitespace-nowrap text-right font-mono tabular-nums font-semibold ${
                            tx.type === 'income' ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {tx.type === 'income' ? '+' : '-'}
                          {formatMoney(tx.amount, isPrivacyMode)}
                        </td>
                        <td className="py-3 px-6 whitespace-nowrap text-right">
                          <div className="inline-flex items-center gap-1">
                            {isReimbPending && (
                              <button
                                type="button"
                                onClick={() => setSettlingRimTx(tx)}
                                title="Settle reimbursement (Partial or Full)"
                                className="p-1.5 text-emerald-400 hover:bg-emerald-500/10 rounded-md transition-colors"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onEditTransaction(tx)}
                              aria-label="Edit transaction"
                              className="p-1.5 text-slate-400 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteTransaction(tx.id)}
                              aria-label="Delete transaction"
                              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-md transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 sm:px-6 py-3 bg-[#0E1420] flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-400 font-mono tabular-nums">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, visibleTransactions.length)} of{' '}
                {visibleTransactions.length} entries
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => goToPage(safePage - 1)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#111827] border border-white/[0.08] rounded-lg disabled:opacity-40 whitespace-nowrap"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Prev</span>
                  </button>

                  {Array.from({ length: totalPages }, (_, idx) => idx + 1)
                    .filter(
                      (p) =>
                        p === 1 ||
                        p === totalPages ||
                        Math.abs(p - safePage) <= 1
                    )
                    .reduce<(number | 'dots')[]>((acc, p, i, arr) => {
                      if (i > 0 && p - arr[i - 1] > 1) acc.push('dots');
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === 'dots' ? (
                        <span key={`dots-${idx}`} className="px-1.5 text-xs text-slate-500">
                          ...
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          onClick={() => goToPage(item)}
                          className={`min-w-[30px] px-2.5 py-1.5 text-xs font-mono tabular-nums font-medium rounded-lg border transition-colors ${
                            item === safePage
                              ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                              : 'bg-[#111827] text-slate-300 hover:text-white border-white/[0.08]'
                          }`}
                        >
                          {item}
                        </button>
                      )
                    )}

                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => goToPage(safePage + 1)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#111827] border border-white/[0.08] rounded-lg disabled:opacity-40 whitespace-nowrap"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {isSpendRulesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
          onClick={() => setIsSpendRulesOpen(false)}
        >
          <div
            className="surface-panel rounded-xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
              <div>
                <h2 className="font-display text-base font-semibold text-white">
                  Personal Spend Category Rules
                </h2>
                <p className="text-xs text-slate-400">
                  Mark or unmark which expense categories are excluded from Personal Spend &amp; Budget totals.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSpendRulesOpen(false)}
                aria-label="Close personal spend category rules"
                className="p-1.5 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {onBulkToggleCategoryExclude && (
                <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-white/[0.08]">
                  <span className="text-xs text-slate-400">
                    One-click bulk action for all expense categories:
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isBulkTogglingRules || excludedExpenseCats.length === 0}
                      onClick={() => handleBulkToggleRules(false)}
                      className="px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 rounded-md whitespace-nowrap disabled:opacity-45"
                    >
                      {isBulkTogglingRules ? 'Updating...' : 'Include All'}
                    </button>
                    <button
                      type="button"
                      disabled={isBulkTogglingRules || includedExpenseCats.length === 0}
                      onClick={() => handleBulkToggleRules(true)}
                      className="px-3 py-1.5 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 rounded-md whitespace-nowrap disabled:opacity-45"
                    >
                      {isBulkTogglingRules ? 'Updating...' : 'Exclude All'}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-300">
                  <span>Excluded from Personal Spend ({excludedExpenseCats.length})</span>
                  <span className="text-[11px] font-normal text-slate-400">Not added to Personal Spend</span>
                </div>
                {excludedExpenseCats.length === 0 ? (
                  <p className="text-xs text-slate-500">No excluded categories.</p>
                ) : (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                    {excludedExpenseCats.map((cat) => (
                      <div key={cat.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ backgroundColor: cat.color || '#F59E0B' }}
                          />
                          <span className="text-slate-100 font-medium truncate">{cat.name}</span>
                        </div>
                        <button
                          type="button"
                          disabled={togglingRuleId === cat.id || !onToggleCategoryExclude}
                          onClick={() => handleToggleRule(cat)}
                          className="px-2.5 py-1 text-[11px] font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 rounded-md whitespace-nowrap disabled:opacity-50"
                        >
                          {togglingRuleId === cat.id ? 'Updating...' : 'Include in Spend'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-300">
                  <span>Included in Personal Spend ({includedExpenseCats.length})</span>
                  <span className="text-[11px] font-normal text-slate-400">Counted in Personal Spend</span>
                </div>
                {includedExpenseCats.length === 0 ? (
                  <p className="text-xs text-slate-500">No included expense categories.</p>
                ) : (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                    {includedExpenseCats.map((cat) => (
                      <div key={cat.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ backgroundColor: cat.color || '#10B981' }}
                          />
                          <span className="text-slate-200 font-medium truncate">{cat.name}</span>
                        </div>
                        <button
                          type="button"
                          disabled={togglingRuleId === cat.id || !onToggleCategoryExclude}
                          onClick={() => handleToggleRule(cat)}
                          className="px-2.5 py-1 text-[11px] font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 rounded-md whitespace-nowrap disabled:opacity-50"
                        >
                          {togglingRuleId === cat.id ? 'Updating...' : 'Exclude from Spend'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3.5 border-t border-white/[0.08] bg-[#0B0F17] flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11px] text-slate-400">
                Manage keywords &amp; limits in Budgets &amp; Gullak → Categories.
              </span>
              <button
                type="button"
                onClick={() => setIsSpendRulesOpen(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
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
        defaultAccount={settlingRimTx?.settledInAccount || 'AX Bank'}
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
