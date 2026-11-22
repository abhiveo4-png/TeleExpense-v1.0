import React, { useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Download, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  CategoryBudget,
  CategoryDef,
  DailyItemLimit,
  DailyLimitsSummary,
  GullakSummary,
  Transaction,
} from '../types';
import { downloadAuthenticatedFile, safeFetchJson } from '../utils/api';
import { formatMoney } from '../utils/formatters';

const CORE_SYSTEM_CAT_NAMES = new Set(['reimbursement', 'wife transfer', 'cc payment', 'udhaar given']);
const isCoreSystemCategory = (cat: CategoryDef) =>
  ['reimbursement', 'wife_transfer', 'cc_payment', 'udhaar_given'].includes(cat.id) ||
  CORE_SYSTEM_CAT_NAMES.has(cat.name.trim().toLowerCase());

interface BudgetsGullakViewProps {
  budgets: CategoryBudget[];
  categories: CategoryDef[];
  transactions: Transaction[];
  selectedMonth: string;
  isPrivacyMode: boolean;
  onSaveBudgets: (budgets: CategoryBudget[]) => Promise<void>;
  onAddCategory: (cat: {
    name: string;
    type: 'expense' | 'income' | 'both';
    keywords: string[];
    color: string;
    excludeFromBudget?: boolean;
  }) => Promise<void>;
  onToggleCategoryExclude?: (id: string, excludeFromBudget: boolean) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
  onRefreshAll: () => Promise<void>;
}

export const BudgetsGullakView: React.FC<BudgetsGullakViewProps> = ({
  budgets,
  categories,
  transactions,
  selectedMonth,
  isPrivacyMode,
  onSaveBudgets,
  onAddCategory,
  onToggleCategoryExclude,
  onDeleteCategory,
  onRefreshAll,
}) => {
  const [subTab, setSubTab] = useState<'budgets' | 'gullak' | 'daily' | 'categories'>('budgets');
  const [draftLimits, setDraftLimits] = useState<Record<string, number>>({});
  const [savingBudgets, setSavingBudgets] = useState(false);

  // Import & Replace Controls (shared across Budgets & Categories tabs)
  const [replaceExistingOnImport, setReplaceExistingOnImport] = useState(true);
  const [remapTxsOnImport, setRemapTxsOnImport] = useState(true);
  const [isImportingBudgets, setIsImportingBudgets] = useState(false);
  const [isRecalculatingTxs, setIsRecalculatingTxs] = useState(false);
  const [importFeedback, setImportFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Inline Edit Category State (allows editing/replacing pre-updated categories too)
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatKeywords, setEditCatKeywords] = useState('');
  const [editCatColor, setEditCatColor] = useState('#38BDF8');
  const [editCatExcludeSpend, setEditCatExcludeSpend] = useState(false);
  const [savingCatEdit, setSavingCatEdit] = useState(false);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);
  const [catSpendFilter, setCatSpendFilter] = useState<'all' | 'included' | 'excluded'>('all');

  const [gullak, setGullak] = useState<GullakSummary | null>(null);
  const [dailyLimits, setDailyLimits] = useState<DailyItemLimit[]>([]);
  const [dailySummary, setDailySummary] = useState<DailyLimitsSummary | null>(null);

  // New daily habit form
  const [dlName, setDlName] = useState('');
  const [dlLimit, setDlLimit] = useState('');
  const [dlKeywords, setDlKeywords] = useState('');

  // New category form
  const [catName, setCatName] = useState('');
  const [catType, setCatType] = useState<'expense' | 'income'>('expense');
  const [catKeywords, setCatKeywords] = useState('');
  const [catColor, setCatColor] = useState('#38BDF8');
  const [catExcludeSpend, setCatExcludeSpend] = useState(false);

  useEffect(() => {
    const map: Record<string, number> = {};
    budgets.forEach((b) => {
      map[b.category] = b.limit;
    });
    setDraftLimits(map);
  }, [budgets]);

  const loadExtras = async () => {
    const [gRes, dRes] = await Promise.all([
      safeFetchJson<GullakSummary>('/api/gullak'),
      safeFetchJson<{ limits: DailyItemLimit[]; summary: DailyLimitsSummary }>('/api/daily-limits'),
    ]);
    if (gRes.data) setGullak(gRes.data);
    if (dRes.data) {
      setDailyLimits(dRes.data.limits || []);
      setDailySummary(dRes.data.summary || null);
    }
  };

  useEffect(() => {
    loadExtras();
  }, [budgets]);

  const categoriesByLower = useMemo(() => {
    const map = new Map<string, CategoryDef>();
    for (const c of categories) {
      map.set(c.name.trim().toLowerCase(), c);
    }
    return map;
  }, [categories]);

  const excludedExpenseCategories = useMemo(
    () => categories.filter((c) => c.type !== 'income' && Boolean(c.excludeFromBudget)),
    [categories]
  );

  const filteredCategories = useMemo(() => {
    if (catSpendFilter === 'all') return categories;
    if (catSpendFilter === 'excluded') {
      return categories.filter((c) => c.type !== 'income' && Boolean(c.excludeFromBudget));
    }
    return categories.filter((c) => c.type !== 'income' && !c.excludeFromBudget);
  }, [categories, catSpendFilter]);

  const handleToggleExclude = async (cat: CategoryDef) => {
    if (togglingCatId) return;
    const nextVal = !Boolean(cat.excludeFromBudget);
    setTogglingCatId(cat.id);
    try {
      if (onToggleCategoryExclude) {
        await onToggleCategoryExclude(cat.id, nextVal);
      } else {
        await safeFetchJson(`/api/categories/${encodeURIComponent(cat.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ excludeFromBudget: nextVal }),
        });
        await onRefreshAll();
      }
    } finally {
      setTogglingCatId(null);
    }
  };

  // Live category-wise totals computed directly from active transaction records
  const categoryStatsFromTxs = useMemo(() => {
    const stats = new Map<string, { amount: number; count: number }>();
    const isAll = selectedMonth === 'all';
    for (const tx of transactions) {
      if (!isAll && !tx.date?.startsWith(selectedMonth)) continue;
      const key = (tx.category || '').trim().toLowerCase();
      const catDef = categoriesByLower.get(key);
      const hasNonPersonalFlag = Boolean(
        tx.isReimbursement || tx.isCcPayment || tx.isUdhaarLent || tx.isWifeTransfer || tx.isSavingsTransfer
      );
      if (tx.type === 'expense' && hasNonPersonalFlag && catDef?.excludeFromBudget !== false) {
        continue;
      }
      const prev = stats.get(key) || { amount: 0, count: 0 };
      prev.amount += Number(tx.amount || 0);
      prev.count += 1;
      stats.set(key, prev);
    }
    return stats;
  }, [transactions, selectedMonth, categoriesByLower]);

  const handleDownloadTemplate = async () => {
    setImportFeedback(null);
    const res = await downloadAuthenticatedFile('/api/budgets/template', 'teleexpense-budgets-template.xlsx');
    if (!res.ok) {
      setImportFeedback({ type: 'error', text: res.error || 'Could not download budget template.' });
    }
  };

  const handleImportBudgetExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsImportingBudgets(true);
    setImportFeedback(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const { data, error } = await safeFetchJson<{
        success?: boolean;
        updated?: number;
        removedOldCount?: number;
        transactionsUpdated?: number;
        mode?: string;
      }>('/api/budgets/import-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows,
          replaceExisting: replaceExistingOnImport,
          remapTransactions: remapTxsOnImport,
        }),
      });
      if (error || !data?.success) {
        setImportFeedback({ type: 'error', text: error || 'Failed to import categories & budgets.' });
        return;
      }
      await onRefreshAll();
      await loadExtras();
      setImportFeedback({
        type: 'success',
        text:
          data.mode === 'replace'
            ? `Imported ${data.updated ?? 0} categories (replaced ${data.removedOldCount ?? 0} old categories) · Updated ${data.transactionsUpdated ?? 0} transactions & recalculated category amounts.`
            : `Updated ${data.updated ?? 0} categories & budgets · Updated ${data.transactionsUpdated ?? 0} transactions.`,
      });
    } finally {
      setIsImportingBudgets(false);
      e.target.value = '';
    }
  };

  const handleRecalculateFromTransactions = async (forceAll = false) => {
    if (isRecalculatingTxs) return;
    setIsRecalculatingTxs(true);
    setImportFeedback(null);
    try {
      const { data, error } = await safeFetchJson<{ success?: boolean; updatedCount?: number }>(
        '/api/transactions/recategorize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forceAll }),
        }
      );
      if (error || !data?.success) {
        setImportFeedback({ type: 'error', text: error || 'Could not sync transactions to categories.' });
        return;
      }
      await onRefreshAll();
      await loadExtras();
      setImportFeedback({
        type: 'success',
        text: `Synced category-wise totals from transaction records (${data.updatedCount ?? 0} transactions remapped).`,
      });
    } finally {
      setIsRecalculatingTxs(false);
    }
  };

  const renderImportControlsBar = () => (
    <div className="surface-panel rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-white">
            Import Categories &amp; Budgets (Excel / CSV)
          </div>
          <p className="text-[11px] text-slate-400">
            Columns: <code className="text-slate-300">Category</code>, <code className="text-slate-300">MonthlyLimitINR</code>, optional{' '}
            <code className="text-slate-300">Keywords</code> &amp; <code className="text-slate-300">OldCategoryMap</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-white/[0.08] hover:border-white/20 rounded-lg whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Template</span>
          </button>

          <button
            type="button"
            disabled={isRecalculatingTxs}
            onClick={() => handleRecalculateFromTransactions(false)}
            title="Match unmatched transactions to your current categories & refresh amounts"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-white/[0.08] hover:border-white/20 rounded-lg whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRecalculatingTxs ? 'animate-spin' : ''}`} />
            <span>{isRecalculatingTxs ? 'Syncing...' : 'Sync from Transactions'}</span>
          </button>

          <label
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0 ${
              isImportingBudgets ? 'opacity-60 pointer-events-none' : 'cursor-pointer'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{isImportingBudgets ? 'Importing...' : replaceExistingOnImport ? 'Import & Replace Old' : 'Import & Merge'}</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleImportBudgetExcel}
              disabled={isImportingBudgets}
              className="hidden"
            />
          </label>
        </div>
      </div>

      <div className="pt-2.5 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="inline-flex rounded-lg bg-[#0B0F17] p-0.5 border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setReplaceExistingOnImport(true)}
              className={`px-2.5 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
                replaceExistingOnImport
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Replace Pre-Updated Categories
            </button>
            <button
              type="button"
              onClick={() => setReplaceExistingOnImport(false)}
              className={`px-2.5 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
                !replaceExistingOnImport
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Add / Update Only
            </button>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remapTxsOnImport}
              onChange={(e) => setRemapTxsOnImport(e.target.checked)}
              className="rounded border-slate-600 bg-[#0B0F17] text-sky-400 focus:ring-sky-400"
            />
            <span>Auto-update transaction records to new categories</span>
          </label>
        </div>

        <span className="text-[11px] text-slate-500">
          {replaceExistingOnImport
            ? 'Old pre-updated expense categories & limits are removed and replaced cleanly.'
            : 'Keeps existing categories and only updates or adds imported ones.'}
        </span>
      </div>

      {importFeedback && (
        <div
          className={`p-2.5 rounded-lg border text-xs flex items-center gap-2 ${
            importFeedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
          }`}
        >
          {importFeedback.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>{importFeedback.text}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex p-1 bg-[#111827] border border-white/[0.08] rounded-lg overflow-x-auto">
          {[
            { id: 'budgets', label: 'Monthly Budgets' },
            { id: 'gullak', label: 'Gullak Surplus' },
            { id: 'daily', label: 'Daily Item Caps' },
            { id: 'categories', label: 'Categories' },
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
      </div>

      {(subTab === 'budgets' || subTab === 'categories') && renderImportControlsBar()}

      {subTab === 'budgets' && (
        <section className="surface-panel rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-white">Category Spending Limits</h2>
              <p className="text-xs text-slate-400">
                Live category-wise amounts from your transaction records ({selectedMonth === 'all' ? 'All Months' : selectedMonth}).
              </p>
            </div>
            <button
              type="button"
              disabled={savingBudgets}
              onClick={async () => {
                setSavingBudgets(true);
                const payload = budgets.map((b) => ({
                  ...b,
                  limit: Number(draftLimits[b.category] ?? b.limit),
                }));
                await onSaveBudgets(payload);
                setSavingBudgets(false);
              }}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {savingBudgets ? 'Saving...' : 'Save Limits'}
            </button>
          </div>

          {budgets.length === 0 ? (
            <p className="px-6 py-8 text-xs text-slate-400 text-center">
              No budget categories configured yet. Import an Excel/CSV sheet above or add a category.
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {budgets.map((b) => {
                const limit = draftLimits[b.category] ?? b.limit;
                const catDef = categoriesByLower.get(b.category.trim().toLowerCase());
                const isExcluded = Boolean(catDef?.excludeFromBudget);
                const txStat = categoryStatsFromTxs.get(b.category.trim().toLowerCase());
                const spent = txStat ? txStat.amount : Number(b.spent || 0);
                const txCount = txStat ? txStat.count : Number(b.txCount || 0);
                const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
                const isOver = limit > 0 && spent > limit;
                return (
                  <div key={b.category} className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-white truncate">
                            {b.category}{' '}
                            <span className="text-xs font-normal text-slate-500 font-mono tabular-nums">
                              · {txCount} {txCount === 1 ? 'txn' : 'txns'}
                            </span>
                          </span>
                          {isExcluded && (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/25 whitespace-nowrap">
                              Excluded from Personal Spend
                            </span>
                          )}
                        </div>
                        <span className="text-xs font-mono tabular-nums text-slate-400">
                          Spent {formatMoney(spent, isPrivacyMode)} / {formatMoney(limit, isPrivacyMode)} ({pct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${isOver ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-500">₹</span>
                      <input
                        type="number"
                        min="0"
                        value={limit}
                        onChange={(e) =>
                          setDraftLimits((prev) => ({
                            ...prev,
                            [b.category]: Number(e.target.value || 0),
                          }))
                        }
                        className="w-28 px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg field-input"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {subTab === 'gullak' && (
        <div className="space-y-6">
          <section className="surface-panel rounded-xl grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.08]">
            <div className="p-5">
              <div className="text-xs text-slate-400">Total Gullak Savings</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1">
                {formatMoney(gullak?.totalGullakSavings || 0, isPrivacyMode)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Since {gullak?.trackingStartMonth || 'current month'}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-400">Current Month Unspent</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-white mt-1">
                {formatMoney(gullak?.currentMonthSaved || 0, isPrivacyMode)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-400">Settled Past Months</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-sky-400 mt-1">
                {formatMoney(gullak?.pastMonthsSaved || 0, isPrivacyMode)}
              </div>
            </div>
          </section>

          <section className="surface-panel rounded-xl p-5 space-y-3">
            <h3 className="font-display text-base font-semibold text-white">Category Surplus Breakdown</h3>
            <div className="divide-y divide-white/[0.06]">
              {(gullak?.categoryBreakdown || []).map((c) => (
                <div key={c.category} className="py-3 flex items-center justify-between text-sm">
                  <span className="text-slate-200">{c.category}</span>
                  <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                    {formatMoney(c.totalSaved, isPrivacyMode)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {subTab === 'daily' && (
        <div className="space-y-6">
          <section className="surface-panel rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-white">Daily Micro-Habit Caps</h2>
                <p className="text-xs text-slate-400">
                  Today: {formatMoney(dailySummary?.totalTodaySpent || 0, isPrivacyMode)} spent of{' '}
                  {formatMoney(dailySummary?.totalDailyBudget || 0, isPrivacyMode)} daily cap
                </p>
              </div>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!dlName.trim() || !dlLimit) return;
                await safeFetchJson('/api/daily-limits', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    itemName: dlName.trim(),
                    dailyLimit: Number(dlLimit),
                    keywords: dlKeywords.split(',').map((s) => s.trim()).filter(Boolean),
                  }),
                });
                setDlName('');
                setDlLimit('');
                setDlKeywords('');
                await loadExtras();
              }}
              className="grid grid-cols-1 sm:grid-cols-4 gap-2"
            >
              <input
                type="text"
                placeholder="Item (e.g. Chai & Snacks)"
                value={dlName}
                onChange={(e) => setDlName(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <input
                type="number"
                placeholder="Daily Limit ₹"
                value={dlLimit}
                onChange={(e) => setDlLimit(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg field-input"
              />
              <input
                type="text"
                placeholder="Keywords: chai, coffee, samosa"
                value={dlKeywords}
                onChange={(e) => setDlKeywords(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
              >
                Add Daily Cap
              </button>
            </form>

            {dailyLimits.length === 0 ? (
              <p className="text-xs text-slate-400 py-4">No daily item limits configured yet.</p>
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {dailyLimits.map((dl) => (
                  <div key={dl.id} className="py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-white">{dl.itemName}</div>
                      <div className="text-xs text-slate-400">
                        Keywords: {dl.keywords.join(', ')} · Today{' '}
                        <span className="font-mono tabular-nums">
                          {formatMoney(dl.todaySpent || 0, isPrivacyMode)} / {formatMoney(dl.dailyLimit, isPrivacyMode)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-xs font-medium ${
                          dl.status === 'exceeded'
                            ? 'text-rose-400'
                            : dl.status === 'warning'
                            ? 'text-amber-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {dl.status === 'exceeded' ? 'Exceeded' : dl.status === 'warning' ? 'Near Limit' : 'On Track'}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await safeFetchJson(`/api/daily-limits/${dl.id}`, { method: 'DELETE' });
                          await loadExtras();
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

      {subTab === 'categories' && (
        <section className="surface-panel rounded-xl p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-white">Manage Categories &amp; Personal Spend Rules</h2>
              <p className="text-xs text-slate-400">
                Mark any expense category as Excluded from Personal Spend, or edit/remove existing categories.
              </p>
            </div>
            <div className="inline-flex rounded-lg bg-[#0B0F17] p-0.5 border border-white/[0.08]">
              {[
                { id: 'all', label: `All (${categories.length})` },
                {
                  id: 'included',
                  label: `In Personal Spend (${categories.filter((c) => c.type !== 'income' && !c.excludeFromBudget).length})`,
                },
                {
                  id: 'excluded',
                  label: `Excluded (${excludedExpenseCategories.length})`,
                },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setCatSpendFilter(f.id as 'all' | 'included' | 'excluded')}
                  className={`px-2.5 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
                    catSpendFilter === f.id
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Excluded Summary Strip */}
          <div className="bg-[#0B0F17] border border-white/[0.08] rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-amber-300 font-semibold whitespace-nowrap">
              Excluded from Personal Spend ({excludedExpenseCategories.length}):
            </span>
            <span className="text-slate-300">
              {excludedExpenseCategories.length > 0
                ? excludedExpenseCategories.map((c) => c.name).join(', ')
                : 'None — all expense categories are currently counted in Personal Spend.'}
            </span>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!catName.trim()) return;
              await onAddCategory({
                name: catName.trim(),
                type: catType,
                keywords: catKeywords.split(',').map((s) => s.trim()).filter(Boolean),
                color: catColor,
                excludeFromBudget: catType === 'income' ? false : catExcludeSpend,
              });
              setCatName('');
              setCatKeywords('');
              setCatExcludeSpend(false);
            }}
            className="space-y-2.5"
          >
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              <input
                type="text"
                placeholder="Category Name"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                className="sm:col-span-2 px-3 py-2 text-xs rounded-lg field-input"
              />
              <select
                value={catType}
                onChange={(e) => {
                  const val = e.target.value as 'expense' | 'income';
                  setCatType(val);
                  if (val === 'income') setCatExcludeSpend(false);
                }}
                className="px-3 py-2 text-xs rounded-lg field-input"
              >
                <option value="expense" className="bg-[#111827]">Expense</option>
                <option value="income" className="bg-[#111827]">Income</option>
              </select>
              <input
                type="text"
                placeholder="Keywords (comma separated)"
                value={catKeywords}
                onChange={(e) => setCatKeywords(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg field-input"
              />
              <div className="flex gap-2">
                <input
                  type="color"
                  value={catColor}
                  onChange={(e) => setCatColor(e.target.value)}
                  className="w-10 h-9 rounded bg-transparent border border-white/10 cursor-pointer"
                />
                <button
                  type="submit"
                  className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add</span>
                </button>
              </div>
            </div>
            {catType !== 'income' && (
              <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={catExcludeSpend}
                  onChange={(e) => setCatExcludeSpend(e.target.checked)}
                  className="rounded border-slate-600 bg-[#0B0F17] text-amber-400 focus:ring-amber-400"
                />
                <span>Exclude this category from Personal Spend &amp; Monthly Budget totals</span>
              </label>
            )}
          </form>

          <div className="divide-y divide-white/[0.06]">
            {filteredCategories.map((cat) => {
              const txStat = categoryStatsFromTxs.get(cat.name.trim().toLowerCase());
              const isEditing = editingCatId === cat.id;
              const isCoreSystem = isCoreSystemCategory(cat);
              const isExcluded = Boolean(cat.excludeFromBudget);

              if (isEditing) {
                return (
                  <form
                    key={cat.id}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!editCatName.trim()) return;
                      setSavingCatEdit(true);
                      try {
                        await safeFetchJson(`/api/categories/${encodeURIComponent(cat.id)}`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            name: editCatName.trim(),
                            keywords: editCatKeywords
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                            color: editCatColor,
                            ...(cat.type !== 'income' ? { excludeFromBudget: editCatExcludeSpend } : {}),
                          }),
                        });
                        setEditingCatId(null);
                        await onRefreshAll();
                        await loadExtras();
                      } finally {
                        setSavingCatEdit(false);
                      }
                    }}
                    className="py-3 space-y-2.5"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 items-center">
                      <input
                        type="text"
                        required
                        value={editCatName}
                        onChange={(e) => setEditCatName(e.target.value)}
                        placeholder="New Category Name"
                        className="sm:col-span-2 px-3 py-1.5 text-xs rounded-lg field-input"
                        autoFocus
                      />
                      <input
                        type="text"
                        value={editCatKeywords}
                        onChange={(e) => setEditCatKeywords(e.target.value)}
                        placeholder="Keywords (comma separated)"
                        className="sm:col-span-2 px-3 py-1.5 text-xs rounded-lg field-input"
                      />
                      <div className="flex items-center gap-2 sm:col-span-2 justify-end">
                        <input
                          type="color"
                          value={editCatColor}
                          onChange={(e) => setEditCatColor(e.target.value)}
                          className="w-8 h-8 rounded bg-transparent border border-white/10 cursor-pointer shrink-0"
                        />
                        <button
                          type="submit"
                          disabled={savingCatEdit}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg whitespace-nowrap"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{savingCatEdit ? 'Saving...' : 'Save'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingCatId(null)}
                          className="p-1.5 text-slate-400 hover:text-white rounded-lg"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {cat.type !== 'income' && (
                      <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={editCatExcludeSpend}
                          onChange={(e) => setEditCatExcludeSpend(e.target.checked)}
                          className="rounded border-slate-600 bg-[#0B0F17] text-amber-400 focus:ring-amber-400"
                        />
                        <span>Exclude from Personal Spend &amp; Monthly Budget totals</span>
                      </label>
                    )}
                  </form>
                );
              }

              return (
                <div key={cat.id} className="py-3 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span
                      className="w-3 h-3 rounded-sm shrink-0"
                      style={{ backgroundColor: cat.color || '#64748B' }}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white truncate">
                        {cat.name}{' '}
                        <span className="text-xs font-normal text-slate-500 capitalize">· {cat.type}</span>
                        {txStat && (
                          <span className="text-xs font-mono tabular-nums text-sky-400 ml-2">
                            · {txStat.count} txns ({formatMoney(txStat.amount, isPrivacyMode)})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        {(cat.keywords || []).slice(0, 8).join(', ') || 'No keywords'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cat.type === 'income' ? (
                      <span className="px-2 py-1 text-[11px] font-medium text-slate-500 bg-[#0B0F17] border border-white/[0.06] rounded-md whitespace-nowrap">
                        Income Category
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={togglingCatId === cat.id}
                        onClick={() => handleToggleExclude(cat)}
                        title={
                          isExcluded
                            ? 'Click to include this category in Personal Spend'
                            : 'Click to exclude this category from Personal Spend'
                        }
                        className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap disabled:opacity-50 ${
                          isExcluded
                            ? 'text-amber-300 bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20'
                            : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25 hover:bg-emerald-500/20'
                        }`}
                      >
                        {togglingCatId === cat.id
                          ? 'Updating...'
                          : isExcluded
                          ? 'Excluded from Spend'
                          : 'Included in Spend'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setEditingCatId(cat.id);
                        setEditCatName(cat.name);
                        setEditCatKeywords((cat.keywords || []).join(', '));
                        setEditCatColor(cat.color || '#38BDF8');
                        setEditCatExcludeSpend(Boolean(cat.excludeFromBudget));
                      }}
                      title="Edit or replace category"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-300 hover:text-white bg-[#0B0F17] border border-white/[0.08] hover:border-white/20 rounded-md whitespace-nowrap"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Edit</span>
                    </button>
                    {!isCoreSystem && !cat.excludeFromBudget && cat.id !== 'uncategorized' && (
                      <button
                        type="button"
                        onClick={() => onDeleteCategory(cat.id)}
                        title="Remove category"
                        className="p-1.5 text-slate-400 hover:text-rose-400 rounded-md"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
