import React, { useMemo, useState } from 'react';
import { ArrowRight, ChevronRight, X } from 'lucide-react';
import {
  AccountBalanceInfo,
  AccountBalancesData,
  InvestmentRecord,
  Transaction,
  UdhaarRecord,
} from '../types';
import { formatDate, formatMoney } from '../utils/formatters';

interface CurrentWorthCardProps {
  balances: AccountBalancesData | null;
  investments: InvestmentRecord[];
  udhaars: UdhaarRecord[];
  transactions: Transaction[];
  isPrivacyMode: boolean;
}

export const CurrentWorthCard: React.FC<CurrentWorthCardProps> = ({
  balances,
  investments,
  udhaars,
  transactions,
  isPrivacyMode,
}) => {
  const [isBreakupOpen, setIsBreakupOpen] = useState(false);

  const worth = useMemo(() => {
    const accountList: AccountBalanceInfo[] = balances
      ? (Object.values(balances.accounts) as AccountBalanceInfo[])
      : [];

    const bankAccounts = accountList.filter((a) => a.type === 'bank_account' && a.accountId !== 'Wife');
    const cashAccounts = accountList.filter((a) => a.type === 'cash');
    const wifeAccount = accountList.find((a) => a.accountId === 'Wife');

    const bankTotal = bankAccounts.reduce((s, a) => s + Number(a.currentBalance || 0), 0);
    const cashTotal = cashAccounts.reduce((s, a) => s + Number(a.currentBalance || 0), 0);
    const wifeTotal = wifeAccount
      ? Number(wifeAccount.currentBalance || 0)
      : Number(balances?.wifeSavings?.currentBalance || 0);
    const wifeBase = wifeAccount
      ? Number(wifeAccount.baseBalance || 0)
      : Number(balances?.wifeSavings?.baseBalance || 0);
    const wifeCredits = wifeAccount
      ? Number(wifeAccount.credits || 0)
      : Number(balances?.wifeSavings?.totalTransferred || 0);
    const wifeDebits = wifeAccount ? Number(wifeAccount.debits || 0) : 0;

    // Investments: strictly from Wealth & Khata portfolio holdings
    const investmentsTotal = investments.reduce(
      (s, inv) =>
        s + Number(inv.currentValue && inv.currentValue > 0 ? inv.currentValue : inv.amount || 0),
      0
    );

    // Udhaar Khata: pending receivable (lent) minus pending payable (borrowed)
    const activeLent = udhaars
      .filter((u) => u.type === 'lent' && u.status !== 'settled')
      .map((u) => ({
        ...u,
        remaining: Math.max(0, Number(u.amount || 0) - Number(u.settledAmount || 0)),
      }))
      .filter((u) => u.remaining > 0);

    const activeBorrowed = udhaars
      .filter((u) => u.type === 'borrowed' && u.status !== 'settled')
      .map((u) => ({
        ...u,
        remaining: Math.max(0, Number(u.amount || 0) - Number(u.settledAmount || 0)),
      }))
      .filter((u) => u.remaining > 0);

    const udhaarReceivable = activeLent.reduce((s, u) => s + u.remaining, 0);
    const udhaarPayable = activeBorrowed.reduce((s, u) => s + u.remaining, 0);
    const netUdhaar = udhaarReceivable - udhaarPayable;

    // Pending Reimbursements (receivable claims)
    const activeReimbursements = transactions
      .filter(
        (t) =>
          t.type === 'expense' &&
          (t.isReimbursement || t.category === 'Reimbursement') &&
          t.reimbursementStatus !== 'settled'
      )
      .map((t) => ({
        ...t,
        remaining: Math.max(0, Number(t.amount || 0) - Number(t.reimbursementSettledAmount || 0)),
      }))
      .filter((t) => t.remaining > 0);
    const reimbursementTotal = activeReimbursements.reduce((s, t) => s + t.remaining, 0);

    const totalCurrentWorth =
      bankTotal + wifeTotal + cashTotal + investmentsTotal + netUdhaar + reimbursementTotal;
    const cardOutstanding = Number(balances?.totalCardOutstanding || 0);

    return {
      bankAccounts,
      cashAccounts,
      bankTotal,
      cashTotal,
      wifeTotal,
      wifeBase,
      wifeCredits,
      wifeDebits,
      investmentsTotal,
      activeLent,
      activeBorrowed,
      udhaarReceivable,
      udhaarPayable,
      netUdhaar,
      activeReimbursements,
      reimbursementTotal,
      totalCurrentWorth,
      cardOutstanding,
      netWorthAfterCards: totalCurrentWorth - cardOutstanding,
    };
  }, [balances, investments, udhaars, transactions]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsBreakupOpen(true)}
        className="w-full text-left surface-panel rounded-xl px-5 py-4 hover:border-sky-400/40 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-300">Current Worth</span>
              <span className="text-xs text-slate-500">·</span>
              <span className="text-xs text-slate-400">
                Bank (You &amp; Wife) · Cash · Investments · Net Udhaar · Reimbursement
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-400">
              <span>Your Banks: <strong className="text-slate-200 font-medium">{formatMoney(worth.bankTotal, isPrivacyMode)}</strong></span>
              <span>Wife Bank: <strong className="text-slate-200 font-medium">{formatMoney(worth.wifeTotal, isPrivacyMode)}</strong></span>
              <span>Cash: <strong className="text-slate-200 font-medium">{formatMoney(worth.cashTotal, isPrivacyMode)}</strong></span>
              <span>Investments: <strong className="text-slate-200 font-medium">{formatMoney(worth.investmentsTotal, isPrivacyMode)}</strong></span>
              <span>
                Udhaar:{' '}
                <strong className={`font-medium ${worth.netUdhaar >= 0 ? 'text-amber-300' : 'text-rose-400'}`}>
                  {formatMoney(worth.netUdhaar, isPrivacyMode)}
                </strong>
              </span>
              <span>
                Reimbursement:{' '}
                <strong className="text-cyan-300 font-medium">
                  {formatMoney(worth.reimbursementTotal, isPrivacyMode)}
                </strong>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between lg:justify-end gap-4 shrink-0">
            <div className="lg:text-right">
              <div
                className={`text-2xl sm:text-3xl font-bold font-mono tabular-nums ${
                  worth.totalCurrentWorth >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {formatMoney(worth.totalCurrentWorth, isPrivacyMode)}
              </div>
              <div className="text-[11px] text-slate-400 group-hover:text-sky-400 transition-colors inline-flex items-center gap-1">
                <span>Click for full breakup</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        </div>
      </button>

      {isBreakupOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
          onClick={() => setIsBreakupOpen(false)}
        >
          <div
            className="surface-panel rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
              <div>
                <h2 className="font-display text-base font-semibold text-white">Current Worth Breakup</h2>
                <p className="text-xs text-slate-400">
                  Your Banks + Wife Bank + Cash + Investments + Net Udhaar + Reimbursements
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsBreakupOpen(false)}
                aria-label="Close current worth breakup"
                className="p-1.5 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Headline Total Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-5 border-b border-white/[0.08]">
                <div>
                  <div className="text-xs text-slate-400">Total Current Worth</div>
                  <div
                    className={`text-3xl font-bold font-mono tabular-nums mt-1 ${
                      worth.totalCurrentWorth >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatMoney(worth.totalCurrentWorth, isPrivacyMode)}
                  </div>
                </div>
                <div className="sm:text-right">
                  <div className="text-xs text-slate-400">Net After Credit Card Dues</div>
                  <div className="text-xl font-bold font-mono tabular-nums text-slate-200 mt-1">
                    {formatMoney(worth.netWorthAfterCards, isPrivacyMode)}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                    Card Dues: -{formatMoney(worth.cardOutstanding, isPrivacyMode)}
                  </div>
                </div>
              </div>

              {/* 1. Your Bank Accounts */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>1. Your Bank Accounts ({worth.bankAccounts.length})</span>
                  <span className="font-mono tabular-nums text-sky-400">
                    {formatMoney(worth.bankTotal, isPrivacyMode)}
                  </span>
                </div>
                {worth.bankAccounts.length === 0 ? (
                  <p className="text-xs text-slate-500">No bank accounts found.</p>
                ) : (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                    {worth.bankAccounts.map((acc) => (
                      <div key={acc.accountId} className="py-2 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="text-slate-200 font-medium">{acc.shortName}</span>
                          <span className="text-slate-500 ml-2">{acc.name}</span>
                        </div>
                        <span
                          className={`font-mono tabular-nums font-semibold shrink-0 ${
                            acc.currentBalance >= 0 ? 'text-white' : 'text-rose-400'
                          }`}
                        >
                          {formatMoney(acc.currentBalance, isPrivacyMode)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 2. Wife Bank / Family Savings */}
              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>2. Wife Bank / Family Savings</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {formatMoney(worth.wifeTotal, isPrivacyMode)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>
                    Opening Base: <span className="font-mono tabular-nums text-slate-200">{formatMoney(worth.wifeBase, isPrivacyMode)}</span>
                    <span className="mx-2">·</span>
                    In / Transfers: <span className="font-mono tabular-nums text-emerald-300">+{formatMoney(worth.wifeCredits, isPrivacyMode)}</span>
                    {worth.wifeDebits > 0 && (
                      <>
                        <span className="mx-2">·</span>
                        Spent / Out: <span className="font-mono tabular-nums text-rose-300">-{formatMoney(worth.wifeDebits, isPrivacyMode)}</span>
                      </>
                    )}
                  </span>
                  <span className="text-[11px] text-slate-500">Manage in Accounts → Wife / Family Savings</span>
                </div>
              </div>

              {/* 3. Cash in Hand */}
              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>3. Cash in Hand ({worth.cashAccounts.length})</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {formatMoney(worth.cashTotal, isPrivacyMode)}
                  </span>
                </div>
                <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                  {worth.cashAccounts.map((acc) => (
                    <div key={acc.accountId} className="py-2 flex items-center justify-between gap-3 text-xs">
                      <div className="min-w-0">
                        <span className="text-slate-200 font-medium">{acc.shortName}</span>
                        <span className="text-slate-500 ml-2">{acc.name}</span>
                      </div>
                      <span className="font-mono tabular-nums font-semibold text-white shrink-0">
                        {formatMoney(acc.currentBalance, isPrivacyMode)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 4. Investments */}
              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>4. Investments · Wealth &amp; Khata ({investments.length})</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {formatMoney(worth.investmentsTotal, isPrivacyMode)}
                  </span>
                </div>
                {investments.length > 0 ? (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-44 overflow-y-auto">
                    {investments.map((inv) => {
                      const val = Number(inv.currentValue && inv.currentValue > 0 ? inv.currentValue : inv.amount || 0);
                      return (
                        <div key={inv.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                          <div className="min-w-0">
                            <span className="text-slate-200 font-medium">{inv.name}</span>
                            <span className="text-slate-500 ml-2">
                              {inv.type} · {inv.account}
                            </span>
                          </div>
                          <span className="font-mono tabular-nums font-semibold text-emerald-300 shrink-0">
                            {formatMoney(val, isPrivacyMode)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    No investments added in Wealth &amp; Khata yet.
                  </p>
                )}
              </div>

              {/* 5. Udhaar Khata */}
              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>5. Udhaar Khata (Net Pending)</span>
                  <span
                    className={`font-mono tabular-nums ${
                      worth.netUdhaar >= 0 ? 'text-amber-300' : 'text-rose-400'
                    }`}
                  >
                    {formatMoney(worth.netUdhaar, isPrivacyMode)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
                  <span>
                    Receivable (Lent):{' '}
                    <span className="font-mono tabular-nums text-amber-300 font-medium">
                      +{formatMoney(worth.udhaarReceivable, isPrivacyMode)}
                    </span>
                  </span>
                  <span>
                    Payable (Borrowed):{' '}
                    <span className="font-mono tabular-nums text-rose-400 font-medium">
                      -{formatMoney(worth.udhaarPayable, isPrivacyMode)}
                    </span>
                  </span>
                </div>

                {worth.activeLent.length === 0 && worth.activeBorrowed.length === 0 ? (
                  <p className="text-xs text-slate-500">No pending Udhaar balances.</p>
                ) : (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-48 overflow-y-auto">
                    {worth.activeLent.map((u) => (
                      <div key={u.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="text-slate-200 font-medium">{u.personName}</span>
                          <span className="text-slate-500 ml-2">
                            Lent · {formatDate(u.date)}
                            {u.description ? ` · ${u.description}` : ''}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums font-semibold text-amber-300 shrink-0">
                          +{formatMoney(u.remaining, isPrivacyMode)}
                        </span>
                      </div>
                    ))}
                    {worth.activeBorrowed.map((u) => (
                      <div key={u.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="text-slate-200 font-medium">{u.personName}</span>
                          <span className="text-slate-500 ml-2">
                            Borrowed · {formatDate(u.date)}
                            {u.description ? ` · ${u.description}` : ''}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums font-semibold text-rose-400 shrink-0">
                          -{formatMoney(u.remaining, isPrivacyMode)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 6. Pending Reimbursements */}
              <div className="space-y-2.5 pt-2 border-t border-white/[0.08]">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>6. Pending Reimbursements ({worth.activeReimbursements.length})</span>
                  <span className="font-mono tabular-nums text-cyan-300">
                    +{formatMoney(worth.reimbursementTotal, isPrivacyMode)}
                  </span>
                </div>
                {worth.activeReimbursements.length === 0 ? (
                  <p className="text-xs text-slate-500">No pending reimbursement claims.</p>
                ) : (
                  <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] max-h-48 overflow-y-auto">
                    {worth.activeReimbursements.map((tx) => (
                      <div key={tx.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="text-slate-200 font-medium">{tx.description}</span>
                          <span className="text-slate-500 ml-2">
                            {formatDate(tx.date)} · {tx.account || 'AX Bank'}
                            {tx.reimbursementSettledAmount ? ' · Partial settled' : ''}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums font-semibold text-cyan-300 shrink-0">
                          +{formatMoney(tx.remaining, isPrivacyMode)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer Formula Summary */}
            <div className="px-6 py-3.5 border-t border-white/[0.08] bg-[#0B0F17] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
              <div className="flex flex-wrap items-center gap-1.5 text-slate-400 font-mono tabular-nums text-[11px]">
                <span>{formatMoney(worth.bankTotal, isPrivacyMode)}</span>
                <span>+</span>
                <span>{formatMoney(worth.wifeTotal, isPrivacyMode)}</span>
                <span>+</span>
                <span>{formatMoney(worth.cashTotal, isPrivacyMode)}</span>
                <span>+</span>
                <span>{formatMoney(worth.investmentsTotal, isPrivacyMode)}</span>
                <span>+</span>
                <span>{formatMoney(worth.netUdhaar, isPrivacyMode)}</span>
                <span>+</span>
                <span>{formatMoney(worth.reimbursementTotal, isPrivacyMode)}</span>
                <ArrowRight className="w-3 h-3 text-slate-500 mx-0.5" />
                <span className="text-emerald-400 font-semibold">
                  {formatMoney(worth.totalCurrentWorth, isPrivacyMode)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsBreakupOpen(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
