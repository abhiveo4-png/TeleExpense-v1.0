import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  AccountBalanceInfo,
  AccountBalancesData,
  CategoryDef,
  FinancialSummary,
  InvestmentRecord,
  Transaction,
  UdhaarRecord,
  UserRole,
} from '../types';
import { ALL_ACCOUNTS, isWifeAccount } from '../utils/accounts';
import { getActiveUserId, getAuthToken } from '../utils/api';
import { formatDate, formatMoney, getCurrentIstDate } from '../utils/formatters';
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
  const [flowBreakupModal, setFlowBreakupModal] = useState<'inflow' | 'outflow' | null>(null);
  const [flowBreakupSearch, setFlowBreakupSearch] = useState('');
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
  const [categorySpendMode, setCategorySpendMode] = useState<'all' | 'included' | 'excluded'>('all');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sortBy, setSortBy] = useState<
    'default' | 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'
  >('default');

  type HeaderFilterCol = 'date' | 'description' | 'category' | 'account' | 'amount';
  const [openHeaderFilter, setOpenHeaderFilter] = useState<HeaderFilterCol | null>(null);
  const [catPopoverSearch, setCatPopoverSearch] = useState('');
  const [accPopoverSearch, setAccPopoverSearch] = useState('');
  const theadRef = useRef<HTMLTableSectionElement | null>(null);

  const PAGE_SIZE = 50;
  const [currentPage, setCurrentPage] = useState(1);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openHeaderFilter) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (theadRef.current && !theadRef.current.contains(e.target as Node)) {
        setOpenHeaderFilter(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenHeaderFilter(null);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openHeaderFilter]);

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

  const accountFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of ALL_ACCOUNTS) {
      seen.set(a.id, a.shortName);
    }
    if (balances?.accounts) {
      for (const acc of Object.values(balances.accounts) as AccountBalanceInfo[]) {
        if (acc?.accountId && !seen.has(acc.accountId)) {
          seen.set(acc.accountId, acc.shortName || acc.name || acc.accountId);
        }
      }
    }
    for (const tx of transactions) {
      const id = tx.account || 'AX Bank';
      if (!seen.has(id)) {
        seen.set(id, id);
      }
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [balances, transactions]);

  const categoryFilterOptions = useMemo(() => {
    const names = new Set<string>(categories.map((c) => c.name));
    for (const tx of transactions) {
      if (tx.category) names.add(tx.category);
    }
    return Array.from(names);
  }, [categories, transactions]);

  const isDateRangeActive = Boolean(dateFrom || dateTo);
  const isCategoryFilterActive =
    categorySpendMode !== 'all' || selectedCategories.length > 0;
  const isAccountFilterActive = selectedAccounts.length > 0;
  const isDescriptionFilterActive = Boolean(
    searchQuery.trim() || sourceFilter !== 'all'
  );
  const isAmountFilterActive = Boolean(
    typeFilter !== 'all' ||
      minAmount.trim() ||
      maxAmount.trim() ||
      sortBy === 'amount_asc' ||
      sortBy === 'amount_desc'
  );
  const isDateHeaderActive = Boolean(
    isDateRangeActive || sortBy === 'date_asc' || sortBy === 'date_desc'
  );

  const hasActiveFilters = Boolean(
    isDescriptionFilterActive ||
      isCategoryFilterActive ||
      isAccountFilterActive ||
      isAmountFilterActive ||
      isDateHeaderActive
  );

  const clearAllFilters = () => {
    setSearchQuery('');
    setTypeFilter('all');
    setCategorySpendMode('all');
    setSelectedCategories([]);
    setSelectedAccounts([]);
    setDateFrom('');
    setDateTo('');
    setSourceFilter('all');
    setMinAmount('');
    setMaxAmount('');
    setSortBy('default');
    setOpenHeaderFilter(null);
  };

  const toggleCategorySelection = (catName: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catName) ? prev.filter((c) => c !== catName) : [...prev, catName]
    );
  };

  const toggleAccountSelection = (accId: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(accId) ? prev.filter((a) => a !== accId) : [...prev, accId]
    );
  };

  const applyDatePreset = (preset: 'today' | '7d' | '30d' | 'this_month' | 'last_month') => {
    const todayStr = getCurrentIstDate();
    const [y, m, d] = todayStr.split('-').map(Number);
    const pad = (n: number) => String(n).padStart(2, '0');
    const toYmd = (dt: Date) =>
      `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

    if (preset === 'today') {
      setDateFrom(todayStr);
      setDateTo(todayStr);
      return;
    }
    if (preset === '7d') {
      const start = new Date(y, m - 1, d - 6);
      setDateFrom(toYmd(start));
      setDateTo(todayStr);
      return;
    }
    if (preset === '30d') {
      const start = new Date(y, m - 1, d - 29);
      setDateFrom(toYmd(start));
      setDateTo(todayStr);
      return;
    }
    if (preset === 'this_month') {
      setDateFrom(`${y}-${pad(m)}-01`);
      setDateTo(todayStr);
      return;
    }
    if (preset === 'last_month') {
      const start = new Date(y, m - 2, 1);
      const end = new Date(y, m - 1, 0);
      setDateFrom(toYmd(start));
      setDateTo(toYmd(end));
    }
  };

  const isTxExcludedFromSpend = (tx: Transaction): boolean => {
    if (tx.type !== 'expense') return false;
    const matchedCatDef = categoryDefByLower.get((tx.category || '').trim().toLowerCase());
    if (matchedCatDef?.excludeFromBudget === true) return true;
    if (matchedCatDef?.excludeFromBudget === false) return false;
    return Boolean(
      tx.isReimbursement ||
        tx.isCcPayment ||
        tx.isUdhaarLent ||
        tx.isWifeTransfer ||
        tx.isSavingsTransfer
    );
  };

  const visibleTransactions = useMemo(() => {
    const minVal = minAmount.trim() !== '' ? Number(minAmount) : null;
    const maxVal = maxAmount.trim() !== '' ? Number(maxAmount) : null;
    const selectedCatSet = selectedCategories.length > 0 ? new Set(selectedCategories) : null;
    const selectedAccSet = selectedAccounts.length > 0 ? new Set(selectedAccounts) : null;

    const filtered = transactions.filter((tx) => {
      if (isDateRangeActive) {
        const d = tx.date || '';
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      } else if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) {
        return false;
      }

      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) {
          return false;
        }
      }
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false;

      if (categorySpendMode === 'excluded' && !isTxExcludedFromSpend(tx)) return false;
      if (categorySpendMode === 'included' && (tx.type !== 'expense' || isTxExcludedFromSpend(tx))) {
        return false;
      }
      if (selectedCatSet && !selectedCatSet.has(tx.category)) return false;

      if (selectedAccSet && !selectedAccSet.has(tx.account || 'AX Bank')) return false;

      if (sourceFilter === 'reimbursement') {
        if (!tx.isReimbursement && tx.category !== 'Reimbursement') return false;
      } else if (sourceFilter === 'reimb_pending') {
        if (!tx.isReimbursement || tx.reimbursementStatus === 'settled') return false;
      } else if (sourceFilter !== 'all') {
        if ((tx.source || '').toLowerCase() !== sourceFilter.toLowerCase()) return false;
      }

      const amt = Number(tx.amount || 0);
      if (minVal !== null && Number.isFinite(minVal) && amt < minVal) return false;
      if (maxVal !== null && Number.isFinite(maxVal) && amt > maxVal) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = `${tx.description} ${tx.category} ${tx.account || ''} ${tx.telegramUser || ''} ${tx.paymentMethod || ''} ${tx.source || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (sortBy === 'default') return filtered;

    return [...filtered].sort((a, b) => {
      if (sortBy === 'date_asc') {
        const cmp = (a.date || '').localeCompare(b.date || '');
        return cmp !== 0 ? cmp : (a.time || '').localeCompare(b.time || '');
      }
      if (sortBy === 'date_desc') {
        const cmp = (b.date || '').localeCompare(a.date || '');
        return cmp !== 0 ? cmp : (b.time || '').localeCompare(a.time || '');
      }
      if (sortBy === 'amount_desc') {
        return Number(b.amount || 0) - Number(a.amount || 0);
      }
      return Number(a.amount || 0) - Number(b.amount || 0);
    });
  }, [
    transactions,
    selectedMonth,
    isDateRangeActive,
    dateFrom,
    dateTo,
    userRole,
    activeFamilyMemberName,
    typeFilter,
    categorySpendMode,
    selectedCategories,
    selectedAccounts,
    sourceFilter,
    minAmount,
    maxAmount,
    searchQuery,
    sortBy,
    categoryDefByLower,
  ]);

  const filteredStats = useMemo(() => {
    let incomeSum = 0;
    let incomeCount = 0;
    let expenseSum = 0;
    let expenseCount = 0;
    let pendingRimSum = 0;

    for (const tx of visibleTransactions) {
      const amt = Number(tx.amount || 0);
      if (tx.type === 'income') {
        incomeSum += amt;
        incomeCount++;
      } else {
        expenseSum += amt;
        expenseCount++;
        if (tx.isReimbursement && tx.reimbursementStatus !== 'settled') {
          pendingRimSum += Math.max(0, amt - Number(tx.reimbursementSettledAmount || 0));
        }
      }
    }

    return {
      count: visibleTransactions.length,
      incomeSum,
      incomeCount,
      expenseSum,
      expenseCount,
      netSum: incomeSum - expenseSum,
      pendingRimSum,
    };
  }, [visibleTransactions]);

  const totalPages = Math.max(1, Math.ceil(visibleTransactions.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    selectedMonth,
    dateFrom,
    dateTo,
    userRole,
    activeFamilyMemberName,
    typeFilter,
    categorySpendMode,
    selectedCategories,
    selectedAccounts,
    sourceFilter,
    minAmount,
    maxAmount,
    searchQuery,
    sortBy,
  ]);

  const paginatedTransactions = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return visibleTransactions.slice(start, start + PAGE_SIZE);
  }, [visibleTransactions, safePage]);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(clamped);
    tableScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // categoryDefByLower & spend rule sets computed above for both filter and badges

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
    let bankInflow = 0;
    let cardInflow = 0;
    let cashInflow = 0;
    let wifeInflow = 0;
    let totalKharcha = 0;
    let myOutflowCount = 0;
    let bankOutflow = 0;
    let cardOutflow = 0;
    let cashOutflow = 0;
    let wifeOutflow = 0;
    let ccSettledOutflow = 0;
    let ccSettledCount = 0;
    let udhaarOutflow = 0;

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

    for (const tx of transactions) {
      if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) continue;
      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) continue;
      }

      const amt = Number(tx.amount || 0);
      if (amt <= 0) continue;
      const bucket = getBucket(tx.account);
      const isCcSettle = Boolean(tx.isCcPayment || tx.category === 'CC Payment');
      const isPayingWifeCard =
        isCcSettle &&
        (isWifeAccount(tx.ccSettledCardId) || /\b2904\b/.test(tx.description || ''));

      if (tx.type === 'income') {
        if (bucket === 'wife') {
          wifeInflow += amt;
        } else {
          myIncome += amt;
          myIncomeCount++;
          if (bucket === 'bank') bankInflow += amt;
          else if (bucket === 'card') cardInflow += amt;
          else cashInflow += amt;
        }
      } else {
        if (bucket === 'wife') {
          wifeOutflow += amt;
        } else if (isCcSettle && !isPayingWifeCard) {
          // Internal Bank/Cash -> Own Credit Card bill settlement: excluded from Include All Total Kharcha
          // so original card spends/udhaar are never double-counted. (Paying Wife's Axis 2904 from your
          // own bank counts as an outflow since Axis 2904 spends are excluded under Wife.)
          ccSettledOutflow += amt;
          ccSettledCount++;
        } else {
          totalKharcha += amt;
          myOutflowCount++;
          if (bucket === 'bank') bankOutflow += amt;
          else if (bucket === 'card') cardOutflow += amt;
          else cashOutflow += amt;
          if (Boolean(tx.isUdhaarLent || tx.category === 'Udhaar Given')) {
            udhaarOutflow += amt;
          }
        }
      }
    }

    const netCashflow = myIncome - totalKharcha;
    const outflowPct = myIncome > 0 ? Math.min(999, (totalKharcha / myIncome) * 100) : 0;

    return {
      myIncome,
      myIncomeCount,
      bankInflow,
      cardInflow,
      cashInflow,
      wifeInflow,
      totalKharcha,
      myOutflowCount,
      bankOutflow,
      cardOutflow,
      cashOutflow,
      wifeOutflow,
      ccSettledOutflow,
      ccSettledCount,
      udhaarOutflow,
      netCashflow,
      outflowPct,
    };
  }, [transactions, balances, selectedMonth, userRole, activeFamilyMemberName]);

  const flowBreakupData = useMemo(() => {
    if (!flowBreakupModal) return null;

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

    const isInflowView = flowBreakupModal === 'inflow';
    const targetType = isInflowView ? 'income' : 'expense';
    const includeAll = spendViewMode === 'all_outflows';

    const byAccount = new Map<
      string,
      { account: string; bucket: 'wife' | 'cash' | 'card' | 'bank'; total: number; count: number }
    >();
    const byCategory = new Map<
      string,
      { category: string; total: number; count: number; isExcluded: boolean }
    >();
    const includedTxs: Transaction[] = [];
    const excludedTxs: Transaction[] = [];

    let includedTotal = 0;
    let excludedTotal = 0;
    let bankTotal = 0;
    let cardTotal = 0;
    let cashTotal = 0;
    let wifeExcludedTotal = 0;
    let ccSettledExcludedTotal = 0;

    for (const tx of transactions) {
      if (selectedMonth !== 'all' && (!tx.date || !tx.date.startsWith(selectedMonth))) continue;
      if (userRole === 'family' && activeFamilyMemberName) {
        const sender = (tx.telegramUser || '').toLowerCase();
        if (sender && !sender.includes(activeFamilyMemberName.toLowerCase())) continue;
      }
      if (tx.type !== targetType) continue;

      const amt = Number(tx.amount || 0);
      if (amt <= 0) continue;

      const acc = tx.account || 'AX Bank';
      const bucket = getBucket(acc);

      if (includeAll && bucket === 'wife') {
        wifeExcludedTotal += amt;
        excludedTotal += amt;
        excludedTxs.push(tx);
        continue;
      }

      let isExcludedEntry = false;
      const isInternalCcSettle =
        !isInflowView && Boolean(tx.isCcPayment || tx.category === 'CC Payment');
      const isPayingWifeCard =
        isInternalCcSettle &&
        (isWifeAccount(tx.ccSettledCardId) || /\b2904\b/.test(tx.description || ''));
      if (!includeAll) {
        if (isInflowView) {
          const isReimbInflow = Boolean(tx.isReimbursementInflow || tx.category === 'Reimbursement');
          const isUdhaarRec = Boolean(tx.isUdhaarRecovery || tx.category === 'Udhaar Received');
          const isCcSettle = Boolean(tx.isCcPayment || tx.category === 'CC Payment');
          if (isReimbInflow || isUdhaarRec || isCcSettle) {
            isExcludedEntry = true;
          }
        } else {
          isExcludedEntry = isTxExcludedFromSpend(tx);
          if (isInternalCcSettle) ccSettledExcludedTotal += amt;
        }
      } else if (isInternalCcSettle && !isPayingWifeCard) {
        isExcludedEntry = true;
        ccSettledExcludedTotal += amt;
      }

      if (isExcludedEntry) {
        if (bucket === 'wife') wifeExcludedTotal += amt;
        excludedTotal += amt;
        excludedTxs.push(tx);
        continue;
      }

      includedTotal += amt;
      includedTxs.push(tx);
      if (bucket === 'bank') bankTotal += amt;
      else if (bucket === 'card') cardTotal += amt;
      else if (bucket === 'cash') cashTotal += amt;

      const accEntry = byAccount.get(acc) || { account: acc, bucket, total: 0, count: 0 };
      accEntry.total += amt;
      accEntry.count += 1;
      byAccount.set(acc, accEntry);

      const catName = tx.category || (isInflowView ? 'Other Income' : 'Other Expense');
      const catEntry = byCategory.get(catName) || {
        category: catName,
        total: 0,
        count: 0,
        isExcluded: !isInflowView && isTxExcludedFromSpend(tx),
      };
      catEntry.total += amt;
      catEntry.count += 1;
      byCategory.set(catName, catEntry);
    }

    const accountList = Array.from(byAccount.values()).sort((a, b) => b.total - a.total);
    const categoryList = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);

    return {
      isInflowView,
      includeAll,
      includedTotal,
      excludedTotal,
      bankTotal,
      cardTotal,
      cashTotal,
      wifeExcludedTotal,
      ccSettledExcludedTotal,
      accountList,
      categoryList,
      includedTxs,
      excludedTxs,
    };
  }, [
    flowBreakupModal,
    spendViewMode,
    transactions,
    balances,
    selectedMonth,
    userRole,
    activeFamilyMemberName,
    categoryDefByLower,
  ]);

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
              ? 'Counting Cash, Card & Bank outflows incl. Udhaar (Bank→Card CC bills & Wife excl. to avoid 2×)'
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
              Inflow {formatMoney(allOutflowStats.myIncome, isPrivacyMode)} − Outflow{' '}
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
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setFlowBreakupSearch('');
            setFlowBreakupModal('inflow');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFlowBreakupSearch('');
              setFlowBreakupModal('inflow');
            }
          }}
          className="p-5 space-y-1.5 cursor-pointer hover:bg-white/[0.025] transition-colors group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-400">
              {spendViewMode === 'all_outflows'
                ? 'Total Inflow (All Sources)'
                : selectedMonth === 'all'
                ? 'Lifetime Income'
                : 'Monthly Income'}
            </span>
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-400/80 group-hover:text-sky-300">
              <span>Breakup</span>
              <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
            {formatMoney(
              spendViewMode === 'all_outflows' ? allOutflowStats.myIncome : periodStats.income,
              isPrivacyMode
            )}
          </div>
          {spendViewMode === 'all_outflows' ? (
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              <span>Bank {formatMoney(allOutflowStats.bankInflow, isPrivacyMode)}</span>
              <span className="mx-1.5">·</span>
              <span>Card {formatMoney(allOutflowStats.cardInflow, isPrivacyMode)}</span>
              <span className="mx-1.5">·</span>
              <span>Cash {formatMoney(allOutflowStats.cashInflow, isPrivacyMode)}</span>
              {allOutflowStats.wifeInflow > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="text-slate-600">
                    Wife {formatMoney(allOutflowStats.wifeInflow, isPrivacyMode)} excl.
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              <span>{summary.incomeCount} inflows</span>
              <span className="mx-1.5">·</span>
              <span>Excludes claims &amp; recoveries</span>
            </div>
          )}
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setFlowBreakupSearch('');
            setFlowBreakupModal('outflow');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFlowBreakupSearch('');
              setFlowBreakupModal('outflow');
            }
          }}
          className="p-5 space-y-1.5 cursor-pointer hover:bg-white/[0.025] transition-colors group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-400">
              {spendViewMode === 'all_outflows'
                ? 'Total Kharcha (All Outflows)'
                : 'Personal Spend'}
            </span>
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSpendRulesOpen(true);
                }}
                className="text-[11px] font-medium text-amber-300 hover:text-amber-200 underline decoration-amber-400/40 underline-offset-2 whitespace-nowrap"
              >
                Excluded ({excludedExpenseCats.length}) · Mark
              </button>
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-400/80 group-hover:text-sky-300">
                <span>Breakup</span>
                <ChevronRight className="w-3 h-3" />
              </span>
            </div>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-rose-400">
            {formatMoney(
              spendViewMode === 'all_outflows' ? allOutflowStats.totalKharcha : periodStats.expense,
              isPrivacyMode
            )}
          </div>
          {spendViewMode === 'all_outflows' ? (
            <div className="space-y-0.5 text-xs text-slate-500 font-mono tabular-nums">
              <div>
                <span>Bank {formatMoney(allOutflowStats.bankOutflow, isPrivacyMode)}</span>
                <span className="mx-1.5">·</span>
                <span>Card {formatMoney(allOutflowStats.cardOutflow, isPrivacyMode)}</span>
                <span className="mx-1.5">·</span>
                <span>Cash {formatMoney(allOutflowStats.cashOutflow, isPrivacyMode)}</span>
              </div>
              {(allOutflowStats.ccSettledOutflow > 0 || allOutflowStats.wifeOutflow > 0) && (
                <div className="text-[11px] text-slate-500">
                  {allOutflowStats.ccSettledOutflow > 0 && (
                    <span>
                      CC Bills {formatMoney(allOutflowStats.ccSettledOutflow, isPrivacyMode)} (Bank→Card excl.)
                    </span>
                  )}
                  {allOutflowStats.ccSettledOutflow > 0 && allOutflowStats.wifeOutflow > 0 && (
                    <span className="mx-1.5">·</span>
                  )}
                  {allOutflowStats.wifeOutflow > 0 && (
                    <span>Wife {formatMoney(allOutflowStats.wifeOutflow, isPrivacyMode)} excl.</span>
                  )}
                </div>
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
            {spendViewMode === 'all_outflows' ? 'Income − Total Kharcha' : 'Monthly Income Left'}
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
            <div className="space-y-0.5 text-xs">
              <div className="font-mono tabular-nums text-slate-300">
                <span>Income Left (excl. Udhaar): </span>
                <strong className={periodStats.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {formatMoney(periodStats.net, isPrivacyMode)}
                </strong>
              </div>
              <div className="text-slate-500">
                <span>{allOutflowStats.outflowPct.toFixed(1)}% outflow</span>
                <span className="mx-1.5">·</span>
                {allOutflowStats.udhaarOutflow > 0 ? (
                  <span>Udhaar {formatMoney(allOutflowStats.udhaarOutflow, isPrivacyMode)}</span>
                ) : (
                  <span>Personal {formatMoney(periodStats.expense, isPrivacyMode)}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-0.5 text-xs">
              <div className="font-mono tabular-nums text-slate-300">
                <span>After Udhaar &amp; All Outflows: </span>
                <strong
                  className={
                    allOutflowStats.netCashflow >= 0 ? 'text-sky-400' : 'text-rose-400'
                  }
                >
                  {formatMoney(allOutflowStats.netCashflow, isPrivacyMode)}
                </strong>
              </div>
              <div className="text-slate-500">
                <span>{periodStats.rate.toFixed(1)}% savings rate</span>
                <span className="mx-1.5">·</span>
                <span>Pending claims {formatMoney(summary.pendingReimbursements || 0, isPrivacyMode)}</span>
              </div>
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
        <div className="p-4 sm:px-6 border-b border-white/[0.08] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[240px]">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search description, category, account..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg field-input"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <input
                  type="date"
                  aria-label="Filter from date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="px-2.5 py-1 text-xs font-mono rounded-lg field-input"
                />
                <span className="text-xs text-slate-500">to</span>
                <input
                  type="date"
                  aria-label="Filter to date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="px-2.5 py-1 text-xs font-mono rounded-lg field-input"
                />
                {isDateRangeActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom('');
                      setDateTo('');
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 rounded-md"
                  >
                    <X className="w-3 h-3" />
                    <span>Clear</span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
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

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-slate-500 mr-1">Quick Dates:</span>
              {[
                { id: 'today', label: 'Today' },
                { id: '7d', label: 'Last 7D' },
                { id: '30d', label: 'Last 30D' },
                { id: 'this_month', label: 'This Month' },
                { id: 'last_month', label: 'Last Month' },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyDatePreset(p.id as any)}
                  className="px-2 py-0.5 font-medium text-slate-300 hover:text-white bg-[#0B0F17] hover:bg-slate-800 border border-white/[0.08] rounded transition-colors whitespace-nowrap"
                >
                  {p.label}
                </button>
              ))}
              {isDateRangeActive && (
                <span className="text-sky-300/90 ml-1">Range overrides month selector</span>
              )}
            </div>
            <span className="text-slate-500">
              Tip: Click <strong className="text-slate-300">▾</strong> on any column header for Excel-style filter &amp; sort
            </span>
          </div>
        </div>

        {/* Filtered Transactions Sum Bar (Always Visible Right Above the Table) */}
        <div
          className={`px-4 sm:px-6 py-3 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3 ${
            hasActiveFilters ? 'bg-sky-500/[0.05]' : 'bg-[#0B0F17]'
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs font-mono tabular-nums">
            <span className="font-sans font-semibold text-slate-200">
              {hasActiveFilters ? 'Filtered Sum' : 'Ledger Sum'}{' '}
              <span className="font-mono text-slate-400 font-normal">
                ({filteredStats.count} {filteredStats.count === 1 ? 'entry' : 'entries'})
              </span>
            </span>
            <span className="text-slate-400">
              Income:{' '}
              <strong className="text-emerald-400">
                +{formatMoney(filteredStats.incomeSum, isPrivacyMode)}
              </strong>{' '}
              <span className="text-slate-500">({filteredStats.incomeCount})</span>
            </span>
            <span className="text-slate-400">
              Expense:{' '}
              <strong className="text-rose-400">
                -{formatMoney(filteredStats.expenseSum, isPrivacyMode)}
              </strong>{' '}
              <span className="text-slate-500">({filteredStats.expenseCount})</span>
            </span>
            <span className="text-slate-400">
              Net Sum:{' '}
              <strong className={filteredStats.netSum >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {filteredStats.netSum >= 0 ? '+' : '-'}
                {formatMoney(Math.abs(filteredStats.netSum), isPrivacyMode)}
              </strong>
            </span>
            {filteredStats.pendingRimSum > 0 && (
              <span className="text-slate-400">
                Pending Claim:{' '}
                <strong className="text-amber-300">
                  {formatMoney(filteredStats.pendingRimSum, isPrivacyMode)}
                </strong>
              </span>
            )}
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-sky-300 hover:text-white bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset All Filters</span>
            </button>
          )}
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
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset All Filters</span>
                </button>
              )}
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
              className={`overflow-auto max-h-[min(560px,62vh)] border-b border-white/[0.06] ${
                openHeaderFilter ? 'min-h-[340px]' : ''
              }`}
            >
              <table className="w-full text-left border-collapse">
                <thead
                  ref={theadRef}
                  className="sticky top-0 z-20 bg-[#0E1420] shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]"
                >
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

                    {/* DATE HEADER + EXCEL FILTER */}
                    <th className="py-3 px-4 relative">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenHeaderFilter((prev) => (prev === 'date' ? null : 'date'))
                        }
                        className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ${
                          isDateHeaderActive ? 'text-sky-300 font-semibold' : ''
                        }`}
                      >
                        <span>Date</span>
                        {sortBy === 'date_desc' ? (
                          <ArrowDown className="w-3 h-3 text-sky-400" />
                        ) : sortBy === 'date_asc' ? (
                          <ArrowUp className="w-3 h-3 text-sky-400" />
                        ) : isDateRangeActive ? (
                          <Filter className="w-3 h-3 text-sky-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </button>

                      {openHeaderFilter === 'date' && (
                        <div className="absolute left-2 top-full mt-1 z-30 w-64 rounded-xl bg-[#111827] border border-white/[0.12] shadow-2xl p-3 space-y-2.5 text-left font-normal">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                            <span>Date Sort &amp; Range</span>
                            {isDateHeaderActive && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDateFrom('');
                                  setDateTo('');
                                  if (sortBy === 'date_asc' || sortBy === 'date_desc') setSortBy('default');
                                }}
                                className="text-sky-400 hover:text-sky-300"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => setSortBy('date_desc')}
                              className={`px-2 py-1 text-[11px] rounded border ${
                                sortBy === 'date_desc'
                                  ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                  : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                              }`}
                            >
                              Newest First
                            </button>
                            <button
                              type="button"
                              onClick={() => setSortBy('date_asc')}
                              className={`px-2 py-1 text-[11px] rounded border ${
                                sortBy === 'date_asc'
                                  ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                  : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                              }`}
                            >
                              Oldest First
                            </button>
                          </div>
                          <div className="space-y-1.5">
                            <label className="block text-[10px] text-slate-400">From Date</label>
                            <input
                              type="date"
                              value={dateFrom}
                              onChange={(e) => setDateFrom(e.target.value)}
                              className="w-full px-2 py-1 text-xs font-mono rounded field-input"
                            />
                            <label className="block text-[10px] text-slate-400">To Date</label>
                            <input
                              type="date"
                              value={dateTo}
                              onChange={(e) => setDateTo(e.target.value)}
                              className="w-full px-2 py-1 text-xs font-mono rounded field-input"
                            />
                          </div>
                          <div className="flex flex-wrap gap-1 pt-1 border-t border-white/[0.08]">
                            {[
                              { id: 'today', label: 'Today' },
                              { id: '7d', label: '7D' },
                              { id: '30d', label: '30D' },
                              { id: 'this_month', label: 'This Mo' },
                              { id: 'last_month', label: 'Last Mo' },
                            ].map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => applyDatePreset(p.id as any)}
                                className="px-2 py-0.5 text-[10px] bg-[#0B0F17] hover:bg-slate-800 text-slate-300 border border-white/[0.08] rounded"
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </th>

                    {/* DESCRIPTION HEADER + EXCEL FILTER */}
                    <th className="py-3 px-4 relative">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenHeaderFilter((prev) =>
                            prev === 'description' ? null : 'description'
                          )
                        }
                        className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ${
                          isDescriptionFilterActive ? 'text-sky-300 font-semibold' : ''
                        }`}
                      >
                        <span>Description</span>
                        {isDescriptionFilterActive ? (
                          <Filter className="w-3 h-3 text-sky-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </button>

                      {openHeaderFilter === 'description' && (
                        <div className="absolute left-2 top-full mt-1 z-30 w-64 rounded-xl bg-[#111827] border border-white/[0.12] shadow-2xl p-3 space-y-2.5 text-left font-normal">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                            <span>Filter Description &amp; Source</span>
                            {isDescriptionFilterActive && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSearchQuery('');
                                  setSourceFilter('all');
                                }}
                                className="text-sky-400 hover:text-sky-300"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <input
                            type="text"
                            placeholder="Text contains..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs rounded field-input"
                          />
                          <div className="space-y-1 max-h-48 overflow-y-auto pt-1 border-t border-white/[0.08]">
                            {[
                              { id: 'all', label: 'All Sources / Tags' },
                              { id: 'telegram', label: 'Telegram Bot' },
                              { id: 'manual', label: 'Manual Entry' },
                              { id: 'import', label: 'Bulk Import' },
                              { id: 'wealth', label: 'Wealth / Auto SIP' },
                              { id: 'simulator', label: 'Simulator' },
                              { id: 'reimbursement', label: 'All Reimbursements' },
                              { id: 'reimb_pending', label: 'Pending Claims Only' },
                            ].map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setSourceFilter(opt.id)}
                                className={`w-full text-left px-2 py-1 text-[11px] rounded transition-colors ${
                                  sourceFilter === opt.id
                                    ? 'bg-sky-500/20 text-sky-300 font-medium'
                                    : 'text-slate-300 hover:bg-white/[0.05]'
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </th>

                    {/* CATEGORY HEADER + EXCEL MULTI-SELECT CHECKBOXES */}
                    <th className="py-3 px-4 relative">
                      <button
                        type="button"
                        onClick={() => {
                          setCatPopoverSearch('');
                          setOpenHeaderFilter((prev) => (prev === 'category' ? null : 'category'));
                        }}
                        className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ${
                          isCategoryFilterActive ? 'text-sky-300 font-semibold' : ''
                        }`}
                      >
                        <span>
                          Category
                          {selectedCategories.length > 0 ? ` (${selectedCategories.length})` : ''}
                        </span>
                        {isCategoryFilterActive ? (
                          <Filter className="w-3 h-3 text-sky-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </button>

                      {openHeaderFilter === 'category' && (
                        <div className="absolute left-0 top-full mt-1 z-30 w-64 rounded-xl bg-[#111827] border border-white/[0.12] shadow-2xl p-3 space-y-2 text-left font-normal">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                            <span>Filter Category</span>
                            {isCategoryFilterActive && (
                              <button
                                type="button"
                                onClick={() => {
                                  setCategorySpendMode('all');
                                  setSelectedCategories([]);
                                }}
                                className="text-sky-400 hover:text-sky-300"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {[
                              { id: 'all', label: 'All' },
                              { id: 'included', label: 'Personal' },
                              { id: 'excluded', label: 'Excluded' },
                            ].map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => setCategorySpendMode(m.id as any)}
                                className={`px-1.5 py-1 text-[10px] rounded border ${
                                  categorySpendMode === m.id
                                    ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                    : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                                }`}
                              >
                                {m.label}
                              </button>
                            ))}
                          </div>
                          <input
                            type="text"
                            placeholder="Search category..."
                            value={catPopoverSearch}
                            onChange={(e) => setCatPopoverSearch(e.target.value)}
                            className="w-full px-2 py-1 text-[11px] rounded field-input"
                          />
                          <div className="max-h-44 overflow-y-auto space-y-1 pr-1 border-t border-white/[0.08] pt-1.5">
                            <label className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-slate-200 hover:bg-white/[0.04] rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selectedCategories.length === 0}
                                onChange={() => setSelectedCategories([])}
                                className="rounded border-slate-600 bg-slate-900 text-sky-400"
                              />
                              <span className="font-medium">(Select All Categories)</span>
                            </label>
                            {categoryFilterOptions
                              .filter((c) =>
                                c.toLowerCase().includes(catPopoverSearch.trim().toLowerCase())
                              )
                              .map((c) => (
                                <label
                                  key={c}
                                  className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.04] rounded cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedCategories.includes(c)}
                                    onChange={() => toggleCategorySelection(c)}
                                    className="rounded border-slate-600 bg-slate-900 text-sky-400"
                                  />
                                  <span className="truncate">{c}</span>
                                </label>
                              ))}
                          </div>
                        </div>
                      )}
                    </th>

                    {/* ACCOUNT HEADER + EXCEL MULTI-SELECT CHECKBOXES */}
                    <th className="py-3 px-4 relative">
                      <button
                        type="button"
                        onClick={() => {
                          setAccPopoverSearch('');
                          setOpenHeaderFilter((prev) => (prev === 'account' ? null : 'account'));
                        }}
                        className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ${
                          isAccountFilterActive ? 'text-sky-300 font-semibold' : ''
                        }`}
                      >
                        <span>
                          Account
                          {selectedAccounts.length > 0 ? ` (${selectedAccounts.length})` : ''}
                        </span>
                        {isAccountFilterActive ? (
                          <Filter className="w-3 h-3 text-sky-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </button>

                      {openHeaderFilter === 'account' && (
                        <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-xl bg-[#111827] border border-white/[0.12] shadow-2xl p-3 space-y-2 text-left font-normal">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                            <span>Filter Account</span>
                            {isAccountFilterActive && (
                              <button
                                type="button"
                                onClick={() => setSelectedAccounts([])}
                                className="text-sky-400 hover:text-sky-300"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <input
                            type="text"
                            placeholder="Search account..."
                            value={accPopoverSearch}
                            onChange={(e) => setAccPopoverSearch(e.target.value)}
                            className="w-full px-2 py-1 text-[11px] rounded field-input"
                          />
                          <div className="max-h-44 overflow-y-auto space-y-1 pr-1 border-t border-white/[0.08] pt-1.5">
                            <label className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-slate-200 hover:bg-white/[0.04] rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selectedAccounts.length === 0}
                                onChange={() => setSelectedAccounts([])}
                                className="rounded border-slate-600 bg-slate-900 text-sky-400"
                              />
                              <span className="font-medium">(Select All Accounts)</span>
                            </label>
                            {accountFilterOptions
                              .filter((a) =>
                                a.label.toLowerCase().includes(accPopoverSearch.trim().toLowerCase())
                              )
                              .map((a) => (
                                <label
                                  key={a.id}
                                  className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.04] rounded cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedAccounts.includes(a.id)}
                                    onChange={() => toggleAccountSelection(a.id)}
                                    className="rounded border-slate-600 bg-slate-900 text-sky-400"
                                  />
                                  <span className="truncate">{a.label}</span>
                                </label>
                              ))}
                          </div>
                        </div>
                      )}
                    </th>

                    {/* AMOUNT HEADER + EXCEL FILTER */}
                    <th className="py-3 px-4 text-right relative">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenHeaderFilter((prev) => (prev === 'amount' ? null : 'amount'))
                        }
                        className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ml-auto ${
                          isAmountFilterActive ? 'text-sky-300 font-semibold' : ''
                        }`}
                      >
                        <span>Amount</span>
                        {sortBy === 'amount_desc' ? (
                          <ArrowDown className="w-3 h-3 text-sky-400" />
                        ) : sortBy === 'amount_asc' ? (
                          <ArrowUp className="w-3 h-3 text-sky-400" />
                        ) : isAmountFilterActive ? (
                          <Filter className="w-3 h-3 text-sky-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </button>

                      {openHeaderFilter === 'amount' && (
                        <div className="absolute right-2 top-full mt-1 z-30 w-60 rounded-xl bg-[#111827] border border-white/[0.12] shadow-2xl p-3 space-y-2.5 text-left font-normal">
                          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                            <span>Amount &amp; Type</span>
                            {isAmountFilterActive && (
                              <button
                                type="button"
                                onClick={() => {
                                  setTypeFilter('all');
                                  setMinAmount('');
                                  setMaxAmount('');
                                  if (sortBy === 'amount_asc' || sortBy === 'amount_desc') {
                                    setSortBy('default');
                                  }
                                }}
                                className="text-sky-400 hover:text-sky-300"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => setSortBy('amount_desc')}
                              className={`px-2 py-1 text-[11px] rounded border ${
                                sortBy === 'amount_desc'
                                  ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                  : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                              }`}
                            >
                              High → Low
                            </button>
                            <button
                              type="button"
                              onClick={() => setSortBy('amount_asc')}
                              className={`px-2 py-1 text-[11px] rounded border ${
                                sortBy === 'amount_asc'
                                  ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                  : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                              }`}
                            >
                              Low → High
                            </button>
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {(['all', 'expense', 'income'] as const).map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setTypeFilter(t)}
                                className={`px-2 py-1 text-[11px] rounded border capitalize ${
                                  typeFilter === t
                                    ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                                    : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:text-white'
                                }`}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-1.5 pt-1 border-t border-white/[0.08]">
                            <input
                              type="number"
                              min="0"
                              placeholder="Min ₹"
                              value={minAmount}
                              onChange={(e) => setMinAmount(e.target.value)}
                              className="w-1/2 px-2 py-1 text-xs font-mono rounded field-input"
                            />
                            <input
                              type="number"
                              min="0"
                              placeholder="Max ₹"
                              value={maxAmount}
                              onChange={(e) => setMaxAmount(e.target.value)}
                              className="w-1/2 px-2 py-1 text-xs font-mono rounded field-input"
                            />
                          </div>
                        </div>
                      )}
                    </th>

                    <th className="py-3 px-6 text-right">
                      {hasActiveFilters ? (
                        <button
                          type="button"
                          onClick={clearAllFilters}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-300 hover:text-white"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Reset</span>
                        </button>
                      ) : (
                        'Actions'
                      )}
                    </th>
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
                                <span className="text-amber-300/90 font-medium">
                                  {tx.isCcPayment || tx.category === 'CC Payment'
                                    ? 'Internal Bank→Card (Excl. from 2× Spend)'
                                    : 'Excluded from Spend'}
                                </span>
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

      {flowBreakupModal && flowBreakupData && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
          onClick={() => setFlowBreakupModal(null)}
        >
          <div
            className="surface-panel rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div>
                <h2 className="font-display text-base font-semibold text-white">
                  {flowBreakupData.isInflowView ? 'Total Inflow Breakup' : 'Total Outflow Breakup'}
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    ({selectedMonth === 'all' ? 'All Time' : selectedMonth} ·{' '}
                    {flowBreakupData.includeAll ? 'Include All Accounts' : 'Personal Rules Applied'})
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                  Counted Total:{' '}
                  <strong
                    className={
                      flowBreakupData.isInflowView ? 'text-emerald-400' : 'text-rose-400'
                    }
                  >
                    {formatMoney(flowBreakupData.includedTotal, isPrivacyMode)}
                  </strong>{' '}
                  ({flowBreakupData.includedTxs.length} entries)
                  {flowBreakupData.excludedTotal > 0 && (
                    <span className="text-slate-500">
                      {' '}
                      · Excluded {formatMoney(flowBreakupData.excludedTotal, isPrivacyMode)} (
                      {flowBreakupData.excludedTxs.length}
                      {flowBreakupData.ccSettledExcludedTotal > 0
                        ? ` · incl. CC Bills ${formatMoney(
                            flowBreakupData.ccSettledExcludedTotal,
                            isPrivacyMode
                          )}`
                        : ''}
                      )
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="inline-flex p-0.5 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setFlowBreakupModal('inflow')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      flowBreakupData.isInflowView
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Inflow
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlowBreakupModal('outflow')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      !flowBreakupData.isInflowView
                        ? 'bg-rose-500/20 text-rose-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Outflow
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setFlowBreakupModal(null)}
                  aria-label="Close breakup modal"
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-5 sm:p-6 overflow-y-auto space-y-6">
              {/* Channel Summary Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Banks', val: flowBreakupData.bankTotal, color: 'text-sky-300' },
                  { label: 'Cards / RuPay', val: flowBreakupData.cardTotal, color: 'text-amber-300' },
                  { label: 'Cash Wallet', val: flowBreakupData.cashTotal, color: 'text-emerald-300' },
                  {
                    label: 'Wife (Excluded)',
                    val: flowBreakupData.wifeExcludedTotal,
                    color: 'text-slate-400',
                  },
                ].map((c) => (
                  <div
                    key={c.label}
                    className="rounded-lg bg-[#0B0F17] border border-white/[0.08] px-3.5 py-2.5"
                  >
                    <div className="text-[11px] text-slate-400">{c.label}</div>
                    <div className={`text-sm font-bold font-mono tabular-nums mt-0.5 ${c.color}`}>
                      {formatMoney(c.val, isPrivacyMode)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Account-wise & Category-wise Breakup */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Account-wise ({flowBreakupData.accountList.length})</span>
                    <span className="text-[11px] font-normal text-slate-500">
                      Click Filter to inspect in table
                    </span>
                  </div>
                  {flowBreakupData.accountList.length === 0 ? (
                    <p className="text-xs text-slate-500 py-3">No matching accounts.</p>
                  ) : (
                    <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-56 overflow-y-auto">
                      {flowBreakupData.accountList.map((a) => {
                        const pct =
                          flowBreakupData.includedTotal > 0
                            ? ((a.total / flowBreakupData.includedTotal) * 100).toFixed(1)
                            : '0.0';
                        return (
                          <div
                            key={a.account}
                            className="py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <span className="text-slate-200 font-medium">{a.account}</span>
                              <span className="text-slate-500 ml-1.5">
                                ({a.count} · {pct}%)
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono tabular-nums text-slate-100 font-semibold">
                                {formatMoney(a.total, isPrivacyMode)}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  clearAllFilters();
                                  setSelectedAccounts([a.account]);
                                  setTypeFilter(flowBreakupData.isInflowView ? 'income' : 'expense');
                                  setFlowBreakupModal(null);
                                }}
                                className="px-2 py-0.5 text-[10px] font-medium text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 rounded"
                              >
                                Filter
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Category-wise ({flowBreakupData.categoryList.length})</span>
                    <span className="text-[11px] font-normal text-slate-500">
                      Sorted highest first
                    </span>
                  </div>
                  {flowBreakupData.categoryList.length === 0 ? (
                    <p className="text-xs text-slate-500 py-3">No matching categories.</p>
                  ) : (
                    <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-56 overflow-y-auto">
                      {flowBreakupData.categoryList.map((c) => {
                        const pct =
                          flowBreakupData.includedTotal > 0
                            ? ((c.total / flowBreakupData.includedTotal) * 100).toFixed(1)
                            : '0.0';
                        return (
                          <div
                            key={c.category}
                            className="py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0 truncate">
                              <span className="text-slate-200 font-medium">{c.category}</span>
                              <span className="text-slate-500 ml-1.5">
                                ({c.count} · {pct}%)
                              </span>
                              {c.isExcluded && (
                                <span className="ml-1.5 text-[10px] text-amber-300">
                                  · Excluded rule
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono tabular-nums text-slate-100 font-semibold">
                                {formatMoney(c.total, isPrivacyMode)}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  clearAllFilters();
                                  setSelectedCategories([c.category]);
                                  setTypeFilter(flowBreakupData.isInflowView ? 'income' : 'expense');
                                  setFlowBreakupModal(null);
                                }}
                                className="px-2 py-0.5 text-[10px] font-medium text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 rounded"
                              >
                                Filter
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Individual Transactions Inside Breakup */}
              <div className="space-y-2 pt-2 border-t border-white/[0.08]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-300">
                    Included Entries ({flowBreakupData.includedTxs.length})
                  </span>
                  <input
                    type="text"
                    placeholder="Quick search inside breakup..."
                    value={flowBreakupSearch}
                    onChange={(e) => setFlowBreakupSearch(e.target.value)}
                    className="w-56 px-2.5 py-1 text-xs rounded-lg field-input"
                  />
                </div>
                <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-56 overflow-y-auto">
                  {flowBreakupData.includedTxs
                    .filter((tx) => {
                      if (!flowBreakupSearch.trim()) return true;
                      const q = flowBreakupSearch.toLowerCase();
                      return `${tx.description} ${tx.category} ${tx.account || ''}`
                        .toLowerCase()
                        .includes(q);
                    })
                    .map((tx) => (
                      <div
                        key={tx.id}
                        className="py-2 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="text-slate-200 font-medium truncate">
                            {tx.description}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatDate(tx.date)} · {tx.category} · {tx.account || 'AX Bank'}
                          </div>
                        </div>
                        <span
                          className={`font-mono tabular-nums font-semibold shrink-0 ${
                            flowBreakupData.isInflowView ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {flowBreakupData.isInflowView ? '+' : '-'}
                          {formatMoney(tx.amount, isPrivacyMode)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="px-6 py-3.5 border-t border-white/[0.08] bg-[#0B0F17] flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11px] text-slate-400">
                Switch mode above to compare Personal Spend vs Include All Cash/Card/Bank flows.
              </span>
              <button
                type="button"
                onClick={() => setFlowBreakupModal(null)}
                className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
