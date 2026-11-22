import { DEFAULT_ACCOUNTS_CONFIG, DEFAULT_CATEGORIES, getIstDateTime } from './defaults.js';
import {
  AccountBalanceInfo,
  AccountBalancesData,
  AccountMeta,
  CategoryDef,
  DailyItemLimit,
  FinancialSummary,
  FuelLog,
  PaymentMethod,
  PiggyBankItem,
  Transaction,
  UserDataStore,
  UserProfile,
} from './types.js';

export function getMergedAccounts(store: UserDataStore): Record<string, AccountMeta> {
  const merged: Record<string, AccountMeta> = {};
  for (const [k, v] of Object.entries(DEFAULT_ACCOUNTS_CONFIG)) {
    merged[k] = {
      ...v,
      creditLimit: store.cardCreditLimits?.[k] ?? v.creditLimit,
    };
  }
  for (const custom of store.customAccounts || []) {
    if (custom?.id) {
      merged[custom.id] = {
        ...custom,
        creditLimit: store.cardCreditLimits?.[custom.id] ?? custom.creditLimit,
        isCustom: true,
      };
    }
  }
  return merged;
}

export function detectAccountFromText(text: string, store?: UserDataStore): string | undefined {
  const lower = (text || '').toLowerCase();
  if (!lower) return undefined;

  if (store?.customAccounts) {
    for (const acc of store.customAccounts) {
      if (lower.includes(acc.shortName.toLowerCase()) || lower.includes(acc.id.toLowerCase())) {
        return acc.id;
      }
      const digits = acc.id.match(/\b(\d{4})\b/);
      if (digits && lower.includes(digits[1])) return acc.id;
    }
  }

  if (lower.includes('2005') || lower.includes('ic bank 2005') || lower.includes('icici 2005')) return 'IC Bank 2005';
  if (lower.includes('0000') || lower.includes('rupay') || lower.includes('icici cc') || lower.includes('icici card')) return 'ICICI CC 0000';
  if (lower.includes('5733')) return 'SBI CC 5733';
  if (lower.includes('6526')) return 'SBI CC 6526';
  if (lower.includes('8210')) return 'AX CC 8210';
  if (lower.includes('5376')) return 'AX CC 5376';
  if (lower.includes('sbi cc') || lower.includes('sbi card')) return 'SBI CC 5733';
  if (lower.includes('axis cc') || lower.includes('ax cc') || lower.includes('axis card')) return 'AX CC 8210';
  if (lower.includes('ic bank') || lower.includes('icici bank') || (lower.includes('icici') && !lower.includes('cc'))) return 'IC Bank';
  if (lower.includes('ax bank') || lower.includes('axis bank') || lower.includes('salary bank') || (lower.includes('axis') && !lower.includes('cc'))) return 'AX Bank';
  if (/\b(cash|nagad|rokda|pocket)\b/i.test(lower)) return 'Cash';

  const isExplicitTransferToWife = /\b(wife\s*transfer|transfer\s*to\s*wife|sent\s*to\s*wife|given\s*to\s*wife|to\s*wife|wife\s*savings|bachat\s*wife)\b/i.test(lower);
  const isWifeSource =
    /\b(from|by|via|in|on)\s+wife\b/i.test(lower) ||
    /\bwife\s*(bank|account|a\/c|upi|card|wallet|se|ne|pe|me)\b/i.test(lower);
  if (isWifeSource && !isExplicitTransferToWife) return 'Wife';

  return undefined;
}

export function detectPaymentMethod(text: string, account?: string): PaymentMethod {
  const lower = (text || '').toLowerCase();
  if (account === 'Cash' || /\b(cash|nagad|rokda)\b/i.test(lower)) return 'Cash';
  if (account && (account.includes('CC') || account === 'IC Bank 2005')) {
    return account === 'ICICI CC 0000' && lower.includes('upi') ? 'UPI' : 'Card';
  }
  if (/\b(upi|gpay|phonepe|paytm|bhim)\b/i.test(lower)) return 'UPI';
  if (account === 'Wife') return 'Wife';
  if (/\b(card|swipe|credit|debit)\b/i.test(lower)) return 'Card';
  if (/\b(neft|imps|rtgs|bank transfer|transfer)\b/i.test(lower)) return 'Bank Transfer';
  if (/\b(net banking|netbanking)\b/i.test(lower)) return 'Net Banking';
  return 'UPI';
}

export function matchCategory(
  rawText: string,
  type: 'income' | 'expense',
  categories: CategoryDef[]
): CategoryDef {
  const pool = categories.length > 0 ? categories : DEFAULT_CATEGORIES;
  const lower = rawText.toLowerCase();

  // Check exact category name
  const exact = pool.find(
    c => (c.type === type || c.type === 'both') && lower.includes(c.name.toLowerCase())
  );
  if (exact) return exact;

  // Score keyword matches (prefer longer keyword match)
  let bestCat: CategoryDef | null = null;
  let bestScore = 0;
  for (const cat of pool) {
    if (cat.type !== type && cat.type !== 'both') continue;
    for (const kw of cat.keywords || []) {
      const k = kw.toLowerCase().trim();
      if (!k) continue;
      if (lower.includes(k) && k.length > bestScore) {
        bestScore = k.length;
        bestCat = cat;
      }
    }
  }
  if (bestCat) return bestCat;

  const fallbackId = type === 'income' ? 'other_income' : 'other_expense';
  return pool.find(c => c.id === fallbackId) || pool[0];
}

export interface ParsedMessageResult {
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  account: string;
  paymentMethod: PaymentMethod;
  isReimbursement?: boolean;
  isSavingsTransfer?: boolean;
  isWifeTransfer?: boolean;
  isCcPayment?: boolean;
  isInvestment?: boolean;
  isUdhaarLent?: boolean;
  isUdhaarRecovery?: boolean;
  udhaarPersonName?: string;
  fuelOdometer?: number;
  fuelLiters?: number;
  vehicleName?: string;
}

export function parseMessageDeterministic(
  rawText: string,
  store: UserDataStore
): ParsedMessageResult[] {
  const lines = rawText
    .split(/\n|(?:\s*,\s*(?=(?:rim|reimburse|salary|income|received|credited|udhaar|udhar|petrol|diesel|\d+|₹|rs\.?)\b))/i)
    .map(l => l.trim())
    .filter(Boolean);

  const results: ParsedMessageResult[] = [];
  const categories = store.categories || DEFAULT_CATEGORIES;

  for (const line of lines) {
    // Extract all number tokens except 4-digit card suffixes paired with card/bank names or odometer readings
    const cleanedForAmount = line
      .replace(/\b(?:icici|sbi|axis|ax|ic)\s*(?:cc|bank|card)?\s*(?:0000|5733|6526|8210|5376|2005)\b/gi, '')
      .replace(/\b\d{4,7}\s*km\b/gi, '')
      .replace(/\bodo(?:meter)?\s*[:=]?\s*\d+\b/gi, '');

    const amtMatch = cleanedForAmount.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
    if (!amtMatch) continue;
    const amount = Number(amtMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const lower = line.toLowerCase();
    const isReimbursement = /\b(rim|reimburse|reimbursement|office claim|client trip|claim)\b/i.test(lower);
    const isWifePaySource =
      /\b(from|by|via|in|on)\s+wife\b/i.test(lower) ||
      /\bwife\s*(bank|account|a\/c|upi|card|wallet|se|ne|pe|me)\b/i.test(lower);
    const isExplicitWifeTransfer = /\b(wife\s*transfer|transfer\s*to\s*wife|sent\s*to\s*wife|given\s*to\s*wife|to\s*wife|wife\s*savings|bachat\s*wife|patni)\b/i.test(lower);
    const isCcPayment = /\b(cc payment|credit card payment|cc bill|credit card bill|pay cc)\b/i.test(lower);
    const isUdhaarLent = /\b(udhaar diya|udhar diya|lent to|loan diya|advance diya)\b/i.test(lower);
    const isUdhaarRecovery = /\b(udhaar wapas|udhar wapas|udhaar mila|udhar mila|udhar aaya|loan repayment)\b/i.test(lower);

    const isIncomeKeyword = /\b(salary|tankhwa|income|credited|received|bonus|dividend|interest|cashback|refund|freelance|stipend|mila|aaya)\b/i.test(lower);
    const type: 'income' | 'expense' =
      isUdhaarRecovery || (isIncomeKeyword && !isReimbursement && !isCcPayment && !isUdhaarLent)
        ? 'income'
        : 'expense';

    const matchedBefore = matchCategory(line, type, categories);
    const isBareWifeTransfer =
      !isWifePaySource &&
      type === 'expense' &&
      /\bwife\b/i.test(lower) &&
      (matchedBefore.id === 'wife_transfer' || matchedBefore.id === 'other_expense');
    const isWifeTransfer = !isWifePaySource && (isExplicitWifeTransfer || isBareWifeTransfer);

    const detectedAcc = detectAccountFromText(line, store);
    const account = detectedAcc || 'AX Bank';
    const paymentMethod = detectPaymentMethod(line, account);

    let category = matchedBefore.name;
    if (isReimbursement) category = 'Reimbursement';
    else if (isWifeTransfer) category = 'Wife Transfer';
    else if (isCcPayment) category = 'CC Payment';
    else if (isUdhaarLent) category = 'Udhaar Given';
    else if (isUdhaarRecovery) category = 'Udhaar Received';

    const isInvestment = category === 'Investments & Savings' || /\b(sip|mutual fund|fd|rd|ppf|nps)\b/i.test(lower);

    // Extract fuel odometer if petrol/diesel/fuel
    let fuelOdometer: number | undefined;
    let fuelLiters: number | undefined;
    let vehicleName: string | undefined;
    if (/\b(petrol|diesel|fuel|cng)\b/i.test(lower)) {
      const odoMatch = line.match(/\b(\d{3,7})\s*(?:km|odo)\b/i) || line.match(/\bodo(?:meter)?\s*[:=]?\s*(\d{3,7})\b/i);
      if (odoMatch) fuelOdometer = Number(odoMatch[1]);
      const litMatch = line.match(/\b(\d+(?:\.\d+)?)\s*(?:l|ltr|liter|liters|litre)\b/i);
      if (litMatch) fuelLiters = Number(litMatch[1]);
      if (/\b(car|i20|swift|creta|nexon|baleno|city)\b/i.test(lower)) vehicleName = 'Car';
      else if (/\b(bike|activa|scooter|jupiter|pulsar|bullet)\b/i.test(lower)) vehicleName = 'Two-Wheeler';
    }

    // Extract person name for udhaar
    let udhaarPersonName: string | undefined;
    if (isUdhaarLent || isUdhaarRecovery) {
      const personMatch = line.match(/(?:to|from|ko|se)\s+([A-Za-z][A-Za-z ]{1,25})/i);
      if (personMatch) udhaarPersonName = personMatch[1].trim();
    }

    // Clean description
    const cleanedDesc = line
      .replace(/(?:₹|rs\.?|inr)\s*\d+(?:,\d{3})*(?:\.\d{1,2})?/gi, '')
      .replace(/\b\d+(?:,\d{3})*(?:\.\d{1,2})?\b/, '')
      .replace(/\b(?:icici|sbi|axis|ax|ic)\s*(?:cc|bank|card)?\s*(?:0000|5733|6526|8210|5376|2005)?\b/gi, '')
      .replace(/\b(?:cash|upi|rim)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    results.push({
      type,
      amount,
      category,
      description: cleanedDesc || category,
      account,
      paymentMethod,
      isReimbursement,
      isSavingsTransfer: isWifeTransfer,
      isWifeTransfer,
      isCcPayment,
      isInvestment,
      isUdhaarLent,
      isUdhaarRecovery,
      udhaarPersonName,
      fuelOdometer,
      fuelLiters,
      vehicleName,
    });
  }

  return results;
}

export function isNonPersonalExpense(tx: Transaction, categories: CategoryDef[]): boolean {
  if (tx.type !== 'expense') return false;
  const cat = categories.find(c => c.name.toLowerCase() === (tx.category || '').toLowerCase());
  if (cat) {
    if (cat.excludeFromBudget === true) return true;
    if (cat.excludeFromBudget === false) return false;
  }
  return Boolean(
    tx.isReimbursement || tx.isCcPayment || tx.isUdhaarLent || tx.isWifeTransfer || tx.isSavingsTransfer
  );
}

export function computeFinancialSummary(
  store: UserDataStore,
  monthFilter?: string
): FinancialSummary {
  const ist = getIstDateTime();
  const activeMonth = monthFilter && monthFilter !== 'all' ? monthFilter : ist.month;
  const categories = store.categories || DEFAULT_CATEGORIES;

  let totalIncome = 0;
  let totalExpense = 0;
  let personalExpense = 0;
  let pendingReimbursements = 0;
  let savingsTransfers = 0;
  let investmentsTotal = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  let udhaarLentTotal = 0;

  let currentMonthIncome = 0;
  let currentMonthTotalExpense = 0;
  let currentMonthPersonalExpense = 0;
  let currentMonthCount = 0;
  let currentMonthUdhaarLent = 0;

  for (const tx of store.transactions) {
    const amt = Number(tx.amount || 0);
    if (amt <= 0) continue;
    const isTargetMonth = tx.date?.startsWith(activeMonth);

    if (tx.type === 'income') {
      const isReimbInflow = Boolean(tx.isReimbursementInflow || tx.category === 'Reimbursement');
      const isUdhaarRec = Boolean(tx.isUdhaarRecovery || tx.category === 'Udhaar Received');
      const isCcSettlementInflow = Boolean(tx.isCcPayment || tx.category === 'CC Payment');
      if (!isReimbInflow && !isUdhaarRec && !isCcSettlementInflow) {
        totalIncome += amt;
        if (isTargetMonth) currentMonthIncome += amt;
      }
      incomeCount++;
      if (isTargetMonth) currentMonthCount++;
    } else {
      totalExpense += amt;
      expenseCount++;
      if (isTargetMonth) {
        currentMonthTotalExpense += amt;
        currentMonthCount++;
      }

      if (tx.isReimbursement) {
        const settled = Number(tx.reimbursementSettledAmount || 0);
        if (tx.reimbursementStatus !== 'settled') {
          pendingReimbursements += Math.max(0, amt - settled);
        }
      }
      if (tx.isWifeTransfer || tx.isSavingsTransfer) {
        savingsTransfers += amt;
      }
      if (tx.isInvestment || tx.category === 'Investments & Savings') {
        investmentsTotal += amt;
      }
      if (tx.isUdhaarLent || tx.category === 'Udhaar Given') {
        udhaarLentTotal += amt;
        if (isTargetMonth) currentMonthUdhaarLent += amt;
      }

      if (!isNonPersonalExpense(tx, categories)) {
        personalExpense += amt;
        if (isTargetMonth) currentMonthPersonalExpense += amt;
      }
    }
  }

  let pendingUdhaarBakaya = 0;
  let currentMonthUdhaarBakaya = 0;
  for (const u of store.udhaars || []) {
    if (u.type === 'lent' && u.status !== 'settled') {
      const remaining = Math.max(0, Number(u.amount || 0) - Number(u.settledAmount || 0));
      pendingUdhaarBakaya += remaining;
      if (u.date?.startsWith(activeMonth)) currentMonthUdhaarBakaya += remaining;
    }
  }

  const netSavings = totalIncome - personalExpense;
  const savingsRate = totalIncome > 0 ? Math.max(0, Math.min(100, (netSavings / totalIncome) * 100)) : 0;

  const monthlyBudget = (store.budgets || []).reduce((acc, b) => {
    const cat = categories.find(c => c.name.toLowerCase() === b.category.toLowerCase());
    if (cat?.excludeFromBudget) return acc;
    return acc + Number(b.limit || 0);
  }, 0);

  const dayOfMonth = activeMonth === ist.month ? Math.max(1, Number(ist.date.slice(8, 10))) : 30;
  const dailyAverageExpense = currentMonthPersonalExpense / dayOfMonth;

  const balances = computeAccountBalances(store);

  return {
    totalIncome,
    totalExpense,
    personalExpense,
    pendingReimbursements,
    savingsTransfers,
    investmentsTotal,
    netSavings,
    savingsRate,
    transactionCount: store.transactions.length,
    incomeCount,
    expenseCount,
    monthlyBudget,
    monthlySpent: currentMonthPersonalExpense,
    dailyAverageExpense,
    currentMonthIncome,
    currentMonthTotalExpense,
    currentMonthPersonalExpense,
    currentMonthNetSavings: currentMonthIncome - currentMonthPersonalExpense,
    currentMonthCount,
    openingCarryforward: Math.max(0, netSavings - (currentMonthIncome - currentMonthPersonalExpense)),
    totalNetSavings: netSavings,
    cashBalance: balances.accounts['Cash']?.currentBalance || 0,
    totalCashBalance: balances.totalBankCashBalance,
    udhaarLentTotal,
    currentMonthUdhaarLent,
    pendingUdhaarBakaya,
    currentMonthUdhaarBakaya,
  };
}

export function computeAccountBalances(store: UserDataStore): AccountBalancesData {
  const merged = getMergedAccounts(store);
  const baseBalances = store.accountBaseBalances || {};
  const timestamps = store.accountBalanceSetTimestamps || {};

  const accounts: Record<string, AccountBalanceInfo> = {};
  for (const [id, meta] of Object.entries(merged)) {
    const resolvedBase =
      id === 'Wife' && baseBalances[id] === undefined
        ? Number(store.wifeBaseBalance || 0)
        : Number(baseBalances[id] || 0);
    accounts[id] = {
      accountId: id,
      name: meta.name,
      shortName: meta.shortName,
      type: meta.type,
      badge: meta.badge,
      baseBalance: resolvedBase,
      credits: 0,
      debits: 0,
      currentBalance: resolvedBase,
      creditLimit: meta.creditLimit,
      billingDay: meta.billingDay,
      paymentDueDay: meta.paymentDueDay,
      isDefault: Boolean(DEFAULT_ACCOUNTS_CONFIG[id]),
    };
  }

  const wifeTs = timestamps['Wife'] || store.wifeBalanceSetTimestamp;
  const seenTransferTxIds = new Set<string>();
  let wifeTransferred = 0;

  for (const tx of store.transactions) {
    const accId = tx.account || 'AX Bank';
    if (!accounts[accId]) {
      accounts[accId] = {
        accountId: accId,
        name: accId,
        shortName: accId,
        type: 'bank_account',
        badge: 'Account',
        baseBalance: Number(baseBalances[accId] || 0),
        credits: 0,
        debits: 0,
        currentBalance: Number(baseBalances[accId] || 0),
      };
    }

    const amt = Number(tx.amount || 0);
    const baseTs = accId === 'Wife' ? timestamps['Wife'] || store.wifeBalanceSetTimestamp : timestamps[accId];
    const passesPrimaryTs = !baseTs || !tx.createdAt || tx.createdAt >= baseTs;
    if (passesPrimaryTs) {
      if (tx.type === 'income') {
        accounts[accId].credits += amt;
      } else {
        accounts[accId].debits += amt;
      }
    }

    // Credit Wife account whenever money is transferred to Wife from another bank/cash account
    if (tx.type === 'expense' && (tx.isWifeTransfer || tx.isSavingsTransfer) && accId !== 'Wife') {
      seenTransferTxIds.add(tx.id);
      if (accounts['Wife'] && (!wifeTs || !tx.createdAt || tx.createdAt >= wifeTs)) {
        accounts['Wife'].credits += amt;
        wifeTransferred += amt;
      }
    }

    const settledCardId = tx.ccSettledCardId;
    if (tx.type === 'expense' && settledCardId && settledCardId !== accId) {
      if (!accounts[settledCardId]) {
        accounts[settledCardId] = {
          accountId: settledCardId,
          name: settledCardId,
          shortName: settledCardId,
          type: 'credit_card',
          badge: 'Card',
          baseBalance: Number(baseBalances[settledCardId] || 0),
          credits: 0,
          debits: 0,
          currentBalance: 0,
          creditLimit: Number(store.cardCreditLimits?.[settledCardId] || 100000),
        };
      }
      const cardTs = timestamps[settledCardId];
      if (!cardTs || !tx.createdAt || tx.createdAt >= cardTs) {
        accounts[settledCardId].credits += amt;
      }
    }
  }

  // Also include any legacy/unlinked SavingsTransfer records not already credited via transactions
  for (const s of store.savingsTransfers || []) {
    if (s.linkedTransactionId && seenTransferTxIds.has(s.linkedTransactionId)) continue;
    const amt = Number(s.amount || 0);
    if (amt <= 0) continue;
    if (accounts['Wife'] && (!wifeTs || !s.createdAt || s.createdAt >= wifeTs)) {
      accounts['Wife'].credits += amt;
      wifeTransferred += amt;
    }
  }

  let totalBankCashBalance = 0;
  let totalCardAvailableLimit = 0;
  let totalCardOutstanding = 0;

  for (const info of Object.values(accounts)) {
    const isCard = info.type === 'credit_card' || info.type === 'rupay_card';
    if (isCard) {
      const outstanding = Math.max(0, info.baseBalance + info.debits - info.credits);
      const limit = Number(info.creditLimit || 100000);
      info.currentOutstanding = outstanding;
      info.availableLimit = Math.max(0, limit - outstanding);
      info.currentBalance = -outstanding;
      totalCardOutstanding += outstanding;
      totalCardAvailableLimit += info.availableLimit;
    } else {
      info.currentBalance = info.baseBalance + info.credits - info.debits;
      totalBankCashBalance += info.currentBalance;
    }
  }

  const wifeAcc = accounts['Wife'];
  const wifeBase = wifeAcc ? wifeAcc.baseBalance : Number(store.wifeBaseBalance || 0);

  return {
    accountBaseBalances: baseBalances,
    accountBalanceSetTimestamps: timestamps,
    wifeBaseBalance: wifeBase,
    wifeBalanceSetTimestamp: store.wifeBalanceSetTimestamp,
    cardCreditLimits: store.cardCreditLimits || {},
    customAccounts: store.customAccounts || [],
    accounts,
    totalBankCashBalance,
    totalCardAvailableLimit,
    totalCardOutstanding,
    wifeSavings: {
      baseBalance: wifeBase,
      totalTransferred: wifeTransferred,
      currentBalance: wifeAcc ? wifeAcc.currentBalance : wifeBase + wifeTransferred,
    },
  };
}

export function computeGullakSummary(store: UserDataStore, user?: UserProfile) {
  const ist = getIstDateTime();
  const currentMonth = ist.month;
  const startMonth = user?.trackingStartMonth || currentMonth;
  const categories = store.categories || DEFAULT_CATEGORIES;

  const monthsSet = new Set<string>([currentMonth]);
  for (const tx of store.transactions) {
    if (tx.date && tx.date.length >= 7) {
      const m = tx.date.slice(0, 7);
      if (m >= startMonth) monthsSet.add(m);
    }
  }
  const months = Array.from(monthsSet).filter(m => m >= startMonth).sort().reverse();

  const catTotals: Record<string, { totalSaved: number; currentMonthSaved: number; color?: string; icon?: string }> = {};
  let totalGullakSavings = 0;
  let currentMonthSaved = 0;
  let pastMonthsSaved = 0;

  const monthlyHistory = months.map(m => {
    const monthTxs = store.transactions.filter(
      t => t.type === 'expense' && t.date?.startsWith(m) && !isNonPersonalExpense(t, categories)
    );
    const spentByCat: Record<string, number> = {};
    for (const tx of monthTxs) {
      spentByCat[tx.category] = (spentByCat[tx.category] || 0) + Number(tx.amount || 0);
    }

    let totalBudget = 0;
    let totalSpent = 0;
    let totalSaved = 0;
    const catRecords = (store.budgets || [])
      .filter(b => Number(b.limit || 0) > 0)
      .map(b => {
        const spent = spentByCat[b.category] || 0;
        const limit = Number(b.limit || 0);
        const savedAmount = Math.max(0, limit - spent);
        totalBudget += limit;
        totalSpent += spent;
        totalSaved += savedAmount;

        const meta = categories.find(c => c.name.toLowerCase() === b.category.toLowerCase());
        if (!catTotals[b.category]) {
          catTotals[b.category] = { totalSaved: 0, currentMonthSaved: 0, color: meta?.color, icon: meta?.icon };
        }
        catTotals[b.category].totalSaved += savedAmount;
        if (m === currentMonth) catTotals[b.category].currentMonthSaved += savedAmount;

        return {
          category: b.category,
          month: m,
          budgetLimit: limit,
          spent,
          savedAmount,
        };
      });

    totalGullakSavings += totalSaved;
    if (m === currentMonth) currentMonthSaved += totalSaved;
    else pastMonthsSaved += totalSaved;

    const [yr, mo] = m.split('-').map(Number);
    const monthName = new Date(yr, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

    return {
      month: m,
      monthName,
      totalBudget,
      totalSpent,
      totalSaved,
      categories: catRecords,
    };
  });

  return {
    totalGullakSavings,
    currentMonthSaved,
    pastMonthsSaved,
    activeMonthsCount: months.length,
    trackingStartMonth: startMonth,
    categoryBreakdown: Object.entries(catTotals)
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.totalSaved - a.totalSaved),
    monthlyHistory,
  };
}

export function computeDailyLimits(store: UserDataStore): {
  limits: DailyItemLimit[];
  summary: {
    totalLimitsCount: number;
    activeLimitsCount: number;
    totalDailyBudget: number;
    totalTodaySpent: number;
    totalExceededCount: number;
    totalWarningCount: number;
    totalSafeCount: number;
  };
} {
  const today = getIstDateTime().date;
  const todayExpenses = store.transactions.filter(t => t.type === 'expense' && t.date === today);

  let totalDailyBudget = 0;
  let totalTodaySpent = 0;
  let totalExceededCount = 0;
  let totalWarningCount = 0;
  let totalSafeCount = 0;
  let activeLimitsCount = 0;

  const limits = (store.dailyItemLimits || []).map(item => {
    const kws = (item.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    const matching = todayExpenses.filter(tx => {
      const hay = `${tx.description} ${tx.category}`.toLowerCase();
      return kws.some(kw => hay.includes(kw));
    });
    const todaySpent = matching.reduce((s, t) => s + Number(t.amount || 0), 0);
    const limit = Number(item.dailyLimit || 0);
    const percentage = limit > 0 ? Math.round((todaySpent / limit) * 100) : 0;
    const status: 'safe' | 'warning' | 'exceeded' =
      limit > 0 && todaySpent > limit ? 'exceeded' : percentage >= 80 ? 'warning' : 'safe';

    if (item.isActive) {
      activeLimitsCount++;
      totalDailyBudget += limit;
      totalTodaySpent += todaySpent;
      if (status === 'exceeded') totalExceededCount++;
      else if (status === 'warning') totalWarningCount++;
      else totalSafeCount++;
    }

    return {
      ...item,
      todaySpent,
      percentage,
      status,
      todayCount: matching.length,
    };
  });

  return {
    limits,
    summary: {
      totalLimitsCount: limits.length,
      activeLimitsCount,
      totalDailyBudget,
      totalTodaySpent,
      totalExceededCount,
      totalWarningCount,
      totalSafeCount,
    },
  };
}

export function computePiggyBankSummary(store: UserDataStore, user?: UserProfile) {
  const funds: PiggyBankItem[] = store.piggyBankFunds || [];
  const totalInAllFunds = funds.reduce((s, f) => s + Number(f.currentBalance || 0), 0);
  const surplusFund = funds.find(f => f.isSurplusFund);
  const surplusFundBalance = Number(surplusFund?.currentBalance || 0);
  const totalAllocatedToGoals = funds
    .filter(f => !f.isSurplusFund)
    .reduce((s, f) => s + Number(f.currentBalance || 0), 0);
  const totalTargetGoals = funds
    .filter(f => !f.isSurplusFund)
    .reduce((s, f) => s + Number(f.targetAmount || 0), 0);

  const gullak = computeGullakSummary(store, user);
  const currentMonth = getIstDateTime().month;
  const alreadyCollected = (store.collectedSurplusMonths || []).includes(currentMonth);

  return {
    totalInAllFunds,
    surplusFundBalance,
    totalAllocatedToGoals,
    totalTargetGoals,
    currentMonthUncollectedSurplus: alreadyCollected ? 0 : gullak.currentMonthSaved,
    activeFundsCount: funds.length,
  };
}

export function recalculateFuelLogs(logs: FuelLog[]): FuelLog[] {
  const byVehicle: Record<string, FuelLog[]> = {};
  for (const log of logs) {
    const v = (log.vehicleName || 'Primary Vehicle').trim();
    if (!byVehicle[v]) byVehicle[v] = [];
    byVehicle[v].push({ ...log, vehicleName: v });
  }

  const result: FuelLog[] = [];
  for (const group of Object.values(byVehicle)) {
    group.sort((a, b) => a.odometer - b.odometer || a.date.localeCompare(b.date));
    for (let i = 0; i < group.length; i++) {
      const curr = group[i];
      if (i > 0) {
        const prev = group[i - 1];
        const dist = Math.max(0, curr.odometer - prev.odometer);
        curr.previousOdometer = prev.odometer;
        curr.distanceCovered = dist;
        if (dist > 0 && curr.fuelLiters && curr.fuelLiters > 0) {
          curr.calculatedMileage = Number((dist / curr.fuelLiters).toFixed(2));
        }
        if (dist > 0 && curr.fuelAmount > 0) {
          curr.costPerKm = Number((curr.fuelAmount / dist).toFixed(2));
        }
      }
      result.push(curr);
    }
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function processInvestmentAutoDebits(userId: string, store: UserDataStore): { processedCount: number } {
  const ist = getIstDateTime();
  const currentDay = Number(ist.date.slice(8, 10));
  const currentMonth = ist.month;
  let processedCount = 0;

  for (const inv of store.investments || []) {
    if (!inv.autoDebitEnabled || !inv.autoDebitDay || !inv.monthlyAmount) continue;
    if (inv.lastAutoDebitMonth === currentMonth) continue;
    if (currentDay < inv.autoDebitDay) continue;

    const txId = `tx_inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tx: Transaction = {
      id: txId,
      userId,
      type: 'expense',
      amount: Number(inv.monthlyAmount),
      category: 'Investments & Savings',
      description: `Auto SIP/RD: ${inv.name}`,
      date: ist.date,
      time: ist.time,
      paymentMethod: 'Bank Transfer',
      account: inv.account || 'AX Bank',
      source: 'wealth',
      createdAt: new Date().toISOString(),
      isInvestment: true,
    };

    store.transactions.unshift(tx);
    inv.amount = Number(inv.amount || 0) + Number(inv.monthlyAmount);
    inv.paidInstallments = Number(inv.paidInstallments || 0) + 1;
    inv.lastAutoDebitMonth = currentMonth;
    inv.autoDebitHistory = inv.autoDebitHistory || [];
    inv.autoDebitHistory.unshift({
      id: `ad_${Date.now()}`,
      date: ist.date,
      monthKey: currentMonth,
      amount: Number(inv.monthlyAmount),
      account: inv.account || 'AX Bank',
      linkedTxId: txId,
      createdAt: new Date().toISOString(),
    });
    processedCount++;
  }

  return { processedCount };
}
