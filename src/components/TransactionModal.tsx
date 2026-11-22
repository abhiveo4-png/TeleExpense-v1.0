import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { CategoryDef, PaymentMethod, Transaction, TransactionType } from '../types';
import { ALL_ACCOUNTS } from '../utils/accounts';
import { getCurrentIstDate, getCurrentIstTime } from '../utils/formatters';

interface TransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<Transaction>, editId?: string) => Promise<void>;
  categories: CategoryDef[];
  editingTx?: Transaction | null;
}

const PAYMENT_METHODS: PaymentMethod[] = [
  'UPI',
  'Wife',
  'Card',
  'Cash',
  'Bank Transfer',
  'Net Banking',
  'Other',
];

export const TransactionModal: React.FC<TransactionModalProps> = ({
  isOpen,
  onClose,
  onSave,
  categories,
  editingTx,
}) => {
  const [type, setType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Food & Dining');
  const [account, setAccount] = useState('AX Bank');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('UPI');
  const [date, setDate] = useState(getCurrentIstDate());
  const [time, setTime] = useState(getCurrentIstTime());
  const [isReimbursement, setIsReimbursement] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    if (editingTx) {
      setType(editingTx.type);
      setAmount(String(editingTx.amount));
      setDescription(editingTx.description || '');
      setCategory(editingTx.category || 'Other Expense');
      setAccount(editingTx.account || 'AX Bank');
      setPaymentMethod(editingTx.paymentMethod || 'UPI');
      setDate(editingTx.date || getCurrentIstDate());
      setTime(editingTx.time || getCurrentIstTime());
      setIsReimbursement(Boolean(editingTx.isReimbursement));
    } else {
      setType('expense');
      setAmount('');
      setDescription('');
      setCategory('Food & Dining');
      setAccount('AX Bank');
      setPaymentMethod('UPI');
      setDate(getCurrentIstDate());
      setTime(getCurrentIstTime());
      setIsReimbursement(false);
    }
  }, [isOpen, editingTx]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filteredCats = categories.filter(
    (c) => c.type === type || c.type === 'both'
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError('Enter a valid amount greater than ₹0.');
      return;
    }
    if (!description.trim()) {
      setError('Please add a brief description.');
      return;
    }
    setIsSaving(true);
    setError('');
    try {
      await onSave(
        {
          type,
          amount: num,
          description: description.trim(),
          category: isReimbursement ? 'Reimbursement' : category,
          account,
          paymentMethod,
          date,
          time,
          isReimbursement,
        },
        editingTx?.id
      );
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Unable to save entry.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
      <div className="surface-panel rounded-xl w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-white">
            {editingTx ? 'Edit Transaction' : 'Log Transaction'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 text-slate-400 hover:text-white rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-1 p-1 bg-[#0B0F17] border border-white/[0.08] rounded-lg">
            <button
              type="button"
              onClick={() => {
                setType('expense');
                if (category === 'Salary & Employment' || category === 'Other Income') {
                  setCategory('Food & Dining');
                }
              }}
              className={`py-2 text-sm font-medium rounded-md transition-colors ${
                type === 'expense' ? 'bg-rose-500/20 text-rose-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              Expense
            </button>
            <button
              type="button"
              onClick={() => {
                setType('income');
                setIsReimbursement(false);
                if (!filteredCats.some((c) => c.name === category && c.type === 'income')) {
                  setCategory('Salary & Employment');
                }
              }}
              className={`py-2 text-sm font-medium rounded-md transition-colors ${
                type === 'income' ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              Income
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                min="1"
                required
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums rounded-lg field-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Category</label>
              <select
                value={isReimbursement ? 'Reimbursement' : category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setIsReimbursement(e.target.value === 'Reimbursement');
                }}
                className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
              >
                {filteredCats.map((c) => (
                  <option key={c.id} value={c.name} className="bg-[#111827]">
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Description</label>
            <input
              type="text"
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Lunch at office canteen, Monthly rent"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Account / Card</label>
              <select
                value={account}
                onChange={(e) => {
                  const nextAcc = e.target.value;
                  setAccount(nextAcc);
                  if (nextAcc === 'Wife') setPaymentMethod('Wife');
                  else if (nextAcc === 'Cash') setPaymentMethod('Cash');
                }}
                className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
              >
                {ALL_ACCOUNTS.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[#111827]">
                    {a.shortName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Payment Method</label>
              <select
                value={paymentMethod}
                onChange={(e) => {
                  const nextPm = e.target.value as PaymentMethod;
                  setPaymentMethod(nextPm);
                  if (nextPm === 'Wife') setAccount('Wife');
                  else if (nextPm === 'Cash') setAccount('Cash');
                }}
                className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m} className="bg-[#111827]">
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg field-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg field-input"
              />
            </div>
          </div>

          {type === 'expense' && (
            <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={isReimbursement}
                onChange={(e) => setIsReimbursement(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-sky-400 focus:ring-sky-400"
              />
              <span>Mark as claimable reimbursement (excluded from personal budget)</span>
            </label>
          )}

          {error && <p className="text-xs text-rose-400">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : editingTx ? 'Save Changes' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
