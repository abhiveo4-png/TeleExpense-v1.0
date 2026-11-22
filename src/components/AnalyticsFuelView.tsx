import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CategoryDef, FuelLog, Transaction } from '../types';
import { safeFetchJson } from '../utils/api';
import { formatDate, formatMoney, formatMonthLabel, getCurrentIstDate } from '../utils/formatters';

interface AnalyticsFuelViewProps {
  transactions: Transaction[];
  categories?: CategoryDef[];
  fuelLogs: FuelLog[];
  selectedMonth: string;
  isPrivacyMode: boolean;
  onRefreshAll: () => Promise<void>;
}

export const AnalyticsFuelView: React.FC<AnalyticsFuelViewProps> = ({
  transactions,
  categories = [],
  fuelLogs,
  selectedMonth,
  isPrivacyMode,
  onRefreshAll,
}) => {
  const [vehicleName, setVehicleName] = useState('Car');
  const [fuelAmount, setFuelAmount] = useState('');
  const [fuelLiters, setFuelLiters] = useState('');
  const [odometer, setOdometer] = useState('');

  const categoriesByLower = useMemo(() => {
    const map = new Map<string, CategoryDef>();
    for (const c of categories) {
      map.set(c.name.trim().toLowerCase(), c);
    }
    return map;
  }, [categories]);

  const isExcludedExpense = (tx: Transaction) => {
    if (tx.type !== 'expense') return false;
    const cat = categoriesByLower.get((tx.category || '').trim().toLowerCase());
    if (cat) {
      if (cat.excludeFromBudget === true) return true;
      if (cat.excludeFromBudget === false) return false;
    }
    return Boolean(
      tx.isReimbursement ||
        tx.isCcPayment ||
        tx.isUdhaarLent ||
        tx.isWifeTransfer ||
        tx.isSavingsTransfer
    );
  };

  const monthlySeries = useMemo(() => {
    const map: Record<string, { month: string; label: string; income: number; expense: number }> = {};
    for (const tx of transactions) {
      const m = tx.date?.slice(0, 7);
      if (!m) continue;
      if (!map[m]) map[m] = { month: m, label: formatMonthLabel(m), income: 0, expense: 0 };
      if (
        tx.type === 'income' &&
        !tx.isReimbursementInflow &&
        !tx.isUdhaarRecovery &&
        !tx.isCcPayment &&
        tx.category !== 'CC Payment'
      ) {
        map[m].income += Number(tx.amount || 0);
      } else if (tx.type === 'expense' && !isExcludedExpense(tx)) {
        map[m].expense += Number(tx.amount || 0);
      }
    }
    return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  }, [transactions, categoriesByLower]);

  const categoryBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    let total = 0;
    for (const tx of transactions) {
      if (selectedMonth !== 'all' && !tx.date?.startsWith(selectedMonth)) continue;
      if (tx.type === 'expense' && !isExcludedExpense(tx)) {
        map[tx.category] = (map[tx.category] || 0) + Number(tx.amount || 0);
        total += Number(tx.amount || 0);
      }
    }
    return Object.entries(map)
      .map(([category, amount]) => ({
        category,
        amount,
        pct: total > 0 ? Math.round((amount / total) * 100) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [transactions, selectedMonth, categoriesByLower]);

  const avgMileage = useMemo(() => {
    const valid = fuelLogs.filter((f) => f.calculatedMileage && f.calculatedMileage > 0);
    if (valid.length === 0) return 0;
    return Number((valid.reduce((s, f) => s + (f.calculatedMileage || 0), 0) / valid.length).toFixed(1));
  }, [fuelLogs]);

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Monthly Income vs Expense Chart */}
        <section className="surface-panel rounded-xl p-5 xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold text-white">Monthly Cashflow Trend</h2>
              <p className="text-xs text-slate-400">Personal expenses vs net household income (last 6 active months)</p>
            </div>
          </div>

          {monthlySeries.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs text-slate-400">
              Add transactions to visualize monthly cashflow trends.
            </div>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlySeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#94A3B8', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#94A3B8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#111827',
                      borderColor: 'rgba(255,255,255,0.12)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="income" name="Income" fill="#10B981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expense" name="Personal Spend" fill="#F43F5E" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Category Distribution */}
        <section className="surface-panel rounded-xl p-5 space-y-4">
          <h2 className="font-display text-base font-semibold text-white">Category Distribution</h2>
          {categoryBreakdown.length === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">No personal expense data for this period.</p>
          ) : (
            <div className="space-y-3.5 max-h-64 overflow-y-auto pr-1">
              {categoryBreakdown.map((row) => (
                <div key={row.category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-200 truncate">{row.category}</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      {formatMoney(row.amount, isPrivacyMode)} ({row.pct}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-sky-400" style={{ width: `${row.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Fuel & Mileage Tracker */}
      <section className="surface-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-white">Fuel &amp; Vehicle Mileage Log</h2>
            <p className="text-xs text-slate-400">
              Average Mileage: <span className="font-mono tabular-nums text-emerald-400 font-semibold">{avgMileage} km/L</span>
              <span className="mx-2">·</span>
              <span>{fuelLogs.length} fill entries</span>
            </p>
          </div>
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!fuelAmount || !odometer) return;
            await safeFetchJson('/api/fuel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                vehicleName: vehicleName.trim() || 'Car',
                fuelAmount: Number(fuelAmount),
                fuelLiters: fuelLiters ? Number(fuelLiters) : undefined,
                odometer: Number(odometer),
                date: getCurrentIstDate(),
              }),
            });
            setFuelAmount('');
            setFuelLiters('');
            setOdometer('');
            await onRefreshAll();
          }}
          className="grid grid-cols-1 sm:grid-cols-5 gap-2"
        >
          <input
            type="text"
            placeholder="Vehicle (e.g. Car, Activa)"
            value={vehicleName}
            onChange={(e) => setVehicleName(e.target.value)}
            className="px-3 py-2 text-xs rounded-lg field-input"
          />
          <input
            type="number"
            placeholder="Fuel Cost ₹"
            value={fuelAmount}
            onChange={(e) => setFuelAmount(e.target.value)}
            className="px-3 py-2 text-xs font-mono rounded-lg field-input"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Liters (optional)"
            value={fuelLiters}
            onChange={(e) => setFuelLiters(e.target.value)}
            className="px-3 py-2 text-xs font-mono rounded-lg field-input"
          />
          <input
            type="number"
            placeholder="Odometer (km)"
            value={odometer}
            onChange={(e) => setOdometer(e.target.value)}
            className="px-3 py-2 text-xs font-mono rounded-lg field-input"
          />
          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg"
          >
            Log Refill
          </button>
        </form>

        {fuelLogs.length === 0 ? (
          <p className="text-xs text-slate-400 py-4">No fuel fills recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.08] text-slate-400">
                  <th className="py-2.5 pr-4">Date</th>
                  <th className="py-2.5 px-4">Vehicle</th>
                  <th className="py-2.5 px-4 text-right">Odometer</th>
                  <th className="py-2.5 px-4 text-right">Trip</th>
                  <th className="py-2.5 px-4 text-right">Mileage</th>
                  <th className="py-2.5 px-4 text-right">Amount</th>
                  <th className="py-2.5 pl-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {fuelLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2.5 pr-4 font-mono tabular-nums text-slate-400">{formatDate(log.date)}</td>
                    <td className="py-2.5 px-4 text-white font-medium">{log.vehicleName || 'Primary Vehicle'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">{log.odometer} km</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-400">
                      {log.distanceCovered ? `${log.distanceCovered} km` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-400">
                      {log.calculatedMileage ? `${log.calculatedMileage} km/L` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-white">
                      {formatMoney(log.fuelAmount, isPrivacyMode)}
                    </td>
                    <td className="py-2.5 pl-4 text-right">
                      <button
                        type="button"
                        onClick={async () => {
                          await safeFetchJson(`/api/fuel/${log.id}`, { method: 'DELETE' });
                          await onRefreshAll();
                        }}
                        className="p-1 text-slate-400 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
