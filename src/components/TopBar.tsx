import React from 'react';
import { Menu, Plus } from 'lucide-react';
import { WorkspaceTab } from './Sidebar';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenMobileNav: () => void;
  onOpenAddModal: () => void;
}

const TAB_TITLES: Record<WorkspaceTab, string> = {
  ledger: 'Overview & Ledger',
  cashflow: 'Bank Bachat (Cashflow)',
  accounts: 'Accounts & Cards',
  budgets: 'Budgets & Gullak',
  wealth: 'Wealth & Khata',
  analytics: 'Analytics & Fuel',
  telegram: 'Telegram & AI',
};

const QUICK_LINKS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'cashflow', label: 'Bank Bachat' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'wealth', label: 'Wealth' },
  { id: 'analytics', label: 'Analytics' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenMobileNav,
  onOpenAddModal,
}) => {
  return (
    <header className="h-16 px-4 sm:px-6 lg:px-8 border-b border-white/[0.08] bg-[#0B0F17]/95 backdrop-blur-sm sticky top-0 z-30 flex items-center justify-between gap-8">
      {/* Zone 1: Breadcrumb / Section Title */}
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white rounded-lg"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 text-sm whitespace-nowrap">
          <span className="text-slate-500 hidden sm:inline">Workspace</span>
          <span className="text-slate-600 hidden sm:inline">/</span>
          <h1 className="font-display text-base font-semibold text-white whitespace-nowrap">
            {TAB_TITLES[activeTab]}
          </h1>
        </div>
      </div>

      {/* Zone 2: Clean single-line text nav links */}
      <nav className="hidden xl:flex items-center gap-6 text-sm font-medium" aria-label="Quick views">
        {QUICK_LINKS.map((link) => {
          const isCurrent = activeTab === link.id;
          return (
            <button
              key={link.id}
              type="button"
              onClick={() => onSelectTab(link.id)}
              className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                isCurrent
                  ? 'text-white border-sky-400'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              {link.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Primary CTA */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={onOpenAddModal}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Log Entry</span>
        </button>
      </div>
    </header>
  );
};
