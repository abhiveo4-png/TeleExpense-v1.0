import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ALL_ACCOUNTS } from '../utils/accounts';
import { formatMoney, getCurrentIstDate } from '../utils/formatters';

export interface SettlementPayload {
  account: string;
  amount: number;
  date: string;
  note?: string;
}

interface SettlementModalProps {
  isOpen: boolean;
  kind: 'reimbursement' | 'udhaar';
  title: string;
  subtitle?: string;
  totalAmount: number;
  alreadySettled?: number;
  defaultAccount?: string;
  udhaarDirection?: 'lent' | 'borrowed';
  isPrivacyMode: boolean;
  onClose: () => void;
  onConfirm: (payload: SettlementPayload) => Promise<void>;
}

export const SettlementModal: React.FC<SettlementModalProps> = ({
  isOpen,
  kind,
  title,
  subtitle,
  totalAmount,
  alreadySettled = 0,
  defaultAccount = 'AX Bank',
  udhaarDirection = 'lent',
  isPrivacyMode,
  onClose,
  onConfirm,
}) => {
  const pending = Math.max(0, Math.round((totalAmount - alreadySettled) * 100) / 100);

  const [amountInput, setAmountInput] = useState('');
  const [account, setAccount] = useState(defaultAccount || 'AX Bank');
  const [date, setDate] = useState(getCurrentIstDate());
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setAmountInput(pending > 0 ? String(pending) : '');
    setAccount(defaultAccount || 'AX Bank');
    setDate(getCurrentIstDate());
    setNote('');
    setErrorMsg('');
    setIsSubmitting(false);
  }, [isOpen, pending, defaultAccount]);

  if (!isOpen) return null;

  const parsedAmount = Number(amountInput);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
  const remainingAfter = Math.max(0, Math.round((pending - validAmount) * 100) / 100);
  const isPartial = validAmount > 0 && validAmount < pending - 0.01;

  const bankCashAccounts = ALL_ACCOUNTS.filter(
    (a) => a.type === 'bank_account' || a.type === 'cash'
  );
  const cardAccounts = ALL_ACCOUNTS.filter(
    (a) => a.type === 'credit_card' || a.type === 'rupay_card'
  );

  const heading =
    kind === 'reimbursement'
      ? 'Settle Reimbursement Claim'
      : udhaarDirection === 'borrowed'
      ? 'Repay Borrowed Udhaar'
      : 'Settle Udhaar Recovery';

  const accountLabel =
    kind === 'reimbursement'
      ? 'Settled In Account'
      : udhaarDirection === 'borrowed'
      ? 'Pay From Account'
      : 'Received In Account';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setErrorMsg('Enter an amount greater than ₹0.');
      return;
    }
    if (parsedAmount > pending + 0.01) {
      setErrorMsg(`Amount cannot exceed pending balance (${formatMoney(pending, isPrivacyMode)}).`);
      return;
    }
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      await onConfirm({
        account,
        amount: Math.min(pending, Math.round(parsedAmount * 100) / 100),
        date,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to save settlement.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyPercent = (pct: number) => {
    const val = Math.max(1, Math.round(pending * pct * 100) / 100);
    setAmountInput(String(Math.min(pending, val)));
    setErrorMsg('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md surface-panel rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div className="min-w-0 pr-3">
            <h3 className="font-display text-base font-semibold text-white">{heading}</h3>
            <p className="text-xs text-slate-400 truncate mt-0.5">{title}</p>
            {subtitle && <p className="text-[11px] text-slate-500 truncate mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settlement modal"
            className="p-1.5 text-slate-400 hover:text-white rounded-md shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="bg-[#0B0F17] border border-white/[0.08] rounded-lg p-3.5 grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-slate-400">Pending Balance</div>
              <div className="text-lg font-bold font-mono tabular-nums text-amber-400 mt-0.5">
                {formatMoney(pending, isPrivacyMode)}
              </div>
              {alreadySettled > 0 && (
                <div className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                  Settled: {formatMoney(alreadySettled, isPrivacyMode)} / {formatMoney(totalAmount, isPrivacyMode)}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-slate-400">After Settlement</div>
              <div className="text-lg font-bold font-mono tabular-nums text-emerald-400 mt-0.5">
                {formatMoney(remainingAfter, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {validAmount <= 0
                  ? 'Enter amount'
                  : isPartial
                  ? 'Partial Settlement'
                  : 'Full Settlement'}
              </div>
            </div>
          </div>

          {pending > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAmountInput(String(pending));
                  setErrorMsg('');
                }}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap ${
                  !isPartial && validAmount > 0 && Math.abs(validAmount - pending) < 0.05
                    ? 'bg-emerald-400 text-slate-950 border-emerald-400 font-semibold'
                    : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20'
                }`}
              >
                Full ({formatMoney(pending, isPrivacyMode)})
              </button>
              <button
                type="button"
                onClick={() => applyPercent(0.5)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap ${
                  isPartial && Math.abs(validAmount - pending * 0.5) < 1
                    ? 'bg-sky-400 text-slate-950 border-sky-400 font-semibold'
                    : 'bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20'
                }`}
              >
                50% Partial ({formatMoney(pending * 0.5, isPrivacyMode)})
              </button>
              <button
                type="button"
                onClick={() => applyPercent(0.25)}
                className="px-2.5 py-1 text-[11px] font-medium rounded-md border bg-[#0B0F17] text-slate-300 border-white/[0.08] hover:border-white/20 whitespace-nowrap"
              >
                25% Partial ({formatMoney(pending * 0.25, isPrivacyMode)})
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Settlement Amount (₹){' '}
                {isPartial ? '· Partial' : validAmount > 0 ? '· Full' : ''}
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                max={pending}
                required
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  setErrorMsg('');
                }}
                placeholder="Enter ₹ amount"
                className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg field-input"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Settlement Date
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg field-input"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              {accountLabel}
            </label>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg field-input"
            >
              <optgroup label="Bank Accounts, Wife & Cash" className="bg-[#111827]">
                {bankCashAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id} className="bg-[#111827]">
                    {acc.shortName} · {acc.badge}
                  </option>
                ))}
              </optgroup>
              {cardAccounts.length > 0 && (
                <optgroup label="Credit Cards" className="bg-[#111827]">
                  {cardAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id} className="bg-[#111827]">
                      {acc.shortName} · {acc.badge}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Note (optional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                kind === 'reimbursement'
                  ? 'e.g. Part 1 salary credit, office NEFT'
                  : 'e.g. GPay part payment, cash return'
              }
              className="w-full px-3 py-2 text-sm rounded-lg field-input"
            />
          </div>

          {errorMsg && <p className="text-xs text-rose-400">{errorMsg}</p>}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              {isSubmitting
                ? 'Settling...'
                : isPartial
                ? `Settle Partial (${formatMoney(validAmount, isPrivacyMode)})`
                : 'Settle Full'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
