export type TransactionType = 'income' | 'expense';

export type PaymentMethod =
  | 'UPI'
  | 'Wife'
  | 'Cash'
  | 'Card'
  | 'Net Banking'
  | 'Bank Transfer'
  | 'UPI/Cash'
  | 'Other';

export type UserRole = 'owner' | 'family';

export interface AccountMeta {
  id: string;
  name: string;
  shortName: string;
  type: 'rupay_card' | 'credit_card' | 'bank_account' | 'cash';
  badge: string;
  color: string;
  isUpiCapable?: boolean;
  creditLimit?: number;
  billingDay?: number;
  paymentDueDay?: number;
  isCustom?: boolean;
}

export interface LinkedMember {
  id: string;
  name: string;
  customAlias?: string;
  role?: 'owner' | 'member' | 'partner' | 'family';
  telegramChatId: string;
  telegramUsername?: string;
  linkedAt: string;
}

export interface PendingMemberRequest {
  id: string;
  chatId: string;
  name: string;
  telegramUsername?: string;
  linkCode: string;
  requestedAt: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  passwordHash?: string;
  password?: string; // legacy plaintext field auto-migrated on read/login
  telegramChatId?: string;
  telegramUsername?: string;
  linkedMembers?: LinkedMember[];
  pendingRequests?: PendingMemberRequest[];
  linkCode: string;
  createdAt: string;
  trackingStartMonth?: string;
}

export interface Transaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  category: string;
  description: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm
  paymentMethod?: PaymentMethod;
  account?: string;
  source: 'telegram' | 'manual' | 'simulator' | 'import' | 'wealth';
  telegramChatId?: string;
  telegramMessageId?: number;
  telegramUser?: string;
  rawMessage?: string;
  createdAt: string;
  tags?: string[];
  isReimbursement?: boolean;
  isReimbursementInflow?: boolean;
  reimbursementStatus?: 'pending' | 'settled' | 'partial';
  reimbursementSettledAmount?: number;
  settledInAccount?: string;
  settledDate?: string;
  isSavingsTransfer?: boolean;
  isWifeTransfer?: boolean;
  isCcPayment?: boolean;
  ccSettledCardId?: string;
  isInvestment?: boolean;
  isUdhaarLent?: boolean;
  isUdhaarRecovery?: boolean;
  isUdhaarRepaid?: boolean;
  linkedUdhaarId?: string;
  udhaarPersonName?: string;
  linkedTransferId?: string;
}

export interface CategoryDef {
  id: string;
  name: string;
  type: TransactionType | 'both';
  icon: string;
  color: string;
  bgLight?: string;
  keywords: string[];
  isCustom?: boolean;
  isDefault?: boolean;
  description?: string;
  excludeFromBudget?: boolean;
}

export interface CategoryBudget {
  category: string;
  limit: number;
  spent?: number;
  period: 'monthly';
}

export interface TelegramLog {
  id: string;
  userId?: string;
  timestamp: string;
  type: 'incoming_message' | 'webhook_setup' | 'webhook_error' | 'bot_reply' | 'parse_error';
  chatId?: string;
  user?: string;
  rawText?: string;
  parsedTransactions?: Array<{
    type: TransactionType;
    amount: number;
    category: string;
    description: string;
  }>;
  botReply?: string;
  status: 'success' | 'warning' | 'error';
  details?: string;
}

export interface BotConfig {
  botToken: string;
  botUsername?: string;
  botName?: string;
  webhookUrl?: string;
  isWebhookSet: boolean;
  isConnected?: boolean;
  lastWebhookCheck?: string;
  pendingUpdateCount?: number;
  lastError?: string;
}

export interface CardEmi {
  id: string;
  userId: string;
  cardId: string;
  title: string;
  monthlyAmount: number;
  totalMonths: number;
  paidMonths: number;
  dueDay: number;
  startDate: string;
  notes?: string;
  createdAt: string;
}

export interface SavingsTransfer {
  id: string;
  userId: string;
  amount: number;
  date: string;
  recipient: string;
  fromAccount: string;
  notes?: string;
  linkedTransactionId?: string;
  createdAt: string;
}

export interface InvestmentAutoDebitEntry {
  id: string;
  date: string;
  monthKey: string;
  amount: number;
  account: string;
  linkedTxId: string;
  createdAt: string;
}

export interface InvestmentRecord {
  id: string;
  userId: string;
  type: 'RD' | 'FD' | 'Mutual Fund' | 'Insurance' | 'Gold' | 'PPF' | 'Other';
  name: string;
  amount: number;
  monthlyAmount?: number;
  paidInstallments?: number;
  totalInstallments?: number;
  installmentFrequency?: 'monthly' | 'quarterly' | 'yearly';
  account: string;
  date: string;
  maturityDate?: string;
  interestRate?: number;
  currentValue?: number;
  maturityAmount?: number;
  autoDebitEnabled?: boolean;
  autoDebitDay?: number;
  lastAutoDebitMonth?: string;
  autoDebitHistory?: InvestmentAutoDebitEntry[];
  notes?: string;
  createdAt: string;
}

export interface UdhaarSettlementEntry {
  id: string;
  amount: number;
  account: string;
  date: string;
  notes?: string;
  linkedTxId?: string;
  createdAt: string;
}

export interface UdhaarRecord {
  id: string;
  userId: string;
  type: 'lent' | 'borrowed';
  personName: string;
  amount: number;
  settledAmount?: number;
  settledInAccount?: string;
  settlementHistory?: UdhaarSettlementEntry[];
  description?: string;
  date: string;
  time?: string;
  status: 'pending' | 'partial' | 'settled';
  account?: string;
  linkedTransactionId?: string;
  settledAt?: string;
  createdAt: string;
}

export interface FuelLog {
  id: string;
  userId: string;
  date: string;
  time?: string;
  vehicleName?: string;
  fuelAmount: number;
  fuelLiters?: number;
  odometer: number;
  previousOdometer?: number;
  distanceCovered?: number;
  calculatedMileage?: number;
  costPerKm?: number;
  notes?: string;
  createdAt: string;
}

export interface DailyItemLimit {
  id: string;
  userId?: string;
  itemName: string;
  dailyLimit: number;
  keywords: string[];
  category: string;
  notes?: string;
  isActive: boolean;
  todaySpent?: number;
  status?: 'safe' | 'warning' | 'exceeded';
  percentage?: number;
  todayCount?: number;
  createdAt?: string;
}

export interface PiggyBankItem {
  id: string;
  userId?: string;
  name: string;
  category: 'general' | 'emergency' | 'goal' | 'travel' | 'investment' | 'vehicle' | 'home' | 'health';
  targetAmount?: number;
  currentBalance: number;
  icon?: string;
  color?: string;
  notes?: string;
  isSurplusFund?: boolean;
  targetDate?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface PiggyBankTransaction {
  id: string;
  userId?: string;
  fundId: string;
  fundName?: string;
  type: 'deposit' | 'withdraw' | 'transfer_in' | 'transfer_out' | 'surplus_collect';
  amount: number;
  sourceFundId?: string;
  targetFundId?: string;
  notes?: string;
  date: string;
  createdAt: string;
}

export interface UserDataStore {
  transactions: Transaction[];
  budgets: CategoryBudget[];
  categories: CategoryDef[];
  udhaars: UdhaarRecord[];
  cardEmis: CardEmi[];
  savingsTransfers: SavingsTransfer[];
  investments: InvestmentRecord[];
  fuelLogs: FuelLog[];
  dailyItemLimits: DailyItemLimit[];
  piggyBankFunds: PiggyBankItem[];
  piggyBankTransactions: PiggyBankTransaction[];
  collectedSurplusMonths?: string[];
  dataVersion: number;
  accountBaseBalances: Record<string, number>;
  accountBalanceSetTimestamps: Record<string, string>;
  wifeBaseBalance: number;
  wifeBalanceSetTimestamp?: string;
  cardCreditLimits: Record<string, number>;
  customAccounts: AccountMeta[];
  deletedCategories: string[];
}

export interface FinancialSummary {
  totalIncome: number;
  totalExpense: number;
  personalExpense: number;
  pendingReimbursements: number;
  savingsTransfers: number;
  investmentsTotal: number;
  netSavings: number;
  savingsRate: number;
  transactionCount: number;
  incomeCount: number;
  expenseCount: number;
  monthlyBudget: number;
  monthlySpent: number;
  dailyAverageExpense: number;
  currentMonthIncome: number;
  currentMonthTotalExpense: number;
  currentMonthPersonalExpense: number;
  currentMonthNetSavings: number;
  currentMonthCount: number;
  openingCarryforward: number;
  totalNetSavings: number;
  cashBalance: number;
  totalCashBalance: number;
  udhaarLentTotal: number;
  currentMonthUdhaarLent: number;
  pendingUdhaarBakaya: number;
  currentMonthUdhaarBakaya: number;
}

export interface AccountBalanceInfo {
  accountId: string;
  name: string;
  shortName: string;
  type: 'rupay_card' | 'credit_card' | 'bank_account' | 'cash';
  badge: string;
  baseBalance: number;
  credits: number;
  debits: number;
  currentBalance: number;
  creditLimit?: number;
  availableLimit?: number;
  currentOutstanding?: number;
  billingDay?: number;
  paymentDueDay?: number;
  isDefault?: boolean;
}

export interface AccountBalancesData {
  accountBaseBalances: Record<string, number>;
  accountBalanceSetTimestamps: Record<string, string>;
  wifeBaseBalance: number;
  wifeBalanceSetTimestamp?: string;
  cardCreditLimits: Record<string, number>;
  customAccounts: AccountMeta[];
  accounts: Record<string, AccountBalanceInfo>;
  totalBankCashBalance: number;
  totalCardAvailableLimit: number;
  totalCardOutstanding: number;
  wifeSavings: {
    baseBalance: number;
    totalTransferred: number;
    currentBalance: number;
  };
}
