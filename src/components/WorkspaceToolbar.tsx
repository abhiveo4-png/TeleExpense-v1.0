import React from 'react';
import { Calendar, Eye, EyeOff, RefreshCw, Shield, Users } from 'lucide-react';
import { UserRole } from '../types';
import { formatMonthLabel } from '../utils/formatters';

interface WorkspaceToolbarProps {
  selectedMonth: string;
  availableMonths: string[];
  onSelectMonth: (month: string) => void;
  userRole: UserRole;
  onToggleRole: (role: UserRole) => void;
  isPrivacyMode: boolean;
  onTogglePrivacy: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  transactionCount: number;
}

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({
  selectedMonth,
  availableMonths,
  onSelectMonth,
  userRole,
  onToggleRole,
  isPrivacyMode,
  onTogglePrivacy,
  onRefresh,
  isRefreshing,
  transactionCount,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.08]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-2 bg-[#111827] border border-white/[0.08] rounded-lg px-3 py-1.5">
          <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
          <select
            aria-label="Filter by month"
            value={selectedMonth}
            onChange={(e) => onSelectMonth(e.target.value)}
            className="bg-transparent text-sm font-medium text-slate-100 focus:outline-none cursor-pointer pr-1"
          >
            <option value="all" className="bg-[#111827] text-slate-100">
              All Months ({transactionCount})
            </option>
            {availableMonths.map((m) => (
              <option key={m} value={m} className="bg-[#111827] text-slate-100">
                {formatMonthLabel(m)}
              </option>
            ))}
          </select>
        </div>

        <div className="inline-flex items-center p-1 bg-[#111827] border border-white/[0.08] rounded-lg">
          <button
            type="button"
            onClick={() => onToggleRole('owner')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              userRole === 'owner'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Owner</span>
          </button>
          <button
            type="button"
            onClick={() => onToggleRole('family')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              userRole === 'family'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Family</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onTogglePrivacy}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#111827] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          {isPrivacyMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          <span>{isPrivacyMode ? 'Show Figures' : 'Hide Figures'}</span>
        </button>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#111827] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Sync</span>
        </button>
      </div>
    </div>
  );
};
