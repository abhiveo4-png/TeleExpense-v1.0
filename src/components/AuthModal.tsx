import React, { useState } from 'react';
import { CheckCircle2, Download, FolderSync, Lock, Upload, UserPlus, Users, X } from 'lucide-react';
import { UserProfile, UserRole } from '../types';
import { downloadAuthenticatedFile, safeFetchJson } from '../utils/api';
import { syncCustomAccounts } from '../utils/accounts';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  usersList: UserProfile[];
  onAuthenticated: (
    user: UserProfile,
    token?: string,
    meta?: { role?: UserRole; memberName?: string }
  ) => Promise<void>;
  onRefreshUsers: () => Promise<void>;
  onMigrated?: () => Promise<void>;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  usersList,
  onAuthenticated,
  onRefreshUsers,
  onMigrated,
}) => {
  const [tab, setTab] = useState<'switch' | 'register' | 'security' | 'family' | 'migrate'>('switch');
  const [selectedUserId, setSelectedUserId] = useState(currentUser?.id || usersList[0]?.id || '');
  const [password, setPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [familyMemberName, setFamilyMemberName] = useState('Pooja');
  const [familyCode, setFamilyCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [migrateMode, setMigrateMode] = useState<'replace' | 'merge'>('replace');
  const [migrateCounts, setMigrateCounts] = useState<Record<string, number> | null>(null);

  if (!isOpen) return null;

  const selectedProfile = usersList.find((u) => u.id === selectedUserId) || currentUser || usersList[0];

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProfile) return;
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const { data, error: err } = await safeFetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: selectedProfile.id, password }),
    });
    setBusy(false);
    if (err || !data?.user) {
      setError(err || 'Sign in failed.');
      return;
    }
    await onAuthenticated(data.user, data.token, { role: 'owner' });
    setPassword('');
    onClose();
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: err } = await safeFetchJson('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: regName, email: regEmail, password: regPassword }),
    });
    setBusy(false);
    if (err || !data?.user) {
      setError(err || 'Registration failed.');
      return;
    }
    await onRefreshUsers();
    await onAuthenticated(data.user, data.token, { role: 'owner' });
    onClose();
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const { data, error: err } = await safeFetchJson('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setBusy(false);
    if (err || !data?.user) {
      setError(err || 'Could not update password.');
      return;
    }
    await onAuthenticated(data.user, data.token, { role: 'owner' });
    setCurrentPassword('');
    setNewPassword('');
    setSuccessMsg('Workspace password updated.');
  };

  const handleFamilyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: err } = await safeFetchJson('/api/auth/family-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: selectedProfile?.id,
        memberName: familyMemberName,
        linkCode: familyCode,
      }),
    });
    setBusy(false);
    if (err || !data?.user) {
      setError(err || 'Family access failed.');
      return;
    }
    await onAuthenticated(data.user, data.token, {
      role: 'family',
      memberName: data.memberName,
    });
    onClose();
  };

  const handleExportFull = async () => {
    setBusy(true);
    setError('');
    setSuccessMsg('');
    setMigrateCounts(null);
    const safeName = (currentUser?.name || 'account').replace(/[^a-zA-Z0-9_-]/g, '_');
    const result = await downloadAuthenticatedFile(
      '/api/account/export-full',
      `teleexpense-migration-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Could not export full account.');
      return;
    }
    setSuccessMsg(`Downloaded ${result.filename}. Now switch/create your new account and upload this file.`);
  };

  const handleImportFull = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setSuccessMsg('');
    setMigrateCounts(null);

    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError('Invalid JSON file. Please upload a migration `.json` exported from TeleExpense.');
        return;
      }

      const txCandidate = parsed?.data?.transactions ?? parsed?.transactions;
      if (!Array.isArray(txCandidate)) {
        setError('Unsupported migration file format.');
        return;
      }

      const { data, error: err } = await safeFetchJson<{
        success: boolean;
        mode: 'replace' | 'merge';
        counts?: Record<string, number>;
        customAccounts?: any[];
      }>('/api/account/import-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: migrateMode, bundle: parsed }),
      });

      if (err || !data?.success) {
        setError(err || 'Migration import failed.');
        return;
      }

      if (Array.isArray(data.customAccounts)) {
        syncCustomAccounts(data.customAccounts);
      }
      if (onMigrated) {
        await onMigrated();
      } else {
        await onRefreshUsers();
      }

      setMigrateCounts(data.counts || null);
      setSuccessMsg(
        data.mode === 'replace'
          ? `All data migrated into ${currentUser?.name || 'this account'}.`
          : `Data merged into ${currentUser?.name || 'this account'}.`
      );
    } catch (err: any) {
      setError(err?.message || 'Unexpected error during migration.');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75">
      <div className="surface-panel rounded-xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-white">Workspace Account</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account modal"
            className="p-1.5 text-slate-400 hover:text-white rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 pt-4 flex gap-1 border-b border-white/[0.08] overflow-x-auto">
          {[
            { id: 'switch', label: 'Profiles' },
            { id: 'family', label: 'Family' },
            { id: 'security', label: 'Password' },
            { id: 'register', label: 'New' },
            { id: 'migrate', label: 'Migrate' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id as any);
                setError('');
                setSuccessMsg('');
                setMigrateCounts(null);
              }}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                tab === t.id
                  ? 'border-sky-400 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {tab === 'switch' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Select Profile</label>
                <select
                  value={selectedProfile?.id || ''}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
                >
                  {usersList.map((u) => (
                    <option key={u.id} value={u.id} className="bg-[#111827]">
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
              </div>
              {selectedProfile?.hasPassword && (
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter workspace password"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
                  />
                </div>
              )}
              {error && <p className="text-xs text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors"
              >
                {busy ? 'Signing in...' : 'Open Profile'}
              </button>
            </form>
          )}

          {tab === 'family' && (
            <form onSubmit={handleFamilyLogin} className="space-y-4">
              <p className="text-xs text-slate-400">
                Enter your display name and the 6-digit workspace code to view personal family entries.
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Member Name</label>
                <div className="relative">
                  <Users className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    value={familyMemberName}
                    onChange={(e) => setFamilyMemberName(e.target.value)}
                    className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-lg field-input"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">6-Digit Link Code</label>
                <input
                  type="text"
                  required
                  value={familyCode}
                  onChange={(e) => setFamilyCode(e.target.value)}
                  placeholder="e.g. 838107"
                  className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg field-input"
                />
              </div>
              {error && <p className="text-xs text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors"
              >
                Enter Family View
              </button>
            </form>
          )}

          {tab === 'security' && (
            <form onSubmit={handleChangePassword} className="space-y-4">
              {currentUser?.hasPassword && (
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Current Password</label>
                  <input
                    type="password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  {currentUser?.hasPassword ? 'New Password' : 'Claim / Set Workspace Password'}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    minLength={4}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 4 characters"
                    className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-lg field-input"
                  />
                </div>
              </div>
              {error && <p className="text-xs text-rose-400">{error}</p>}
              {successMsg && <p className="text-xs text-emerald-400">{successMsg}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors"
              >
                {currentUser?.hasPassword ? 'Update Password' : 'Set Password'}
              </button>
            </form>
          )}

          {tab === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Full Name</label>
                <div className="relative">
                  <UserPlus className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="e.g. Rohan Sharma"
                    className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-lg field-input"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
                <input
                  type="email"
                  required
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Password (Optional)</label>
                <input
                  type="password"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="Optional lock password"
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg field-input"
                />
              </div>
              {error && <p className="text-xs text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors"
              >
                Create Profile
              </button>
            </form>
          )}

          {tab === 'migrate' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-[#0B0F17] border border-white/[0.08] space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <FolderSync className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Active Target: {currentUser?.name || 'Workspace'}</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  1. Open old account &amp; click <strong className="text-slate-200">Download Full Account</strong>.
                  <br />
                  2. Create or switch to your new account &amp; click{' '}
                  <strong className="text-slate-200">Upload Migration File</strong>. Everything moves in 1 click.
                </p>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={handleExportFull}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-slate-100 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{busy ? 'Working...' : 'Download Full Account (.json)'}</span>
              </button>

              <div className="pt-3 border-t border-white/[0.08] space-y-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-400">Upload Mode</span>
                  <div className="inline-flex rounded-lg bg-[#0B0F17] p-0.5 border border-white/[0.08]">
                    <button
                      type="button"
                      onClick={() => setMigrateMode('replace')}
                      className={`px-2.5 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
                        migrateMode === 'replace'
                          ? 'bg-sky-400 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Replace All
                    </button>
                    <button
                      type="button"
                      onClick={() => setMigrateMode('merge')}
                      className={`px-2.5 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap ${
                        migrateMode === 'merge'
                          ? 'bg-sky-400 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Merge
                    </button>
                  </div>
                </div>

                <label
                  className={`w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap ${
                    busy ? 'opacity-60 pointer-events-none' : 'cursor-pointer'
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{busy ? 'Migrating...' : 'Upload Migration File (.json)'}</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleImportFull}
                    disabled={busy}
                    className="hidden"
                  />
                </label>
              </div>

              {error && <p className="text-xs text-rose-400">{error}</p>}
              {successMsg && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{successMsg}</span>
                  </div>
                  {migrateCounts && (
                    <div className="grid grid-cols-2 gap-1 pt-1 font-mono tabular-nums text-[11px] text-slate-200">
                      <div>Txns: {migrateCounts.transactions ?? 0}</div>
                      <div>Budgets: {migrateCounts.budgets ?? 0}</div>
                      <div>Udhaar: {migrateCounts.udhaars ?? 0}</div>
                      <div>Investments: {migrateCounts.investments ?? 0}</div>
                      <div>EMIs: {migrateCounts.cardEmis ?? 0}</div>
                      <div>Custom Banks: {migrateCounts.customAccounts ?? 0}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
