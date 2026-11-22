import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccountBalancesData,
  BotConfig,
  CardEmi,
  CategoryBudget,
  CategoryDef,
  FinancialSummary,
  FuelLog,
  InvestmentRecord,
  SavingsTransfer,
  Transaction,
  UdhaarRecord,
  UserProfile,
  UserRole,
} from './types';
import { safeFetchJson, setAuthSession, setActiveUserId } from './utils/api';
import { syncCustomAccounts } from './utils/accounts';
import { DEFAULT_CATEGORIES } from './utils/categories';
import { getCurrentIstMonth } from './utils/formatters';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar, WorkspaceTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { WorkspaceToolbar } from './components/WorkspaceToolbar';
import { LedgerView } from './components/LedgerView';
import { AccountsView } from './components/AccountsView';
import { BudgetsGullakView } from './components/BudgetsGullakView';
import { WealthKhataView } from './components/WealthKhataView';
import { AnalyticsFuelView } from './components/AnalyticsFuelView';
import { TelegramAiView } from './components/TelegramAiView';
import { TransactionModal } from './components/TransactionModal';
import { BulkImportModal } from './components/BulkImportModal';
import { AuthModal } from './components/AuthModal';

const EMPTY_SUMMARY: FinancialSummary = {
  totalIncome: 0,
  totalExpense: 0,
  netSavings: 0,
  savingsRate: 0,
  transactionCount: 0,
  incomeCount: 0,
  expenseCount: 0,
  monthlyBudget: 0,
  monthlySpent: 0,
  dailyAverageExpense: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('ledger');
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  // Auth & Profile State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [usersList, setUsersList] = useState<UserProfile[]>([]);
  const [userRole, setUserRole] = useState<UserRole>('owner');
  const [activeFamilyMemberName, setActiveFamilyMemberName] = useState('Pooja');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Privacy & Month Filter
  const [isPrivacyMode, setIsPrivacyMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('teleexpense_privacy_mode') === 'true';
    } catch {
      return false;
    }
  });
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    try {
      return localStorage.getItem('teleexpense_selected_month') || getCurrentIstMonth();
    } catch {
      return getCurrentIstMonth();
    }
  });

  // Core Ledger State
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<FinancialSummary>(EMPTY_SUMMARY);
  const [categories, setCategories] = useState<CategoryDef[]>(DEFAULT_CATEGORIES);
  const [budgets, setBudgets] = useState<CategoryBudget[]>([]);
  const [balances, setBalances] = useState<AccountBalancesData | null>(null);
  const [udhaars, setUdhaars] = useState<UdhaarRecord[]>([]);
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>([]);
  const [investments, setInvestments] = useState<InvestmentRecord[]>([]);
  const [savingsTransfers, setSavingsTransfers] = useState<SavingsTransfer[]>([]);
  const [emis, setEmis] = useState<CardEmi[]>([]);
  const [botConfig, setBotConfig] = useState<BotConfig | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');

  // Modal & Loading State
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [authRequiredPrompt, setAuthRequiredPrompt] = useState(false);

  const availableMonths = useMemo(() => {
    const set = new Set<string>([getCurrentIstMonth()]);
    transactions.forEach((t) => {
      if (t.date && t.date.length >= 7) set.add(t.date.slice(0, 7));
    });
    return Array.from(set).sort().reverse();
  }, [transactions]);

  const fetchUsers = useCallback(async () => {
    const { data } = await safeFetchJson<{ user: UserProfile | null; users: UserProfile[] }>('/api/users/me');
    if (data?.users) setUsersList(data.users);
    if (data?.user) {
      setCurrentUser(data.user);
      setActiveUserId(data.user.id);
    }
  }, []);

  const fetchAllWorkspaceData = useCallback(async (monthArg?: string) => {
    const m = monthArg ?? selectedMonth;
    const [txRes, balRes, catRes, budRes, udhRes, fuelRes, invRes, savRes, emiRes, tgRes] =
      await Promise.all([
        safeFetchJson<{ transactions: Transaction[]; summary: FinancialSummary; customAccounts?: any[] }>(
          `/api/transactions?month=${encodeURIComponent(m)}`
        ),
        safeFetchJson<AccountBalancesData>('/api/accounts/balances'),
        safeFetchJson<{ categories: CategoryDef[] }>('/api/categories'),
        safeFetchJson<{ budgets: CategoryBudget[]; summary: FinancialSummary }>(
          `/api/budgets?month=${encodeURIComponent(m)}`
        ),
        safeFetchJson<{ udhaars: UdhaarRecord[] }>('/api/udhaar'),
        safeFetchJson<{ fuelLogs: FuelLog[] }>('/api/fuel'),
        safeFetchJson<{ investments: InvestmentRecord[] }>('/api/investments'),
        safeFetchJson<{ savingsTransfers: SavingsTransfer[] }>('/api/savings-transfers'),
        safeFetchJson<{ emis: CardEmi[] }>('/api/emis'),
        safeFetchJson<{ config: BotConfig; webhookUrl: string }>('/api/telegram/config'),
      ]);

    if (txRes.status === 401) {
      setAuthRequiredPrompt(true);
      setIsAuthModalOpen(true);
      return;
    }
    setAuthRequiredPrompt(false);

    if (txRes.data) {
      setTransactions(txRes.data.transactions || []);
      setSummary(txRes.data.summary || EMPTY_SUMMARY);
      if (txRes.data.customAccounts) syncCustomAccounts(txRes.data.customAccounts);
    }
    if (balRes.data) {
      setBalances(balRes.data);
      if (balRes.data.customAccounts) syncCustomAccounts(balRes.data.customAccounts);
    }
    if (catRes.data?.categories?.length) setCategories(catRes.data.categories);
    if (budRes.data?.budgets) setBudgets(budRes.data.budgets);
    if (udhRes.data?.udhaars) setUdhaars(udhRes.data.udhaars);
    if (fuelRes.data?.fuelLogs) setFuelLogs(fuelRes.data.fuelLogs);
    if (invRes.data?.investments) setInvestments(invRes.data.investments);
    if (savRes.data?.savingsTransfers) setSavingsTransfers(savRes.data.savingsTransfers);
    if (emiRes.data?.emis) setEmis(emiRes.data.emis);
    if (tgRes.data?.config) setBotConfig(tgRes.data.config);
    if (tgRes.data?.webhookUrl) setWebhookUrl(tgRes.data.webhookUrl);
  }, [selectedMonth]);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await fetchUsers();
      await fetchAllWorkspaceData();
      setIsLoading(false);
    };
    init();
  }, [fetchUsers, fetchAllWorkspaceData]);

  // Smart visibility-aware sync version check (every 12s when tab is active)
  const lastVersionRef = useRef<number | null>(null);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.hidden || authRequiredPrompt) return;
      const { data } = await safeFetchJson<{ v: number }>('/api/sync/version');
      if (data && typeof data.v === 'number') {
        if (lastVersionRef.current === null) {
          lastVersionRef.current = data.v;
        } else if (data.v !== lastVersionRef.current) {
          lastVersionRef.current = data.v;
          await fetchAllWorkspaceData();
        }
      }
    }, 12000);
    return () => clearInterval(timer);
  }, [fetchAllWorkspaceData, authRequiredPrompt]);

  const handleSelectMonth = (m: string) => {
    setSelectedMonth(m);
    try {
      localStorage.setItem('teleexpense_selected_month', m);
    } catch {}
    fetchAllWorkspaceData(m);
  };

  const handleTogglePrivacy = () => {
    setIsPrivacyMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('teleexpense_privacy_mode', String(next));
      } catch {}
      return next;
    });
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchUsers();
    await fetchAllWorkspaceData();
    setIsRefreshing(false);
  };

  const handleQuickParse = async (text: string) => {
    const { error } = await safeFetchJson('/api/transactions/quick-parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (error) throw new Error(error);
    await fetchAllWorkspaceData();
  };

  const handleSaveTransaction = async (payload: Partial<Transaction>, editId?: string) => {
    const url = editId ? `/api/transactions/${editId}` : '/api/transactions';
    const method = editId ? 'PUT' : 'POST';
    const { error } = await safeFetchJson(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (error) throw new Error(error);
    await fetchAllWorkspaceData();
  };

  const handleDeleteTransaction = async (id: string) => {
    await safeFetchJson(`/api/transactions/${id}`, { method: 'DELETE' });
    await fetchAllWorkspaceData();
  };

  const handleBulkDeleteTransactions = async (ids: string[]) => {
    if (ids.length === 0) return;
    const { error } = await safeFetchJson('/api/transactions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (error) throw new Error(error);
    await fetchAllWorkspaceData();
  };

  const handleUpdateCategory = async (id: string, category: string) => {
    await safeFetchJson(`/api/transactions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    await fetchAllWorkspaceData();
  };

  const handleToggleCategoryExclude = async (id: string, excludeFromBudget: boolean) => {
    await safeFetchJson(`/api/categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludeFromBudget }),
    });
    await fetchAllWorkspaceData();
  };

  const handleBulkToggleCategoryExclude = async (excludeFromBudget: boolean) => {
    await safeFetchJson('/api/categories/bulk-exclude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludeFromBudget }),
    });
    await fetchAllWorkspaceData();
  };

  const handleSettleReimbursement = async (
    id: string,
    accountOrPayload: string | { account: string; amount?: number; date?: string; note?: string }
  ) => {
    const payload =
      typeof accountOrPayload === 'string'
        ? { account: accountOrPayload }
        : accountOrPayload;
    const { error } = await safeFetchJson(`/api/transactions/${id}/settle-reimbursement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (error) throw new Error(error);
    await fetchAllWorkspaceData();
  };

  const handleSettleAllReimbursements = async (account: string) => {
    await safeFetchJson('/api/transactions/settle-all-reimbursements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account }),
    });
    await fetchAllWorkspaceData();
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          currentUser={currentUser}
          userRole={userRole}
          activeFamilyMemberName={activeFamilyMemberName}
          onOpenAuth={() => setIsAuthModalOpen(true)}
          isMobileOpen={isMobileNavOpen}
          onCloseMobile={() => setIsMobileNavOpen(false)}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          <TopBar
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            onOpenMobileNav={() => setIsMobileNavOpen(true)}
            onOpenAddModal={() => {
              setEditingTx(null);
              setIsTxModalOpen(true);
            }}
          />

          <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
            <WorkspaceToolbar
              selectedMonth={selectedMonth}
              availableMonths={availableMonths}
              onSelectMonth={handleSelectMonth}
              userRole={userRole}
              onToggleRole={setUserRole}
              isPrivacyMode={isPrivacyMode}
              onTogglePrivacy={handleTogglePrivacy}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              transactionCount={transactions.length}
            />

            {activeTab === 'ledger' && (
              <LedgerView
                transactions={transactions}
                summary={summary}
                categories={categories}
                balances={balances}
                investments={investments}
                udhaars={udhaars}
                selectedMonth={selectedMonth}
                userRole={userRole}
                activeFamilyMemberName={activeFamilyMemberName}
                isPrivacyMode={isPrivacyMode}
                isLoading={isLoading}
                onQuickParse={handleQuickParse}
                onOpenAddModal={() => {
                  setEditingTx(null);
                  setIsTxModalOpen(true);
                }}
                onOpenBulkImport={() => setIsBulkModalOpen(true)}
                onEditTransaction={(tx) => {
                  setEditingTx(tx);
                  setIsTxModalOpen(true);
                }}
                onDeleteTransaction={handleDeleteTransaction}
                onBulkDeleteTransactions={handleBulkDeleteTransactions}
                onUpdateCategory={handleUpdateCategory}
                onToggleCategoryExclude={handleToggleCategoryExclude}
                onBulkToggleCategoryExclude={handleBulkToggleCategoryExclude}
                onSettleReimbursement={handleSettleReimbursement}
              />
            )}

            {activeTab === 'accounts' && (
              <AccountsView
                balances={balances}
                transactions={transactions}
                emis={emis}
                savingsTransfers={savingsTransfers}
                isPrivacyMode={isPrivacyMode}
                onUpdateBaseBalance={async (accountId, balance) => {
                  await safeFetchJson('/api/accounts/balances', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      accountBaseBalances: { [accountId]: balance },
                      resetTimestampForAccount: accountId,
                    }),
                  });
                  await fetchAllWorkspaceData();
                }}
                onUpdateCardLimit={async (cardId, limit) => {
                  await safeFetchJson('/api/accounts/balances', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cardCreditLimits: { [cardId]: limit } }),
                  });
                  await fetchAllWorkspaceData();
                }}
                onAddCustomAccount={async (payload) => {
                  await safeFetchJson('/api/accounts/custom', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  await fetchAllWorkspaceData();
                }}
                onUpdateAccount={async (accountId, payload) => {
                  const { error } = await safeFetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  if (error) throw new Error(error);
                  await fetchAllWorkspaceData();
                }}
                onSettleCardDue={async (cardId, payload) => {
                  const { error } = await safeFetchJson(`/api/accounts/${encodeURIComponent(cardId)}/settle-card`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  if (error) throw new Error(error);
                  await fetchAllWorkspaceData();
                }}
                onDeleteCustomAccount={async (id) => {
                  await safeFetchJson(`/api/accounts/custom/${encodeURIComponent(id)}`, { method: 'DELETE' });
                  await fetchAllWorkspaceData();
                }}
                onAddEmi={async (payload) => {
                  await safeFetchJson('/api/emis', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  await fetchAllWorkspaceData();
                }}
                onUpdateEmi={async (id, patch) => {
                  await safeFetchJson(`/api/emis/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                  });
                  await fetchAllWorkspaceData();
                }}
                onDeleteEmi={async (id) => {
                  await safeFetchJson(`/api/emis/${id}`, { method: 'DELETE' });
                  await fetchAllWorkspaceData();
                }}
                onAddSavingsTransfer={async (payload) => {
                  await safeFetchJson('/api/savings-transfers', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  await fetchAllWorkspaceData();
                }}
                onDeleteSavingsTransfer={async (id) => {
                  await safeFetchJson(`/api/savings-transfers/${id}`, { method: 'DELETE' });
                  await fetchAllWorkspaceData();
                }}
                onUpdateWifeBase={async (balance) => {
                  await safeFetchJson('/api/accounts/balances', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ wifeBaseBalance: balance }),
                  });
                  await fetchAllWorkspaceData();
                }}
              />
            )}

            {activeTab === 'budgets' && (
              <BudgetsGullakView
                budgets={budgets}
                categories={categories}
                transactions={transactions}
                selectedMonth={selectedMonth}
                isPrivacyMode={isPrivacyMode}
                onSaveBudgets={async (newBudgets) => {
                  await safeFetchJson('/api/budgets', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newBudgets }),
                  });
                  await fetchAllWorkspaceData();
                }}
                onAddCategory={async (cat) => {
                  await safeFetchJson('/api/categories', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(cat),
                  });
                  await fetchAllWorkspaceData();
                }}
                onToggleCategoryExclude={handleToggleCategoryExclude}
                onDeleteCategory={async (id) => {
                  await safeFetchJson(`/api/categories/${id}`, { method: 'DELETE' });
                  await fetchAllWorkspaceData();
                }}
                onRefreshAll={() => fetchAllWorkspaceData()}
              />
            )}

            {activeTab === 'wealth' && (
              <WealthKhataView
                udhaars={udhaars}
                investments={investments}
                transactions={transactions}
                isPrivacyMode={isPrivacyMode}
                onRefreshAll={() => fetchAllWorkspaceData()}
                onSettleReimbursement={handleSettleReimbursement}
                onSettleAllReimbursements={handleSettleAllReimbursements}
              />
            )}

            {activeTab === 'analytics' && (
              <AnalyticsFuelView
                transactions={transactions}
                categories={categories}
                fuelLogs={fuelLogs}
                selectedMonth={selectedMonth}
                isPrivacyMode={isPrivacyMode}
                onRefreshAll={() => fetchAllWorkspaceData()}
              />
            )}

            {activeTab === 'telegram' && (
              <TelegramAiView
                currentUser={currentUser}
                botConfig={botConfig}
                webhookUrl={webhookUrl}
                selectedMonth={selectedMonth}
                isPrivacyMode={isPrivacyMode}
                onRefreshAll={async () => {
                  await fetchUsers();
                  await fetchAllWorkspaceData();
                }}
              />
            )}
          </main>
        </div>

        <TransactionModal
          isOpen={isTxModalOpen}
          onClose={() => {
            setIsTxModalOpen(false);
            setEditingTx(null);
          }}
          onSave={handleSaveTransaction}
          categories={categories}
          editingTx={editingTx}
        />

        <BulkImportModal
          isOpen={isBulkModalOpen}
          onClose={() => setIsBulkModalOpen(false)}
          categories={categories}
          onImported={async (importedMonths) => {
            let nextMonth = selectedMonth;
            if (
              selectedMonth !== 'all' &&
              importedMonths.length > 0 &&
              !importedMonths.includes(selectedMonth)
            ) {
              nextMonth = importedMonths.length > 1 ? 'all' : importedMonths[0];
              setSelectedMonth(nextMonth);
              try {
                localStorage.setItem('teleexpense_selected_month', nextMonth);
              } catch {}
            }
            await fetchAllWorkspaceData(nextMonth);
          }}
        />

        <AuthModal
          isOpen={isAuthModalOpen}
          onClose={() => setIsAuthModalOpen(false)}
          currentUser={currentUser}
          usersList={usersList}
          onAuthenticated={async (user, token, meta) => {
            setCurrentUser(user);
            setUserRole(meta?.role || 'owner');
            if (meta?.memberName) setActiveFamilyMemberName(meta.memberName);
            setAuthSession(user.id, token, meta);
            await fetchAllWorkspaceData();
          }}
          onRefreshUsers={fetchUsers}
          onMigrated={async () => {
            await fetchUsers();
            await fetchAllWorkspaceData();
          }}
        />
      </div>
    </ErrorBoundary>
  );
}
