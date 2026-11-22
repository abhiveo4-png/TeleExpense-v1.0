import React from 'react';
import {
  ArrowLeftRight,
  LayoutList,
  Landmark,
  Target,
  PiggyBank,
  BarChart3,
  Send,
  UserCircle2,
  X,
} from 'lucide-react';
import { UserProfile, UserRole } from '../types';

export type WorkspaceTab =
  | 'ledger'
  | 'cashflow'
  | 'accounts'
  | 'budgets'
  | 'wealth'
  | 'analytics'
  | 'telegram';

interface SidebarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  currentUser: UserProfile | null;
  userRole: UserRole;
  activeFamilyMemberName: string;
  onOpenAuth: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'ledger', label: 'Overview & Ledger', icon: LayoutList },
  { id: 'cashflow', label: 'Bank Bachat (Cashflow)', icon: ArrowLeftRight },
  { id: 'accounts', label: 'Accounts & Cards', icon: Landmark },
  { id: 'budgets', label: 'Budgets & Gullak', icon: Target },
  { id: 'wealth', label: 'Wealth & Khata', icon: PiggyBank },
  { id: 'analytics', label: 'Analytics & Fuel', icon: BarChart3 },
  { id: 'telegram', label: 'Telegram & AI', icon: Send },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  currentUser,
  userRole,
  activeFamilyMemberName,
  onOpenAuth,
  isMobileOpen,
  onCloseMobile,
}) => {
  const displayName =
    userRole === 'family' && activeFamilyMemberName
      ? activeFamilyMemberName
      : currentUser?.name || 'Workspace';

  const navContent = (
    <div className="flex flex-col h-full bg-[#0E131D] border-r border-white/[0.08]">
      <div className="h-16 px-6 flex items-center justify-between border-b border-white/[0.08]">
        <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
          TeleExpense
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-2 text-slate-400 hover:text-white rounded-lg"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto" aria-label="Workspace sections">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/[0.08]">
        <button
          type="button"
          onClick={() => {
            onOpenAuth();
            onCloseMobile();
          }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors text-left"
        >
          <div className="w-9 h-9 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-sm font-semibold text-sky-300 shrink-0">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white truncate">{displayName}</div>
            <div className="text-xs text-slate-400 truncate">
              {userRole === 'family' ? 'Family View' : currentUser?.email || 'Manage account'}
            </div>
          </div>
          <UserCircle2 className="w-4 h-4 text-slate-500 shrink-0" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">{navContent}</aside>
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseMobile} />
          <aside className="relative w-72 max-w-[85vw] h-full z-10">{navContent}</aside>
        </div>
      )}
    </>
  );
};
