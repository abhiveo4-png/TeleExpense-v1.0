import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Plus,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { AccountMeta, CategoryDef, PaymentMethod, Transaction } from '../types';
import { ALL_ACCOUNTS, detectAccount, syncCustomAccounts } from '../utils/accounts';
import { safeFetchJson } from '../utils/api';
import { getCurrentIstDate, getCurrentIstTime } from '../utils/formatters';

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: CategoryDef[];
  onImported: (importedMonths: string[]) => Promise<void>;
}

export interface BulkEntryRow {
  id: string;
  date: string;
  time: string;
  month: string;
  type: 'EXPENSE' | 'INCOME';
  amount: string;
  category: string;
  description: string;
  paymentMethod: PaymentMethod;
  account: string;
  source: string;
  rawMessage: string;
  telegramUser: string;
  tags: string;
  reimbursementStatus: string;
  transactionId: string;
}

type InputMode = 'file' | 'paste' | 'grid';

const PAYMENT_OPTIONS: PaymentMethod[] = [
  'UPI',
  'Wife',
  'Bank Transfer',
  'Card',
  'Cash',
  'Net Banking',
  'UPI/Cash',
  'Other',
];

const MONTH_ABBRS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getMonthShortFromDate(raw: string): string {
  const iso = normalizeDateToIso(raw);
  if (!iso) return '';
  const m = Number(iso.slice(5, 7));
  return MONTH_ABBRS[m - 1] || '';
}

function normalizeDateToIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const ymd = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dmy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function parseCsvMatrix(text: string): string[][] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function normalizePaymentValue(raw: string): PaymentMethod {
  const v = raw.trim().toLowerCase();
  if (v === 'wife' || v === 'wife bank' || v === 'wife account') return 'Wife';
  if (v === 'cash') return 'Cash';
  if (v === 'card') return 'Card';
  if (v === 'bank transfer') return 'Bank Transfer';
  if (v === 'net banking') return 'Net Banking';
  if (v === 'upi/cash') return 'UPI/Cash';
  if (v === 'other') return 'Other';
  return 'UPI';
}

function createEmptyGridRow(defaultDateIso: string, defaultTime: string): BulkEntryRow {
  return {
    id: `row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date: defaultDateIso,
    time: defaultTime,
    month: getMonthShortFromDate(defaultDateIso),
    type: 'EXPENSE',
    amount: '',
    category: 'Food & Dining',
    description: '',
    paymentMethod: 'UPI',
    account: 'AX Bank',
    source: 'manual',
    rawMessage: '',
    telegramUser: '',
    tags: '',
    reimbursementStatus: '',
    transactionId: '',
  };
}

function matrixToBulkRows(matrix: string[][]): BulkEntryRow[] {
  if (matrix.length === 0) return [];
  const firstRowLower = matrix[0].map((c) => c.trim().toLowerCase());
  const hasHeader =
    firstRowLower.some((c) => c.includes('amount')) ||
    (firstRowLower.includes('date') && firstRowLower.includes('type'));

  const header = hasHeader
    ? firstRowLower
    : [
        'date',
        'time',
        'month',
        'type',
        'amount (inr)',
        'category',
        'description',
        'payment method',
        'account / card',
        'source',
        'raw message',
        'telegram user',
        'tags',
        'reimbursement status',
        'transaction id',
      ];
  const startIdx = hasHeader ? 1 : 0;

  const findCol = (...candidates: string[]): number => {
    for (const cand of candidates) {
      const idx = header.findIndex((h) => h === cand || h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const dateCol = findCol('date');
  const timeCol = findCol('time');
  const monthCol = findCol('month');
  const typeCol = findCol('type');
  const amountCol = findCol('amount (inr)', 'amount');
  const catCol = findCol('category');
  const descCol = findCol('description', 'desc', 'notes');
  const payCol = findCol('payment method', 'payment');
  const accCol = findCol('account / card', 'account', 'source bank');
  const srcCol = findCol('source');
  const rawCol = findCol('raw message', 'raw');
  const userCol = findCol('telegram user', 'member');
  const tagsCol = findCol('tags');
  const reimbCol = findCol('reimbursement status', 'reimbursement');
  const txIdCol = findCol('transaction id', 'tx id');

  const todayIso = getCurrentIstDate();
  const nowTime = getCurrentIstTime();
  const parsed: BulkEntryRow[] = [];

  for (let i = startIdx; i < matrix.length; i++) {
    const cols = matrix[i];
    const get = (idx: number, fallbackIdx: number) =>
      String((idx !== -1 ? cols[idx] : fallbackIdx >= 0 ? cols[fallbackIdx] : '') ?? '').trim();

    const rawAmount = get(amountCol, 4).replace(/[₹,\s]/g, '');
    if (!rawAmount || Number.isNaN(Number(rawAmount))) continue;

    const rawDate = get(dateCol, 0) || todayIso;
    const normalizedDate = normalizeDateToIso(rawDate) || rawDate;
    const rawType = get(typeCol, 3).toUpperCase();
    const txType: 'EXPENSE' | 'INCOME' = rawType === 'INCOME' ? 'INCOME' : 'EXPENSE';

    parsed.push({
      id: `imp_${i}_${Math.random().toString(36).slice(2, 6)}`,
      date: normalizedDate,
      time: get(timeCol, 1) || nowTime,
      month: get(monthCol, 2) || getMonthShortFromDate(normalizedDate),
      type: txType,
      amount: rawAmount,
      category: get(catCol, 5) || (txType === 'INCOME' ? 'Other Income' : 'Other Expense'),
      description: get(descCol, 6) || get(catCol, 5) || 'Bulk entry',
      paymentMethod: normalizePaymentValue(get(payCol, 7)),
      account: get(accCol, 8),
      source: get(srcCol, 9) || 'manual',
      rawMessage: get(rawCol, 10),
      telegramUser: get(userCol, 11),
      tags: get(tagsCol, 12),
      reimbursementStatus: get(reimbCol, 13),
      transactionId: get(txIdCol, 14),
    });
  }

  return parsed;
}

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  isOpen,
  onClose,
  categories,
  onImported,
}) => {
  const todayIso = useMemo(() => getCurrentIstDate(), []);
  const nowTime = useMemo(() => getCurrentIstTime(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<InputMode>('file');
  const [fileName, setFileName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [importedRows, setImportedRows] = useState<BulkEntryRow[]>([]);
  const [gridRows, setGridRows] = useState<BulkEntryRow[]>(() =>
    Array.from({ length: 5 }, () => createEmptyGridRow(getCurrentIstDate(), getCurrentIstTime()))
  );

  const [defaultAccount, setDefaultAccount] = useState('AX Bank');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [autoCreateCategories, setAutoCreateCategories] = useState(true);
  const [autoCreateAccounts, setAutoCreateAccounts] = useState(true);
  const [syncUdhaar, setSyncUdhaar] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [resultMsg, setResultMsg] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setResultMsg('');
  }, [isOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const activeRows = useMemo(() => {
    if (mode === 'grid') {
      return gridRows.filter((r) => {
        const num = Number(String(r.amount).replace(/[₹,\s]/g, ''));
        return Number.isFinite(num) && num > 0;
      });
    }
    return importedRows;
  }, [mode, gridRows, importedRows]);

  const previewStats = useMemo(() => {
    let incomeTotal = 0;
    let expenseTotal = 0;
    let validCount = 0;
    for (const r of activeRows) {
      const amt = Number(String(r.amount).replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(amt) || amt <= 0) continue;
      validCount++;
      if (r.type === 'INCOME') incomeTotal += amt;
      else expenseTotal += amt;
    }
    return { validCount, incomeTotal, expenseTotal };
  }, [activeRows]);

  if (!isOpen) return null;

  const handleDownloadTemplate = () => {
    const csvContent = [
      'Date,Time,Month,Type,Amount (INR),Category,Description,Payment Method,Account / Card,Source,Raw Message,Telegram User,Tags,Reimbursement Status,Transaction ID',
      '2026-11-22,11:26,Nov,EXPENSE,60,Abhishek Dubey,Signature ic,Bank Transfer,IC Bank,telegram,60 signature ic bank,Abhi,,,',
      '2026-11-21,11:17,Nov,INCOME,1750,Gift,Dinesh Ji Ticket,UPI,IC Bank,manual,,Ansh,,,',
      '2026-11-20,10:27,Nov,EXPENSE,781,Groceries & Kirana,Ration,UPI,SBI CC 5733,manual,,Ansh,,,',
      '2026-11-18,11:57,Nov,EXPENSE,430,Reimbursement,Travel Lunch,UPI,ICICI CC 0000,manual,,Ansh,"office, client",pending,',
    ].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teleexpense_bulk_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setResultMsg('');
    setFileName(file.name);

    try {
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = await file.text();
        const matrix = parseCsvMatrix(text);
        const rows = matrixToBulkRows(matrix);
        if (rows.length === 0) {
          setError(
            'No valid rows detected in CSV. Expected columns: Date,Time,Month,Type,Amount (INR),Category,Description,Payment Method,Account / Card,Source,Raw Message,Telegram User,Tags,Reimbursement Status,Transaction ID'
          );
        }
        setImportedRows(rows);
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array', cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json<string[]>(ws, {
          header: 1,
          raw: false,
          defval: '',
        });
        const rows = matrixToBulkRows(
          matrix.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
        );
        if (rows.length === 0) {
          setError('No valid rows detected in workbook sheet.');
        }
        setImportedRows(rows);
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to parse file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleParsePaste = () => {
    setError('');
    setResultMsg('');
    if (!pasteText.trim()) {
      setError('Paste CSV lines above before parsing.');
      return;
    }
    const matrix = parseCsvMatrix(pasteText);
    const rows = matrixToBulkRows(matrix);
    if (rows.length === 0) {
      setError('No valid numeric amount rows found in pasted CSV.');
      return;
    }
    setImportedRows(rows);
  };

  const updateGridRow = (id: string, field: keyof BulkEntryRow, value: string) => {
    setGridRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const next: BulkEntryRow = { ...r, [field]: value };
        if (field === 'paymentMethod') {
          if (value === 'Wife') next.account = 'Wife';
          else if (value === 'Cash') next.account = 'Cash';
        } else if (field === 'account') {
          if (value === 'Wife') next.paymentMethod = 'Wife';
          else if (value === 'Cash') next.paymentMethod = 'Cash';
        }
        return next;
      })
    );
  };

  const inferAccountLabel = (row: BulkEntryRow): string => {
    if (row.account) return row.account;
    const detected = detectAccount(`${row.rawMessage} ${row.description}`);
    if (detected) return detected;
    if (row.paymentMethod === 'Wife') return 'Wife';
    if (row.paymentMethod === 'Cash') return 'Cash';
    if (row.paymentMethod === 'Card') return 'ICICI CC 0000';
    return defaultAccount;
  };

  const handleCommitImport = async () => {
    if (activeRows.length === 0) {
      setError('Add or upload at least one valid row with a positive amount.');
      return;
    }

    setIsSubmitting(true);
    setError('');
    setResultMsg('');

    const payloadRows = activeRows.map((r) => ({
      date: r.date,
      time: r.time || undefined,
      type: r.type,
      amount: r.amount,
      category: r.category,
      description: r.description || r.category,
      paymentMethod: r.paymentMethod,
      account: r.account || undefined,
      source: r.source || 'manual',
      rawMessage: r.rawMessage,
      telegramUser: r.telegramUser || undefined,
      tags: r.tags || undefined,
      reimbursementStatus: r.reimbursementStatus || undefined,
      transactionId: r.transactionId || undefined,
    }));

    const { data, error: apiErr } = await safeFetchJson<{
      success: boolean;
      importedCount: number;
      skippedCount: number;
      categoriesCreated: number;
      accountsCreated?: number;
      customAccounts?: AccountMeta[];
      transactions: Transaction[];
    }>('/api/transactions/bulk-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: payloadRows,
        defaultAccount,
        skipDuplicates,
        autoCreateCategories,
        autoCreateAccounts,
        syncUdhaar,
      }),
    });

    setIsSubmitting(false);

    if (apiErr || !data) {
      setError(apiErr || 'Bulk import failed.');
      return;
    }

    if (data.customAccounts) {
      syncCustomAccounts(data.customAccounts);
    }

    const monthsSet = new Set<string>();
    for (const r of activeRows) {
      const iso = normalizeDateToIso(r.date);
      if (iso) monthsSet.add(iso.slice(0, 7));
    }

    const parts: string[] = [
      `Imported ${data.importedCount} ${data.importedCount === 1 ? 'entry' : 'entries'}`,
    ];
    if (data.skippedCount > 0) parts.push(`skipped ${data.skippedCount} duplicate/invalid`);
    if (data.categoriesCreated > 0) parts.push(`created ${data.categoriesCreated} categories`);
    if ((data.accountsCreated || 0) > 0) parts.push(`added ${data.accountsCreated} accounts/cards`);

    setResultMsg(`${parts.join(', ')}.`);

    if (mode === 'grid') {
      setGridRows(Array.from({ length: 5 }, () => createEmptyGridRow(todayIso, nowTime)));
    } else {
      setImportedRows([]);
      setPasteText('');
      setFileName('');
    }

    await onImported(Array.from(monthsSet).sort().reverse());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
      <div className="surface-panel rounded-xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Bulk Import Expenses &amp; Income
            </h2>
            <p className="text-xs text-slate-400">
              Format: Date, Time, Month, Type, Amount (INR), Category, Description, Payment Method, Account / Card, Source, Raw Message, Telegram User, Tags, Reimbursement Status, Transaction ID
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0E1420] hover:bg-slate-800 border border-white/[0.1] rounded-lg whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV Template</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close bulk import modal"
              className="p-1.5 text-slate-400 hover:text-white rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Mode Selector + Fallback Account */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="inline-flex p-1 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
              <button
                type="button"
                onClick={() => setMode('file')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'file' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload CSV / Excel</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('paste')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'paste' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Paste CSV Text</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('grid')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'grid' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span>Bulk Grid Entry</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
              <label className="inline-flex items-center gap-2">
                <span className="text-slate-400">Fallback Account</span>
                <select
                  value={defaultAccount}
                  onChange={(e) => setDefaultAccount(e.target.value)}
                  className="px-2.5 py-1.5 text-xs rounded-lg field-input"
                >
                  {ALL_ACCOUNTS.map((a) => (
                    <option key={a.id} value={a.id} className="bg-[#111827]">
                      {a.shortName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* Options Checkboxes */}
          <div className="flex flex-wrap items-center gap-5 px-4 py-3 rounded-lg bg-[#0B0F17] border border-white/[0.06] text-xs text-slate-300">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-sky-400"
              />
              <span>Skip duplicates (by Transaction ID &amp; entry signature)</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoCreateCategories}
                onChange={(e) => setAutoCreateCategories(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-sky-400"
              />
              <span>Auto-create missing categories</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoCreateAccounts}
                onChange={(e) => setAutoCreateAccounts(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-sky-400"
              />
              <span>Auto-register new banks/cards (e.g. Axis 2904)</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={syncUdhaar}
                onChange={(e) => setSyncUdhaar(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-sky-400"
              />
              <span>Also create Udhaar Khata records for &ldquo;Udhaar Given&rdquo;</span>
            </label>
          </div>

          {/* Mode-Specific Input */}
          {mode === 'file' && (
            <div className="p-5 rounded-xl bg-[#0B0F17] border border-dashed border-white/[0.14] flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="space-y-1 text-center sm:text-left">
                <div className="text-sm font-medium text-white">
                  {fileName ? `Loaded: ${fileName}` : 'Select your TeleExpense CSV or Excel file'}
                </div>
                <div className="text-xs text-slate-400">
                  Accepts <code className="text-slate-300">.csv</code>, <code className="text-slate-300">.xlsx</code>, or{' '}
                  <code className="text-slate-300">.xls</code> with explicit{' '}
                  <code className="text-slate-300">Account / Card</code>, <code className="text-slate-300">Time</code>,{' '}
                  <code className="text-slate-300">Telegram User</code>, <code className="text-slate-300">Tags</code> &amp;{' '}
                  <code className="text-slate-300">Transaction ID</code>.
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {importedRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setImportedRows([]);
                      setFileName('');
                    }}
                    className="px-3 py-2 text-xs text-slate-300 hover:text-white bg-slate-800 rounded-lg whitespace-nowrap shrink-0"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Choose CSV / Excel</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
            </div>
          )}

          {mode === 'paste' && (
            <div className="space-y-3">
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={
                  'Date,Time,Month,Type,Amount (INR),Category,Description,Payment Method,Account / Card,Source,Raw Message,Telegram User,Tags,Reimbursement Status,Transaction ID\n' +
                  '2026-11-22,11:26,Nov,EXPENSE,60,Abhishek Dubey,Signature ic,Bank Transfer,IC Bank,telegram,60 signature ic bank,Abhi,,,tx_1795327001074_utb3tf\n' +
                  '2026-11-21,11:17,Nov,INCOME,1750,Gift,Dinesh Ji Ticket,UPI,IC Bank,manual,,Ansh,,,tx_1795326494228_w7any1'
                }
                className="w-full p-3.5 text-xs font-mono rounded-lg field-input"
              />
              <div className="flex items-center justify-end gap-2">
                {importedRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setPasteText('');
                      setImportedRows([]);
                    }}
                    className="px-3 py-1.5 text-xs text-slate-300 hover:text-white rounded-lg"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleParsePaste}
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
                >
                  Parse CSV Rows
                </button>
              </div>
            </div>
          )}

          {mode === 'grid' && (
            <div className="space-y-3">
              <datalist id="bulk-cat-options">
                {categories.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
              <datalist id="bulk-acc-options">
                {ALL_ACCOUNTS.map((a) => (
                  <option key={a.id} value={a.id} />
                ))}
              </datalist>

              <div className="overflow-x-auto border border-white/[0.08] rounded-xl bg-[#0B0F17]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-[#0E1420] text-slate-400">
                      <th className="py-2.5 px-3">Date</th>
                      <th className="py-2.5 px-2">Time</th>
                      <th className="py-2.5 px-2">Type</th>
                      <th className="py-2.5 px-2">Amount (INR)</th>
                      <th className="py-2.5 px-2">Category</th>
                      <th className="py-2.5 px-2">Description</th>
                      <th className="py-2.5 px-2">Account / Card</th>
                      <th className="py-2.5 px-2">Payment</th>
                      <th className="py-2.5 px-2">Member</th>
                      <th className="py-2.5 px-2 text-right">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {gridRows.map((row) => (
                      <tr key={row.id}>
                        <td className="p-2 min-w-[130px]">
                          <input
                            type="date"
                            value={row.date}
                            onChange={(e) => updateGridRow(row.id, 'date', e.target.value)}
                            className="w-full px-2 py-1.5 text-xs font-mono rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[90px]">
                          <input
                            type="time"
                            value={row.time}
                            onChange={(e) => updateGridRow(row.id, 'time', e.target.value)}
                            className="w-full px-2 py-1.5 text-xs font-mono rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[100px]">
                          <select
                            value={row.type}
                            onChange={(e) =>
                              updateGridRow(row.id, 'type', e.target.value as 'EXPENSE' | 'INCOME')
                            }
                            className="w-full px-2 py-1.5 text-xs rounded-md field-input"
                          >
                            <option value="EXPENSE" className="bg-[#111827]">EXPENSE</option>
                            <option value="INCOME" className="bg-[#111827]">INCOME</option>
                          </select>
                        </td>
                        <td className="p-2 min-w-[105px]">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.amount}
                            onChange={(e) => updateGridRow(row.id, 'amount', e.target.value)}
                            placeholder="0.00"
                            className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[150px]">
                          <input
                            type="text"
                            list="bulk-cat-options"
                            value={row.category}
                            onChange={(e) => updateGridRow(row.id, 'category', e.target.value)}
                            placeholder="Category"
                            className="w-full px-2.5 py-1.5 text-xs rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[165px]">
                          <input
                            type="text"
                            value={row.description}
                            onChange={(e) => updateGridRow(row.id, 'description', e.target.value)}
                            placeholder="Description"
                            className="w-full px-2.5 py-1.5 text-xs rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[135px]">
                          <input
                            type="text"
                            list="bulk-acc-options"
                            value={row.account}
                            onChange={(e) => updateGridRow(row.id, 'account', e.target.value)}
                            placeholder={defaultAccount}
                            className="w-full px-2.5 py-1.5 text-xs rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 min-w-[115px]">
                          <select
                            value={row.paymentMethod}
                            onChange={(e) => updateGridRow(row.id, 'paymentMethod', e.target.value)}
                            className="w-full px-2 py-1.5 text-xs rounded-md field-input"
                          >
                            {PAYMENT_OPTIONS.map((pm) => (
                              <option key={pm} value={pm} className="bg-[#111827]">
                                {pm}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2 min-w-[95px]">
                          <input
                            type="text"
                            value={row.telegramUser}
                            onChange={(e) => updateGridRow(row.id, 'telegramUser', e.target.value)}
                            placeholder="Ansh"
                            className="w-full px-2 py-1.5 text-xs rounded-md field-input"
                          />
                        </td>
                        <td className="p-2 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setGridRows((prev) =>
                                prev.length > 1 ? prev.filter((item) => item.id !== row.id) : prev
                              )
                            }
                            aria-label="Remove row"
                            className="p-1.5 text-slate-400 hover:text-rose-400 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setGridRows((prev) => [...prev, createEmptyGridRow(todayIso, nowTime)])}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Row</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setGridRows((prev) => [
                      ...prev,
                      ...Array.from({ length: 5 }, () => createEmptyGridRow(todayIso, nowTime)),
                    ])
                  }
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#0E1420] border border-white/[0.08] rounded-lg"
                >
                  +5 Rows
                </button>
              </div>
            </div>
          )}

          {/* Preview Strip for File & Paste Modes */}
          {mode !== 'grid' && importedRows.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Preview ({importedRows.length} parsed rows)</span>
                <span>Showing up to 150 rows below</span>
              </div>
              <div className="max-h-64 overflow-y-auto border border-white/[0.08] rounded-xl bg-[#0B0F17]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-[#0E1420] border-b border-white/[0.08] text-slate-400">
                    <tr>
                      <th className="py-2 px-3">Date &amp; Time</th>
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Category</th>
                      <th className="py-2 px-3">Description</th>
                      <th className="py-2 px-3">Account / Card</th>
                      <th className="py-2 px-3">Member / Tags</th>
                      <th className="py-2 px-3 text-right">Amount</th>
                      <th className="py-2 px-3 text-right">Drop</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {importedRows.slice(0, 150).map((row) => (
                      <tr key={row.id} className="hover:bg-white/[0.02]">
                        <td className="py-2 px-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                          {row.date} {row.time ? `· ${row.time}` : ''}
                        </td>
                        <td
                          className={`py-2 px-3 font-mono text-[11px] font-semibold ${
                            row.type === 'INCOME' ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {row.type}
                        </td>
                        <td className="py-2 px-3 text-slate-200 whitespace-nowrap">{row.category}</td>
                        <td className="py-2 px-3 text-slate-300 max-w-[200px] truncate">
                          {row.description}
                        </td>
                        <td className="py-2 px-3 text-slate-300 whitespace-nowrap">
                          {inferAccountLabel(row)} · <span className="text-slate-500">{row.paymentMethod}</span>
                        </td>
                        <td className="py-2 px-3 text-slate-400 max-w-[160px] truncate">
                          {[row.telegramUser, row.tags, row.reimbursementStatus]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                            row.type === 'INCOME' ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          ₹{Number(row.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setImportedRows((prev) => prev.filter((item) => item.id !== row.id))
                            }
                            aria-label="Remove preview row"
                            className="p-1 text-slate-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Summary Strip */}
          <div className="grid grid-cols-3 divide-x divide-white/[0.08] rounded-xl bg-[#0B0F17] border border-white/[0.08]">
            <div className="p-3.5">
              <div className="text-[11px] text-slate-400">Ready Rows</div>
              <div className="text-lg font-bold font-mono tabular-nums text-white">
                {previewStats.validCount}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] text-slate-400">Bulk Income</div>
              <div className="text-lg font-bold font-mono tabular-nums text-emerald-400">
                ₹{previewStats.incomeTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-3.5">
              <div className="text-[11px] text-slate-400">Bulk Expense</div>
              <div className="text-lg font-bold font-mono tabular-nums text-rose-400">
                ₹{previewStats.expenseTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          {error && <p className="text-xs text-rose-400">{error}</p>}
          {resultMsg && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{resultMsg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white rounded-lg"
          >
            Close
          </button>
          <button
            type="button"
            disabled={isSubmitting || previewStats.validCount === 0}
            onClick={handleCommitImport}
            className="px-5 py-2 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {isSubmitting
              ? 'Importing...'
              : `Import ${previewStats.validCount} ${previewStats.validCount === 1 ? 'Entry' : 'Entries'}`}
          </button>
        </div>
      </div>
    </div>
  );
};
