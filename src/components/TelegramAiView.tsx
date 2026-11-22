import React, { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderSync,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  AiFinancialInsights,
  BotConfig,
  TelegramLog,
  Transaction,
  UserProfile,
} from '../types';
import { downloadAuthenticatedFile, safeFetchJson } from '../utils/api';
import { syncCustomAccounts } from '../utils/accounts';
import { formatMoney } from '../utils/formatters';

interface TelegramAiViewProps {
  currentUser: UserProfile | null;
  botConfig: BotConfig | null;
  webhookUrl: string;
  selectedMonth: string;
  isPrivacyMode: boolean;
  onRefreshAll: () => Promise<void>;
}

const decodeHtmlEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Safely converts Telegram HTML subset (<b>, <i>, <code>) into React JSX nodes
 * without ever using dangerouslySetInnerHTML.
 */
const TelegramFormattedText: React.FC<{ text: string }> = ({ text }) => {
  const tokenRegex = /<(b|i|code)>([\s\S]*?)<\/\1>/g;

  const renderInline = (input: string, keyPrefix: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const localRegex = new RegExp(tokenRegex.source, 'g');
    let idx = 0;

    while ((match = localRegex.exec(input)) !== null) {
      if (match.index > lastIndex) {
        nodes.push(decodeHtmlEntities(input.slice(lastIndex, match.index)));
      }
      const tag = match[1];
      const inner = match[2];
      const childKey = `${keyPrefix}-${idx++}`;
      const children = renderInline(inner, childKey);
      if (tag === 'b') {
        nodes.push(
          <strong key={childKey} className="font-semibold text-white">
            {children}
          </strong>
        );
      } else if (tag === 'i') {
        nodes.push(
          <em key={childKey} className="italic text-slate-400">
            {children}
          </em>
        );
      } else {
        nodes.push(
          <code
            key={childKey}
            className="px-1.5 py-0.5 mx-0.5 rounded bg-slate-800/90 border border-white/[0.08] font-mono text-[11px] text-sky-300"
          >
            {children}
          </code>
        );
      }
      lastIndex = localRegex.lastIndex;
    }

    if (lastIndex < input.length) {
      nodes.push(decodeHtmlEntities(input.slice(lastIndex)));
    }
    return nodes;
  };

  const lines = text.split('\n');
  return (
    <div className="space-y-1 leading-relaxed break-words">
      {lines.map((line, i) =>
        line.trim() === '' ? (
          <div key={i} className="h-1.5" />
        ) : (
          <div key={i}>{renderInline(line, `line-${i}`)}</div>
        )
      )}
    </div>
  );
};

const QUICK_TEST_INPUTS: Array<{ label: string; text: string }> = [
  { label: '/worth', text: '/worth' },
  { label: '/summary', text: '/summary' },
  { label: '/balance', text: '/balance' },
  { label: '/udhaar', text: '/udhaar' },
  { label: '/rim', text: '/rim' },
  { label: '/help', text: '/help' },
  { label: '180 chai cash', text: '180 chai cash' },
  { label: '250 lunch wife', text: '250 lunch wife' },
  { label: 'rim 900 cab sbi 5733', text: 'rim 900 cab sbi 5733' },
  { label: '/undo', text: '/undo' },
];

export const TelegramAiView: React.FC<TelegramAiViewProps> = ({
  currentUser,
  botConfig,
  webhookUrl,
  selectedMonth,
  isPrivacyMode,
  onRefreshAll,
}) => {
  const [botTokenInput, setBotTokenInput] = useState('');
  const [simMessage, setSimMessage] = useState('');
  const [simRunning, setSimRunning] = useState(false);
  const [simExchange, setSimExchange] = useState<{
    sentText: string;
    reply: string;
    status: 'success' | 'warning' | 'error';
    transactions: Transaction[];
  } | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [logs, setLogs] = useState<TelegramLog[]>([]);
  const [botFeedback, setBotFeedback] = useState('');
  const [copiedField, setCopiedField] = useState<'code' | 'webhook' | null>(null);

  // Gemini Advisor State
  const [insights, setInsights] = useState<AiFinancialInsights | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [askingAi, setAskingAi] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');

  // 1-Click Account Migration State
  const [migrationMode, setMigrationMode] = useState<'replace' | 'merge'>('replace');
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<{
    type: 'success' | 'error';
    text: string;
    counts?: Record<string, number>;
  } | null>(null);

  const fetchLogs = async () => {
    const { data } = await safeFetchJson<{ logs: TelegramLog[] }>('/api/telegram/logs');
    if (data?.logs) setLogs(data.logs);
  };

  useEffect(() => {
    fetchLogs();
  }, [currentUser?.id]);

  const handleCopy = async (value: string, field: 'code' | 'webhook') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Clipboard blocked in non-HTTPS iframe contexts; ignore gracefully
    }
  };

  const handleSaveBotToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botTokenInput.trim()) return;
    setBotFeedback('');
    const { data, error } = await safeFetchJson<{ botUsername?: string }>('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: botTokenInput.trim() }),
    });
    if (error) {
      setBotFeedback(error);
      return;
    }
    setBotTokenInput('');
    setBotFeedback(`Connected @${data?.botUsername || 'bot'} successfully & synced commands.`);
    await onRefreshAll();
  };

  const handleSetWebhook = async () => {
    setBotFeedback('');
    const { error } = await safeFetchJson('/api/telegram/set-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl }),
    });
    setBotFeedback(error ? error : 'Telegram webhook & command menu activated.');
    await onRefreshAll();
  };

  const runSimulation = async (textToRun: string) => {
    const trimmed = textToRun.trim();
    if (!trimmed || simRunning) return;
    setSimRunning(true);
    const { data, error } = await safeFetchJson<{
      reply?: string;
      status?: 'success' | 'warning' | 'error';
      transactions?: Transaction[];
    }>('/api/telegram/simulate-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    });
    setSimRunning(false);
    setSimExchange({
      sentText: trimmed,
      reply: error || data?.reply || 'No reply returned.',
      status: error ? 'error' : data?.status || 'success',
      transactions: data?.transactions || [],
    });
    setSimMessage('');
    await Promise.all([fetchLogs(), onRefreshAll()]);
  };

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    await runSimulation(simMessage);
  };

  const handleGenerateInsights = async () => {
    setLoadingInsights(true);
    setInsightsError('');
    const { data, error } = await safeFetchJson<{ insights?: AiFinancialInsights }>('/api/ai/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: selectedMonth }),
    });
    setLoadingInsights(false);
    if (error || !data?.insights) {
      setInsightsError(error || 'Unable to generate financial audit.');
      return;
    }
    setInsights(data.insights);
  };

  const handleAskAdvisor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiQuestion.trim()) return;
    setAskingAi(true);
    setAiAnswer('');
    const { data, error } = await safeFetchJson<{ answer?: string }>('/api/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: aiQuestion.trim() }),
    });
    setAskingAi(false);
    setAiAnswer(error ? `Error: ${error}` : data?.answer || '');
  };

  const handleRestoreExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoreMsg('');
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const readSheet = (name: string, fallbackIndex?: number) => {
        const ws =
          wb.Sheets[name] ||
          (fallbackIndex !== undefined && wb.SheetNames[fallbackIndex]
            ? wb.Sheets[wb.SheetNames[fallbackIndex]]
            : undefined);
        return ws ? XLSX.utils.sheet_to_json(ws) : undefined;
      };

      const transactions = readSheet('Transactions', 0) || [];
      const { data, error } = await safeFetchJson<{ message?: string; customAccounts?: any[] }>(
        '/api/transactions/restore-backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transactions,
            categories: readSheet('Categories'),
            budgets: readSheet('Budgets'),
            udhaars: readSheet('Udhaar'),
            investments: readSheet('Investments'),
            fuelLogs: readSheet('FuelLogs'),
            cardEmis: readSheet('CardEMIs'),
            savingsTransfers: readSheet('SavingsTransfers'),
            dailyItemLimits: readSheet('DailyLimits'),
            piggyBankFunds: readSheet('PiggyBankFunds'),
            accountSettings: readSheet('AccountSettings'),
          }),
        }
      );
      if (Array.isArray(data?.customAccounts)) {
        syncCustomAccounts(data.customAccounts);
      }
      setRestoreMsg(error || data?.message || 'Backup restored.');
      await onRefreshAll();
    } catch (err: any) {
      setRestoreMsg(err?.message || 'Unable to read workbook file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleExportExcel = async () => {
    if (isExportingExcel) return;
    setIsExportingExcel(true);
    setRestoreMsg('');
    const result = await downloadAuthenticatedFile(
      '/api/transactions/export-backup',
      `teleexpense-backup-${new Date().toISOString().slice(0, 10)}.xlsx`
    );
    setIsExportingExcel(false);
    if (!result.ok) {
      setRestoreMsg(result.error || 'Failed to export Excel backup.');
    }
  };

  const handleExportFullAccount = async () => {
    if (isExportingFull) return;
    setIsExportingFull(true);
    setMigrationStatus(null);
    const safeName = (currentUser?.name || 'account').replace(/[^a-zA-Z0-9_-]/g, '_');
    const result = await downloadAuthenticatedFile(
      '/api/account/export-full',
      `teleexpense-migration-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
    );
    setIsExportingFull(false);
    if (!result.ok) {
      setMigrationStatus({
        type: 'error',
        text: result.error || 'Could not export full account data.',
      });
      return;
    }
    setMigrationStatus({
      type: 'success',
      text: `Downloaded complete account snapshot (${result.filename}). Upload this file in your new account to migrate everything in 1 click.`,
    });
  };

  const handleImportFullAccount = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsImportingFull(true);
    setMigrationStatus(null);

    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        setMigrationStatus({
          type: 'error',
          text: 'Invalid JSON file. Please select a `.json` file exported from TeleExpense.',
        });
        return;
      }

      const txCandidate = parsed?.data?.transactions ?? parsed?.transactions;
      if (!Array.isArray(txCandidate)) {
        setMigrationStatus({
          type: 'error',
          text: 'Unsupported migration file format. Expected an account migration `.json` bundle.',
        });
        return;
      }

      const { data, error } = await safeFetchJson<{
        success: boolean;
        mode: 'replace' | 'merge';
        counts?: Record<string, number>;
        customAccounts?: any[];
      }>('/api/account/import-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: migrationMode, bundle: parsed }),
      });

      if (error || !data?.success) {
        setMigrationStatus({
          type: 'error',
          text: error || 'Failed to import migration bundle.',
        });
        return;
      }

      if (Array.isArray(data.customAccounts)) {
        syncCustomAccounts(data.customAccounts);
      }

      await onRefreshAll();
      setMigrationStatus({
        type: 'success',
        text:
          data.mode === 'replace'
            ? `Full account migration complete into ${currentUser?.name || 'current account'}.`
            : `Merged migration bundle into ${currentUser?.name || 'current account'}.`,
        counts: data.counts,
      });
    } catch (err: any) {
      setMigrationStatus({
        type: 'error',
        text: err?.message || 'Unexpected error while reading migration file.',
      });
    } finally {
      setIsImportingFull(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Telegram Bot Setup & Family Link Code */}
        <section className="surface-panel rounded-xl p-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-sky-400 shrink-0" />
                <h2 className="font-display text-base font-semibold text-white">Telegram Bot Connection</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {botConfig?.isConnected ? (
                  <>
                    Connected to <span className="text-slate-200 font-medium">@{botConfig.botUsername || 'Bot'}</span> ·{' '}
                    <span className={botConfig.isWebhookSet ? 'text-emerald-400' : 'text-amber-400'}>
                      {botConfig.isWebhookSet ? 'Webhook active' : 'Webhook pending'}
                    </span>
                    {botConfig.pendingUpdateCount ? ` · ${botConfig.pendingUpdateCount} queued` : ''}
                  </>
                ) : (
                  'Connect your Telegram @BotFather token to log expenses from chat.'
                )}
              </p>
            </div>
            {botConfig?.isConnected && (
              <button
                type="button"
                onClick={handleSetWebhook}
                className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0"
              >
                {botConfig.isWebhookSet ? 'Re-sync Webhook' : 'Activate Webhook'}
              </button>
            )}
          </div>

          {botConfig?.lastError && (
            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-xs text-rose-300">
              Webhook issue: {botConfig.lastError}
            </div>
          )}

          <form onSubmit={handleSaveBotToken} className="flex gap-2">
            <input
              type="password"
              value={botTokenInput}
              onChange={(e) => setBotTokenInput(e.target.value)}
              placeholder={botConfig?.botToken ? `Active token (${botConfig.botToken})` : 'Paste @BotFather token'}
              className="flex-1 px-3 py-2 text-xs font-mono rounded-lg field-input"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg whitespace-nowrap shrink-0"
            >
              Save Token
            </button>
          </form>
          {botFeedback && <p className="text-xs text-sky-400">{botFeedback}</p>}

          {webhookUrl && (
            <div className="p-2.5 rounded-lg bg-[#0B0F17] border border-white/[0.06] flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500">Webhook Endpoint</div>
                <div className="font-mono text-[11px] text-slate-300 truncate">{webhookUrl}</div>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(webhookUrl, 'webhook')}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] text-slate-300 hover:text-white bg-slate-800/80 border border-white/[0.08] rounded-md shrink-0"
              >
                {copiedField === 'webhook' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedField === 'webhook' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          )}

          <div className="pt-4 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-slate-400">6-Digit Telegram Link Code</div>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="text-lg font-bold font-mono tracking-widest text-white">
                  {currentUser?.linkCode || '------'}
                </div>
                {currentUser?.linkCode && (
                  <button
                    type="button"
                    onClick={() => handleCopy(`/link ${currentUser.linkCode}`, 'code')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-slate-400 hover:text-white bg-[#0B0F17] border border-white/[0.08] rounded"
                  >
                    {copiedField === 'code' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedField === 'code' ? 'Copied' : 'Copy /link'}</span>
                  </button>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                Send <code className="text-slate-300">/link {currentUser?.linkCode}</code> to your bot
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                await safeFetchJson('/api/auth/regenerate-linkcode', { method: 'POST' });
                await onRefreshAll();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 bg-[#0E1420] border border-white/10 rounded-lg hover:text-white whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Rotate Code</span>
            </button>
          </div>

          {(currentUser?.linkedMembers || []).length > 0 && (
            <div className="pt-4 border-t border-white/[0.08] space-y-2">
              <div className="text-xs font-semibold text-slate-300">
                Linked Family Members ({currentUser?.linkedMembers?.length})
              </div>
              <div className="divide-y divide-white/[0.06]">
                {(currentUser?.linkedMembers || []).map((member) => (
                  <div key={member.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <span className="text-slate-200 font-medium">
                        {member.customAlias || member.name}
                      </span>
                      {member.telegramUsername && (
                        <span className="text-slate-500 ml-1.5">@{member.telegramUsername}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await safeFetchJson(`/api/auth/members/${encodeURIComponent(member.id)}`, {
                          method: 'DELETE',
                        });
                        await onRefreshAll();
                      }}
                      title="Unlink member"
                      className="p-1 text-slate-500 hover:text-rose-400 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(currentUser?.pendingRequests || []).length > 0 && (
            <div className="pt-4 border-t border-white/[0.08] space-y-2">
              <div className="text-xs font-semibold text-amber-400">Pending Member Approvals</div>
              {(currentUser?.pendingRequests || []).map((req) => (
                <div key={req.id} className="flex items-center justify-between gap-2 text-xs py-1.5">
                  <span className="text-slate-200">
                    {req.name} {req.telegramUsername ? `(@${req.telegramUsername})` : ''}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        await safeFetchJson('/api/members/approve-request', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ requestId: req.id }),
                        });
                        await onRefreshAll();
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 rounded"
                    >
                      <Check className="w-3 h-3" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await safeFetchJson('/api/members/reject-request', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ requestId: req.id }),
                        });
                        await onRefreshAll();
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 rounded"
                    >
                      <X className="w-3 h-3" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Live Telegram Bot Simulator & Formatted Reply Preview */}
        <section className="surface-panel rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-white">Bot Simulator &amp; Response Preview</h2>
              <p className="text-xs text-slate-400">
                Test commands or chat entries and inspect the exact formatted Telegram response.
              </p>
            </div>
            {simExchange && (
              <span
                className={`px-2 py-0.5 text-[11px] font-medium rounded border whitespace-nowrap shrink-0 ${
                  simExchange.status === 'success'
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
                    : simExchange.status === 'warning'
                    ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                    : 'bg-rose-500/10 text-rose-300 border-rose-500/25'
                }`}
              >
                {simExchange.transactions.length > 0
                  ? `${simExchange.transactions.length} Logged`
                  : simExchange.status === 'success'
                  ? 'Command OK'
                  : simExchange.status}
              </span>
            )}
          </div>

          {/* 1-click quick command & message chips */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_TEST_INPUTS.map((q) => (
              <button
                key={q.text}
                type="button"
                disabled={simRunning}
                onClick={() => runSimulation(q.text)}
                className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white bg-[#0B0F17] hover:bg-slate-800 border border-white/[0.08] rounded-md transition-colors whitespace-nowrap disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSimulate} className="flex gap-2">
            <input
              type="text"
              value={simMessage}
              onChange={(e) => setSimMessage(e.target.value)}
              placeholder='Try "250 coffee wife", "/worth", "/summary", "/rim", "/undo"'
              className="flex-1 px-3 py-2 text-xs rounded-lg field-input"
            />
            <button
              type="submit"
              disabled={simRunning || !simMessage.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{simRunning ? 'Sending...' : 'Send'}</span>
            </button>
          </form>

          {simExchange && (
            <div className="rounded-xl bg-[#0B0F17] border border-white/[0.08] p-3.5 space-y-3">
              {/* User Sent Bubble */}
              <div className="flex justify-end">
                <div className="max-w-[85%] px-3 py-1.5 rounded-lg bg-sky-500/15 border border-sky-400/25 text-xs text-sky-100 font-mono">
                  {simExchange.sentText}
                </div>
              </div>

              {/* Bot Reply Bubble */}
              <div className="flex justify-start">
                <div className="w-full p-3 rounded-lg bg-[#111827] border border-white/[0.08] text-xs text-slate-200">
                  <div className="flex items-center gap-1.5 text-[11px] text-sky-400 font-medium mb-1.5">
                    <Bot className="w-3.5 h-3.5" />
                    <span>@{botConfig?.botUsername || 'TeleExpenseBot'}</span>
                  </div>
                  <TelegramFormattedText text={simExchange.reply} />
                </div>
              </div>
            </div>
          )}

          {/* Recent Bot Activity Logs */}
          <div className="pt-2 space-y-2 border-t border-white/[0.08]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-400">Recent Bot Activity ({logs.length})</span>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    await safeFetchJson('/api/telegram/logs', { method: 'DELETE' });
                    fetchLogs();
                  }}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="max-h-60 overflow-y-auto divide-y divide-white/[0.06]">
              {logs.length === 0 ? (
                <p className="text-xs text-slate-500 py-3">No recent messages recorded.</p>
              ) : (
                logs.slice(0, 15).map((l) => {
                  const isOpen = expandedLogId === l.id;
                  const timeStr = l.timestamp
                    ? new Date(l.timestamp).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '';
                  return (
                    <div key={l.id} className="py-2.5 text-xs space-y-1.5">
                      <button
                        type="button"
                        onClick={() => setExpandedLogId(isOpen ? null : l.id)}
                        className="w-full text-left flex items-center justify-between gap-2 group"
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              l.status === 'success'
                                ? 'bg-emerald-400'
                                : l.status === 'warning'
                                ? 'bg-amber-400'
                                : 'bg-rose-400'
                            }`}
                          />
                          <span className="truncate font-medium text-slate-200 group-hover:text-white">
                            {l.rawText || l.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 text-[11px] text-slate-500">
                          <span>{l.user ? `${l.user} · ` : ''}{timeStr}</span>
                          {l.botReply && (isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />)}
                        </div>
                      </button>

                      {l.parsedTransactions && l.parsedTransactions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pl-3.5">
                          {l.parsedTransactions.map((pt, idx) => (
                            <span
                              key={idx}
                              className={`px-2 py-0.5 text-[11px] font-mono tabular-nums rounded border ${
                                pt.type === 'income'
                                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                                  : 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                              }`}
                            >
                              {pt.type === 'income' ? '+' : '-'}₹{Math.round(pt.amount).toLocaleString('en-IN')} · {pt.category}
                            </span>
                          ))}
                        </div>
                      )}

                      {isOpen && l.botReply && (
                        <div className="ml-3.5 p-2.5 rounded-lg bg-[#0B0F17] border border-white/[0.06] text-[11px] text-slate-300">
                          <TelegramFormattedText text={l.botReply} />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Supported Bot Commands & Message Formatting Reference */}
      <section className="surface-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-semibold text-white">Bot Commands &amp; Quick Formats</h2>
            <p className="text-xs text-slate-400">
              All Telegram commands &amp; natural Hinglish message rules synced with your Current Worth, Wife account, Reimbursements &amp; Udhaar.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="bg-[#0B0F17] border border-white/[0.06] rounded-lg p-3.5 space-y-2">
            <div className="text-slate-300 font-semibold">Live Bot Commands</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 gap-x-3 text-slate-400">
              <div><code className="text-sky-300 font-mono">/worth</code> — Net worth + breakup</div>
              <div><code className="text-sky-300 font-mono">/summary</code> — Personal vs Total Kharcha</div>
              <div><code className="text-sky-300 font-mono">/balance</code> — Banks, Wife, Cash &amp; Cards</div>
              <div><code className="text-sky-300 font-mono">/udhaar</code> — Lent &amp; Borrowed dues</div>
              <div><code className="text-sky-300 font-mono">/rim</code> — Pending reimbursements</div>
              <div><code className="text-sky-300 font-mono">/undo</code> — Delete last logged entry</div>
              <div><code className="text-sky-300 font-mono">/ai &lt;q&gt;</code> — Ask AI advisor in chat</div>
              <div><code className="text-sky-300 font-mono">/help</code> — Show formatting examples</div>
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-white/[0.06] rounded-lg p-3.5 space-y-2">
            <div className="text-slate-300 font-semibold">Chat Logging Examples</div>
            <div className="space-y-1 text-slate-400">
              <div><code className="text-emerald-300 font-mono">180 chai cash</code> · Expense from Cash</div>
              <div><code className="text-emerald-300 font-mono">250 coffee wife</code> · Spend paid from Wife account</div>
              <div><code className="text-emerald-300 font-mono">5000 wife transfer ax bank</code> · Transfer to Wife</div>
              <div><code className="text-emerald-300 font-mono">rim 900 cab sbi 5733</code> · Office claim (Excluded)</div>
              <div><code className="text-emerald-300 font-mono">udhaar diya 2000 rohan ax bank</code> · Lent + Khata</div>
              <div><code className="text-emerald-300 font-mono">1100 petrol 45200 km 10L</code> · Fuel + Odometer</div>
            </div>
          </div>
        </div>
      </section>

      {/* Gemini AI Financial Advisor */}
      <section className="surface-panel rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-white">Gemini Financial Advisor</h2>
            <p className="text-xs text-slate-400">
              Generate a grounded spending audit or ask natural-language questions about your ledger.
            </p>
          </div>
          <button
            type="button"
            disabled={loadingInsights}
            onClick={handleGenerateInsights}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{loadingInsights ? 'Analyzing Ledger...' : 'Run Financial Audit'}</span>
          </button>
        </div>

        {insightsError && <p className="text-xs text-rose-400">{insightsError}</p>}

        {insights && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 pt-2 border-t border-white/[0.08]">
            <div className="space-y-2">
              <div className="text-xs text-slate-400">Health Assessment · {insights.verdict}</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-white">
                {insights.healthScore} / 100
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{insights.overview}</p>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">Key Findings &amp; Saving Tips</div>
              <ul className="space-y-1.5 text-xs text-slate-400 list-disc pl-4">
                {insights.keyInsights.slice(0, 3).map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
                {insights.savingTips.slice(0, 2).map((tip, idx) => (
                  <li key={`t-${idx}`} className="text-emerald-300">{tip}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">Avoidable Discretionary Spend</div>
              <div className="text-lg font-bold font-mono tabular-nums text-amber-400">
                {formatMoney(insights.avoidableExpenses.totalAvoidableAmount, isPrivacyMode)}
              </div>
              <p className="text-xs text-slate-400">{insights.avoidableExpenses.investmentAdvice}</p>
            </div>
          </div>
        )}

        <form onSubmit={handleAskAdvisor} className="flex gap-2 pt-2 border-t border-white/[0.08]">
          <input
            type="text"
            value={aiQuestion}
            onChange={(e) => setAiQuestion(e.target.value)}
            placeholder="Ask anything: e.g. How much did I spend on food this month?"
            className="flex-1 px-3.5 py-2.5 text-sm rounded-lg field-input"
          />
          <button
            type="submit"
            disabled={askingAi || !aiQuestion.trim()}
            className="px-4 py-2.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg whitespace-nowrap disabled:opacity-50"
          >
            {askingAi ? 'Thinking...' : 'Ask Advisor'}
          </button>
        </form>

        {aiAnswer && (
          <div className="p-4 rounded-lg bg-[#0B0F17] border border-white/[0.08] text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
            {aiAnswer}
          </div>
        )}
      </section>

      {/* 1-Click Full Account Migration */}
      <section className="surface-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="flex items-center gap-2">
              <FolderSync className="w-4 h-4 text-sky-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-white">
                1-Click Full Account Migration (Export &amp; Import Everything)
              </h2>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Download every record from <span className="text-slate-200 font-medium">{currentUser?.name || 'this account'}</span> —
              transactions, categories, budgets, bank/card base balances &amp; credit limits, custom banks, Udhaar Khata,
              Card EMIs, investments, Gullak/Piggy Bank funds, fuel logs, and daily limits — into one portable{' '}
              <code className="text-slate-300">.json</code> file and restore it in 1 click on any new account.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={isExportingFull}
              onClick={handleExportFullAccount}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingFull ? 'Exporting...' : 'Download Full Account (.json)'}</span>
            </button>

            <label
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg whitespace-nowrap shrink-0 ${
                isImportingFull ? 'opacity-60 pointer-events-none' : 'cursor-pointer'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{isImportingFull ? 'Uploading...' : 'Upload & Migrate (.json)'}</span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleImportFullAccount}
                disabled={isImportingFull}
                className="hidden"
              />
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Import mode:</span>
            <div className="inline-flex rounded-lg bg-[#0B0F17] p-0.5 border border-white/[0.08]">
              <button
                type="button"
                onClick={() => setMigrationMode('replace')}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                  migrationMode === 'replace'
                    ? 'bg-sky-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Replace All (New Account)
              </button>
              <button
                type="button"
                onClick={() => setMigrationMode('merge')}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                  migrationMode === 'merge'
                    ? 'bg-sky-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Merge with Existing
              </button>
            </div>
          </div>
          <span className="text-[11px] text-slate-500">
            {migrationMode === 'replace'
              ? 'Clones exact state into this workspace (overwrites existing entries).'
              : 'Adds missing records by ID without deleting existing entries.'}
          </span>
        </div>

        {migrationStatus && (
          <div
            className={`p-3 rounded-lg border text-xs space-y-2 ${
              migrationStatus.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {migrationStatus.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
              <span>{migrationStatus.text}</span>
            </div>
            {migrationStatus.counts && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono tabular-nums text-[11px] text-slate-200">
                <div>Transactions: {migrationStatus.counts.transactions ?? 0}</div>
                <div>Categories: {migrationStatus.counts.categories ?? 0}</div>
                <div>Budgets: {migrationStatus.counts.budgets ?? 0}</div>
                <div>Custom Banks: {migrationStatus.counts.customAccounts ?? 0}</div>
                <div>Udhaar: {migrationStatus.counts.udhaars ?? 0}</div>
                <div>Investments: {migrationStatus.counts.investments ?? 0}</div>
                <div>Card EMIs: {migrationStatus.counts.cardEmis ?? 0}</div>
                <div>Gullak Funds: {migrationStatus.counts.piggyBankFunds ?? 0}</div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Excel Backup & Restore */}
      <section className="surface-panel rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-base font-semibold text-white">Excel Workbook Backup &amp; Restore</h2>
          <p className="text-xs text-slate-400">
            Export &amp; restore all 12 sheets — transactions, categories &amp; spend rules, budgets, udhaar &amp; partial settlements, investments, EMIs, fuel logs, goal funds, and account balances — in `.xlsx`.
          </p>
          {restoreMsg && <p className="text-xs text-emerald-400 mt-1">{restoreMsg}</p>}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isExportingExcel}
            onClick={handleExportExcel}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExportingExcel ? 'Exporting...' : 'Export Backup (.xlsx)'}</span>
          </button>
          <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg cursor-pointer whitespace-nowrap shrink-0">
            <Upload className="w-3.5 h-3.5" />
            <span>Restore Workbook</span>
            <input type="file" accept=".xlsx,.xls" onChange={handleRestoreExcel} className="hidden" />
          </label>
        </div>
      </section>
    </div>
  );
};
