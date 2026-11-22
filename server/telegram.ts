import { getIstDateTime } from './defaults.js';
import {
  askFinancialAdvisor,
  isGeminiConfigured,
  parseMessageWithGemini,
} from './geminiService.js';
import {
  computeAccountBalances,
  computeFinancialSummary,
  isNonPersonalExpense,
  parseMessageDeterministic,
  recalculateFuelLogs,
} from './ledgerEngine.js';
import {
  addTelegramLog,
  getActiveAccountsMap,
  getActiveBotToken,
  getBotConfig,
  getUsers,
  getUserData,
  isChatInAiAdvisorMode,
  saveBotConfig,
  saveUserData,
  saveUsers,
  setActiveAccountForChat,
  setChatAiAdvisorMode,
} from './storage.js';
import { Transaction, UserDataStore, UserProfile } from './types.js';

export async function callTelegramApi(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; result?: any; description?: string }> {
  if (!token) return { ok: false, description: 'Bot token missing' };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  const token = getActiveBotToken();
  if (!token) return false;
  try {
    const res = await callTelegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

export async function syncBotCommands(token: string): Promise<boolean> {
  try {
    const res = await callTelegramApi(token, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'Welcome & quick logging examples' },
        { command: 'summary', description: 'Monthly income, personal spend & total kharcha' },
        { command: 'worth', description: 'Current Worth & full asset/liability breakup' },
        { command: 'balance', description: 'Banks, Wife, Cash & Credit Card dues' },
        { command: 'udhaar', description: 'Pending money lent or borrowed' },
        { command: 'rim', description: 'Pending & partial reimbursement claims' },
        { command: 'undo', description: 'Undo last logged transaction' },
        { command: 'ai', description: 'Ask AI financial advisor a question' },
        { command: 'link', description: 'Link chat using 6-digit ledger code' },
        { command: 'help', description: 'Show message formatting examples' },
      ],
    });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function findLinkedUsers(chatId: string, username?: string): UserProfile[] {
  const all = getUsers();
  const cleanUser = (username || '').replace('@', '').toLowerCase().trim();
  const matches = all.filter(u => {
    if (String(u.telegramChatId || '') === chatId) return true;
    if (cleanUser && (u.telegramUsername || '').replace('@', '').toLowerCase() === cleanUser) return true;
    return (u.linkedMembers || []).some(
      m =>
        String(m.telegramChatId || '') === chatId ||
        (cleanUser && (m.telegramUsername || '').replace('@', '').toLowerCase() === cleanUser)
    );
  });
  if (matches.length === 0 && all.length === 1) {
    return [all[0]];
  }
  return matches;
}

function formatInr(val: number): string {
  const num = Number(val || 0);
  const abs = Math.round(Math.abs(num)).toLocaleString('en-IN');
  return num < 0 ? `-₹${abs}` : `₹${abs}`;
}

function computeCurrentWorthSnapshot(store: UserDataStore) {
  const bal = computeAccountBalances(store);
  const allAccs = Object.values(bal.accounts);
  const yourBankTotal = allAccs
    .filter(a => a.type === 'bank_account' && a.accountId !== 'Wife')
    .reduce((s, a) => s + Number(a.currentBalance || 0), 0);
  const cashTotal = allAccs
    .filter(a => a.type === 'cash')
    .reduce((s, a) => s + Number(a.currentBalance || 0), 0);
  const wifeAcc = bal.accounts['Wife'];
  const wifeTotal = wifeAcc
    ? Number(wifeAcc.currentBalance || 0)
    : Number(bal.wifeSavings?.currentBalance || 0);

  const investmentsTotal = (store.investments || []).reduce(
    (s, inv) => s + Number(inv.currentValue && inv.currentValue > 0 ? inv.currentValue : inv.amount || 0),
    0
  );

  const udhaarLent = (store.udhaars || [])
    .filter(u => u.type === 'lent' && u.status !== 'settled')
    .reduce((s, u) => s + Math.max(0, Number(u.amount || 0) - Number(u.settledAmount || 0)), 0);

  const udhaarBorrowed = (store.udhaars || [])
    .filter(u => u.type === 'borrowed' && u.status !== 'settled')
    .reduce((s, u) => s + Math.max(0, Number(u.amount || 0) - Number(u.settledAmount || 0)), 0);

  const netUdhaar = udhaarLent - udhaarBorrowed;

  const rimPending = (store.transactions || [])
    .filter(
      t =>
        t.type === 'expense' &&
        (t.isReimbursement || t.category === 'Reimbursement') &&
        t.reimbursementStatus !== 'settled'
    )
    .reduce((s, t) => s + Math.max(0, Number(t.amount || 0) - Number(t.reimbursementSettledAmount || 0)), 0);

  const totalCurrentWorth = yourBankTotal + wifeTotal + cashTotal + investmentsTotal + netUdhaar + rimPending;
  const cardOutstanding = Number(bal.totalCardOutstanding || 0);

  return {
    bal,
    yourBankTotal,
    wifeTotal,
    cashTotal,
    investmentsTotal,
    udhaarLent,
    udhaarBorrowed,
    netUdhaar,
    rimPending,
    totalCurrentWorth,
    cardOutstanding,
    netWorthAfterCards: totalCurrentWorth - cardOutstanding,
  };
}

function computeOwnAccountOutflowsMonth(store: UserDataStore, activeMonth: string): number {
  return (store.transactions || []).reduce((sum, tx) => {
    if (tx.type !== 'expense') return sum;
    if (!tx.date?.startsWith(activeMonth)) return sum;
    if (tx.account === 'Wife' || tx.paymentMethod === 'Wife') return sum;
    return sum + Number(tx.amount || 0);
  }, 0);
}

function buildEntryTags(tx: Transaction, hasFuelLog: boolean): string[] {
  const tags: string[] = [];
  if (tx.isReimbursement) tags.push('🧾 Rim Claim (Pending)');
  else if (tx.isWifeTransfer || tx.isSavingsTransfer) tags.push('👩‍❤️‍👨 Wife Transfer (+Credited to Wife)');
  else if (tx.isCcPayment) tags.push('💳 CC Bill Payment');
  else if (tx.isUdhaarLent) {
    tags.push(`🤝 Udhaar Lent${tx.udhaarPersonName ? ` → ${escapeHtml(tx.udhaarPersonName)}` : ''}`);
  } else if (tx.isUdhaarRecovery) {
    tags.push(`🤝 Udhaar Received${tx.udhaarPersonName ? ` ← ${escapeHtml(tx.udhaarPersonName)}` : ''}`);
  } else if (tx.account === 'Wife' || tx.paymentMethod === 'Wife') {
    tags.push('👛 Paid via Wife Account');
  }
  if (hasFuelLog) tags.push('⛽ Fuel & Odo Logged');
  return tags;
}

export async function processIncomingTelegramText(params: {
  text: string;
  chatId: string;
  senderName: string;
  username?: string;
  messageId?: number;
  source?: 'telegram' | 'simulator';
}): Promise<{
  reply: string;
  transactions: Transaction[];
  status: 'success' | 'warning' | 'error';
}> {
  const { text, chatId, senderName, username, messageId, source = 'telegram' } = params;
  const trimmed = text.trim();
  const cmd = trimmed.split(/\s+/)[0].toLowerCase().replace(/@.+$/, '');

  if (!trimmed) {
    return { reply: 'Empty message ignored.', transactions: [], status: 'warning' };
  }

  // Handle /link <code>
  if (cmd === '/link') {
    const code = trimmed.replace(/^\/link(?:@\S+)?/i, '').trim();
    const allUsers = getUsers();
    const target = allUsers.find(u => u.linkCode === code);
    if (!target) {
      const reply =
        '❌ <b>Invalid 6-digit link code.</b>\nCheck your code inside <i>Telegram &amp; AI</i> tab and send:\n<code>/link 123456</code>';
      if (source === 'telegram') await sendTelegramMessage(chatId, reply);
      return { reply, transactions: [], status: 'warning' };
    }

    if (!target.telegramChatId) {
      target.telegramChatId = chatId;
      if (username) target.telegramUsername = username;
      saveUsers(allUsers);
      setActiveAccountForChat(chatId, target.id);
      const reply =
        `✅ Linked to <b>${escapeHtml(target.name)}</b>'s TeleExpense ledger!\n` +
        `Try logging: <code>180 chai cash</code> or check <code>/worth</code>.`;
      if (source === 'telegram') await sendTelegramMessage(chatId, reply);
      return { reply, transactions: [], status: 'success' };
    }

    target.pendingRequests = target.pendingRequests || [];
    const alreadyMember =
      target.telegramChatId === chatId ||
      (target.linkedMembers || []).some(m => m.telegramChatId === chatId);
    if (alreadyMember) {
      setActiveAccountForChat(chatId, target.id);
      const reply = `✅ This chat is already linked to <b>${escapeHtml(target.name)}</b>'s ledger.`;
      if (source === 'telegram') await sendTelegramMessage(chatId, reply);
      return { reply, transactions: [], status: 'success' };
    }

    if (!target.pendingRequests.some(r => r.chatId === chatId)) {
      target.pendingRequests.push({
        id: `req_${Date.now()}`,
        chatId,
        name: senderName,
        telegramUsername: username,
        linkCode: code,
        requestedAt: new Date().toISOString(),
      });
      saveUsers(allUsers);
    }
    const reply = `⏳ Link request sent to <b>${escapeHtml(target.name)}</b>. Ask them to approve it in the web dashboard.`;
    if (source === 'telegram') await sendTelegramMessage(chatId, reply);
    return { reply, transactions: [], status: 'success' };
  }

  const linked = findLinkedUsers(chatId, username);
  if (linked.length === 0) {
    const reply = '🔗 Chat not linked yet.\nSend <code>/link YOUR_6_DIGIT_CODE</code> from your dashboard.';
    if (source === 'telegram') await sendTelegramMessage(chatId, reply);
    return { reply, transactions: [], status: 'warning' };
  }

  const activeMap = getActiveAccountForChat(chatId, linked);
  const user = activeMap || linked[0];
  const store = getUserData(user.id);

  const finalizeCommand = async (reply: string, status: 'success' | 'warning' | 'error' = 'success') => {
    addTelegramLog({
      userId: user.id,
      type: status === 'warning' ? 'parse_error' : 'bot_reply',
      chatId,
      user: senderName,
      rawText: trimmed,
      botReply: reply,
      status,
    });
    if (source === 'telegram') await sendTelegramMessage(chatId, reply);
    return { reply, transactions: [] as Transaction[], status };
  };

  if (cmd === '/start' || cmd === '/help') {
    const reply =
      `👋 <b>TeleExpense Ledger · ${escapeHtml(user.name)}</b>\n\n` +
      `<b>Quick Logging Examples:</b>\n` +
      `• <code>180 chai snacks cash</code> — Cash expense\n` +
      `• <code>1250 groceries blinkit icici 0000</code> — Card spend\n` +
      `• <code>250 coffee wife</code> — Paid via Wife account\n` +
      `• <code>5000 wife transfer ax bank</code> — Transfer to Wife\n` +
      `• <code>rim 900 cab airport sbi 5733</code> — Office claim\n` +
      `• <code>salary 85000 ax bank</code> — Income\n` +
      `• <code>udhaar diya 2000 rohan ax bank</code> — Udhaar lent\n` +
      `• <code>1100 petrol 45200 km 10L</code> — Fuel + Odometer\n\n` +
      `<b>Bot Commands:</b>\n` +
      `/summary · /worth · /balance · /udhaar · /rim · /undo · /ai`;
    return finalizeCommand(reply);
  }

  if (cmd === '/summary') {
    const ist = getIstDateTime();
    const summary = computeFinancialSummary(store, ist.month);
    const totalKharcha = computeOwnAccountOutflowsMonth(store, ist.month);
    const kharchaNet = summary.currentMonthIncome - totalKharcha;
    const worth = computeCurrentWorthSnapshot(store);
    const [yr, mo] = ist.month.split('-').map(Number);
    const monthLabel = new Date(yr, mo - 1, 1).toLocaleDateString('en-IN', {
      month: 'short',
      year: 'numeric',
    });

    const reply =
      `📊 <b>${escapeHtml(monthLabel)} Summary</b>\n\n` +
      `🟢 Income: <b>${formatInr(summary.currentMonthIncome)}</b>\n` +
      `🔴 Personal Spend: <b>${formatInr(summary.currentMonthPersonalExpense)}</b>\n` +
      `💸 Total Kharcha (Cash/Card/Bank): <b>${formatInr(totalKharcha)}</b>\n` +
      `💰 Personal Surplus: <b>${formatInr(summary.currentMonthNetSavings)}</b>\n` +
      `⚖️ Income − Total Kharcha: <b>${formatInr(kharchaNet)}</b>\n\n` +
      `🧾 Pending Rim: <b>${formatInr(summary.pendingReimbursements)}</b>\n` +
      `🤝 Pending Udhaar (Lent): <b>${formatInr(summary.pendingUdhaarBakaya)}</b>\n` +
      `💎 Current Worth: <b>${formatInr(worth.totalCurrentWorth)}</b>`;
    return finalizeCommand(reply);
  }

  if (cmd === '/worth') {
    const w = computeCurrentWorthSnapshot(store);
    const reply =
      `💎 <b>Current Worth · ${formatInr(w.totalCurrentWorth)}</b>\n\n` +
      `🏦 Your Banks: <b>${formatInr(w.yourBankTotal)}</b>\n` +
      `👩‍❤️‍👨 Wife Account: <b>${formatInr(w.wifeTotal)}</b>\n` +
      `💵 Cash in Hand: <b>${formatInr(w.cashTotal)}</b>\n` +
      `📈 Investments: <b>${formatInr(w.investmentsTotal)}</b>\n` +
      `🤝 Net Udhaar: <b>${formatInr(w.netUdhaar)}</b> <i>(Lent ${formatInr(w.udhaarLent)} − Borrowed ${formatInr(w.udhaarBorrowed)})</i>\n` +
      `🧾 Pending Reimbursements: <b>${formatInr(w.rimPending)}</b>\n\n` +
      `💳 Card Outstanding: <b>${formatInr(w.cardOutstanding)}</b>\n` +
      `✨ Net After Card Dues: <b>${formatInr(w.netWorthAfterCards)}</b>`;
    return finalizeCommand(reply);
  }

  if (cmd === '/balance' || cmd === '/balances') {
    const bal = computeAccountBalances(store);
    const allAccs = Object.values(bal.accounts);
    const bankLines = allAccs
      .filter(a => a.type === 'bank_account' || a.type === 'cash')
      .map(a => `• ${escapeHtml(a.shortName)}: <b>${formatInr(a.currentBalance)}</b>`);
    const cardLines = allAccs
      .filter(a => a.type === 'credit_card' || a.type === 'rupay_card')
      .map(
        a =>
          `• ${escapeHtml(a.shortName)}: <b>${formatInr(a.currentOutstanding || 0)}</b> due · <i>${formatInr(
            a.availableLimit || 0
          )} avail</i>`
      );

    const reply =
      `🏦 <b>Banks, Wife &amp; Cash</b>\n` +
      `${bankLines.join('\n')}\n` +
      `<b>Total Liquid: ${formatInr(bal.totalBankCashBalance)}</b>\n\n` +
      `💳 <b>Credit Cards</b>\n` +
      `${cardLines.join('\n')}\n` +
      `<b>Total Card Due: ${formatInr(bal.totalCardOutstanding)}</b>`;
    return finalizeCommand(reply);
  }

  if (cmd === '/udhaar') {
    const lent = (store.udhaars || []).filter(u => u.type === 'lent' && u.status !== 'settled');
    const borrowed = (store.udhaars || []).filter(u => u.type === 'borrowed' && u.status !== 'settled');

    if (lent.length === 0 && borrowed.length === 0) {
      return finalizeCommand('✅ Zero pending Udhaar balances.');
    }

    const totalLent = lent.reduce((s, u) => s + Math.max(0, u.amount - (u.settledAmount || 0)), 0);
    const totalBorrowed = borrowed.reduce((s, u) => s + Math.max(0, u.amount - (u.settledAmount || 0)), 0);

    const parts: string[] = [`🤝 <b>Pending Udhaar Khata</b>`];
    if (lent.length > 0) {
      parts.push(`\n🟢 <b>To Receive (${formatInr(totalLent)}):</b>`);
      for (const u of lent.slice(0, 8)) {
        const rem = Math.max(0, u.amount - (u.settledAmount || 0));
        parts.push(
          `• ${escapeHtml(u.personName)}: <b>${formatInr(rem)}</b>${
            u.status === 'partial' ? ` <i>(of ${formatInr(u.amount)})</i>` : ''
          }`
        );
      }
    }
    if (borrowed.length > 0) {
      parts.push(`\n🔴 <b>To Pay (${formatInr(totalBorrowed)}):</b>`);
      for (const u of borrowed.slice(0, 8)) {
        const rem = Math.max(0, u.amount - (u.settledAmount || 0));
        parts.push(
          `• ${escapeHtml(u.personName)}: <b>${formatInr(rem)}</b>${
            u.status === 'partial' ? ` <i>(of ${formatInr(u.amount)})</i>` : ''
          }`
        );
      }
    }
    return finalizeCommand(parts.join('\n'));
  }

  if (cmd === '/rim' || cmd === '/reimbursements') {
    const pendingRims = (store.transactions || []).filter(
      t =>
        t.type === 'expense' &&
        (t.isReimbursement || t.category === 'Reimbursement') &&
        t.reimbursementStatus !== 'settled'
    );
    if (pendingRims.length === 0) {
      return finalizeCommand('✅ All reimbursement claims are settled!');
    }
    const totalRem = pendingRims.reduce(
      (s, t) => s + Math.max(0, Number(t.amount) - Number(t.reimbursementSettledAmount || 0)),
      0
    );
    const lines = pendingRims.slice(0, 10).map(t => {
      const rem = Math.max(0, Number(t.amount) - Number(t.reimbursementSettledAmount || 0));
      return `• ${escapeHtml(t.description)}: <b>${formatInr(rem)}</b>${
        t.reimbursementStatus === 'partial' ? ` <i>(partial of ${formatInr(t.amount)})</i>` : ''
      } · <i>${escapeHtml(t.account || 'AX Bank')}</i>`;
    });
    const reply = `🧾 <b>Pending Reimbursements (${formatInr(totalRem)})</b>\n${lines.join('\n')}`;
    return finalizeCommand(reply);
  }

  if (cmd === '/undo') {
    if (!store.transactions || store.transactions.length === 0) {
      return finalizeCommand('Nothing to undo — ledger is empty.', 'warning');
    }
    const removed = store.transactions.shift()!;
    if (removed.linkedUdhaarId || removed.id) {
      store.udhaars = (store.udhaars || []).filter(
        u => u.linkedTransactionId !== removed.id && u.id !== removed.linkedUdhaarId
      );
    }
    if (removed.source === 'telegram' || removed.source === 'simulator') {
      store.fuelLogs = recalculateFuelLogs(
        (store.fuelLogs || []).filter(f => !(f.date === removed.date && f.time === removed.time && f.fuelAmount === removed.amount))
      );
    }
    saveUserData(user.id, store);
    const reply =
      `↩️ <b>Undid Last Entry</b>\n` +
      `${removed.type === 'income' ? '🟢 +' : '🔴 -'}<b>${formatInr(removed.amount)}</b> · ${escapeHtml(removed.description)}\n` +
      `📂 ${escapeHtml(removed.category)} · 💳 ${escapeHtml(removed.account || 'AX Bank')}`;
    return finalizeCommand(reply);
  }

  if (cmd === '/ai' || isChatInAiAdvisorMode(chatId)) {
    const question = trimmed.replace(/^\/ai(?:@\S+)?\s*/i, '').trim();
    if (!question) {
      setChatAiAdvisorMode(chatId, true);
      return finalizeCommand('🤖 AI Advisor mode enabled. Send your financial question (or send <code>/done</code> to exit).');
    }
    if (question.toLowerCase() === '/done' || question.toLowerCase() === 'exit') {
      setChatAiAdvisorMode(chatId, false);
      return finalizeCommand('Exited AI Advisor mode. Back to quick expense logging.');
    }
    try {
      const summary = computeFinancialSummary(store);
      const res = await askFinancialAdvisor(question, store, summary);
      return finalizeCommand(`🤖 <b>Advisor</b>\n${escapeHtml(res.answer)}`);
    } catch (err: any) {
      return finalizeCommand(
        `❌ AI Advisor unavailable: ${escapeHtml(err?.message || 'Check GEMINI_API_KEY configuration.')}`,
        'error'
      );
    }
  }

  // Parse transactions: try Gemini if configured, fall back cleanly to deterministic parser
  let parsed: any[] = [];
  if (isGeminiConfigured()) {
    try {
      const accounts = Object.keys(computeAccountBalances(store).accounts);
      const aiEntries = await parseMessageWithGemini(trimmed, store.categories, accounts);
      if (aiEntries.length > 0) {
        parsed = aiEntries.map(e => {
          const acc = e.account || 'AX Bank';
          const resolvedPm =
            acc === 'Wife'
              ? 'Wife'
              : acc === 'Cash'
              ? 'Cash'
              : e.paymentMethod || (acc.includes('CC') || acc === 'IC Bank 2005' ? 'Card' : 'UPI');
          return {
            ...e,
            account: acc,
            paymentMethod: resolvedPm,
            isWifeTransfer: Boolean(e.isWifeTransfer || (e.isSavingsTransfer && e.category === 'Wife Transfer')),
          };
        });
      }
    } catch {
      // Fallback seamlessly to deterministic parser if Gemini fails/rate-limits
    }
  }

  if (parsed.length === 0) {
    parsed = parseMessageDeterministic(trimmed, store);
  }

  if (parsed.length === 0) {
    const reply =
      `⚠️ <b>Could not detect an amount.</b>\n` +
      `Try formats like:\n` +
      `• <code>150 coffee cash</code>\n` +
      `• <code>250 snacks wife</code>\n` +
      `• <code>rim 900 cab sbi 5733</code>\n` +
      `Or tap <code>/help</code> for all commands.`;
    return finalizeCommand(reply, 'warning');
  }

  const ist = getIstDateTime();
  const createdTxs: Transaction[] = [];
  const fuelCreatedIds = new Set<string>();

  for (const item of parsed) {
    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tx: Transaction = {
      id: txId,
      userId: user.id,
      type: item.type,
      amount: Number(item.amount),
      category: item.category,
      description: item.description,
      date: ist.date,
      time: ist.time,
      paymentMethod: item.paymentMethod,
      account: item.account,
      source,
      telegramChatId: chatId,
      telegramMessageId: messageId,
      telegramUser: senderName,
      rawMessage: trimmed,
      createdAt: new Date().toISOString(),
      isReimbursement: item.isReimbursement,
      reimbursementStatus: item.isReimbursement ? 'pending' : undefined,
      isSavingsTransfer: item.isSavingsTransfer,
      isWifeTransfer: item.isWifeTransfer,
      isCcPayment: item.isCcPayment,
      isInvestment: item.isInvestment,
      isUdhaarLent: item.isUdhaarLent,
      isUdhaarRecovery: item.isUdhaarRecovery,
      udhaarPersonName: item.udhaarPersonName,
    };

    store.transactions.unshift(tx);
    createdTxs.push(tx);

    // Side effect: Udhaar record creation
    if (item.isUdhaarLent && item.udhaarPersonName) {
      store.udhaars.unshift({
        id: `udh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: user.id,
        type: 'lent',
        personName: item.udhaarPersonName,
        amount: tx.amount,
        settledAmount: 0,
        description: tx.description,
        date: tx.date,
        time: tx.time,
        status: 'pending',
        account: tx.account,
        linkedTransactionId: txId,
        createdAt: tx.createdAt,
      });
    }

    // Side effect: Fuel log creation if odometer detected
    if (item.fuelOdometer && item.fuelOdometer > 0) {
      fuelCreatedIds.add(txId);
      const nextFuel = recalculateFuelLogs([
        {
          id: `fuel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userId: user.id,
          date: tx.date,
          time: tx.time,
          vehicleName: item.vehicleName || 'Primary Vehicle',
          fuelAmount: tx.amount,
          fuelLiters: item.fuelLiters,
          odometer: item.fuelOdometer,
          notes: tx.description,
          createdAt: tx.createdAt,
        },
        ...store.fuelLogs,
      ]);
      store.fuelLogs = nextFuel;
    }
  }

  saveUserData(user.id, store);

  const summary = computeFinancialSummary(store, ist.month);
  const bal = computeAccountBalances(store);
  const categories = store.categories || [];

  const blocks = createdTxs.map(t => {
    const signPrefix = t.type === 'income' ? '🟢 +' : '🔴 -';
    const tags = buildEntryTags(t, fuelCreatedIds.has(t.id));
    if (t.type === 'expense' && isNonPersonalExpense(t, categories) && !tags.some(g => g.includes('Excluded'))) {
      tags.push('⊘ Excluded from Personal Spend');
    }
    const accName = t.account || 'AX Bank';
    const accInfo = bal.accounts[accName];
    const accSnippet = accInfo
      ? accInfo.type === 'credit_card' || accInfo.type === 'rupay_card'
        ? `Due: ${formatInr(accInfo.currentOutstanding || 0)}`
        : `Bal: ${formatInr(accInfo.currentBalance || 0)}`
      : '';

    return (
      `${signPrefix}<b>${formatInr(t.amount)}</b> · <b>${escapeHtml(t.category)}</b>\n` +
      `📝 ${escapeHtml(t.description)}\n` +
      `💳 ${escapeHtml(accName)} (${escapeHtml(t.paymentMethod || 'UPI')})${accSnippet ? ` · <i>${accSnippet}</i>` : ''}` +
      (tags.length > 0 ? `\n${tags.join(' · ')}` : '')
    );
  });

  const footer =
    `\n\n📊 Month Personal: <b>${formatInr(summary.currentMonthPersonalExpense)}</b>` +
    ` · Income: <b>${formatInr(summary.currentMonthIncome)}</b>`;

  const reply =
    `✅ <b>Logged ${createdTxs.length} Entr${createdTxs.length === 1 ? 'y' : 'ies'}</b> · <i>${ist.time} IST</i>\n\n` +
    `${blocks.join('\n\n')}${footer}`;

  addTelegramLog({
    userId: user.id,
    type: 'incoming_message',
    chatId,
    user: senderName,
    rawText: trimmed,
    parsedTransactions: createdTxs.map(t => ({
      type: t.type,
      amount: t.amount,
      category: t.category,
      description: t.description,
    })),
    botReply: reply,
    status: 'success',
  });

  if (source === 'telegram') await sendTelegramMessage(chatId, reply);
  return { reply, transactions: createdTxs, status: 'success' };
}

function getActiveAccountForChat(chatId: string, linked: UserProfile[]): UserProfile | null {
  if (linked.length === 0) return null;
  const activeMap = getActiveAccountsMap();
  const activeId = activeMap[chatId];
  if (activeId) {
    const found = linked.find(u => u.id === activeId);
    if (found) return found;
  }
  return linked[0];
}

export async function refreshTelegramBotInfo(): Promise<void> {
  const token = getActiveBotToken();
  if (!token) return;
  try {
    const me = await callTelegramApi(token, 'getMe');
    const wh = await callTelegramApi(token, 'getWebhookInfo');
    const cfg = getBotConfig();
    saveBotConfig({
      ...cfg,
      botToken: token,
      isConnected: Boolean(me.ok),
      botUsername: me.result?.username || cfg.botUsername,
      botName: me.result?.first_name || cfg.botName,
      isWebhookSet: Boolean(wh.result?.url),
      webhookUrl: wh.result?.url || cfg.webhookUrl,
      pendingUpdateCount: wh.result?.pending_update_count || 0,
      lastWebhookCheck: new Date().toISOString(),
      lastError: wh.result?.last_error_message || undefined,
    });
  } catch (err: any) {
    const cfg = getBotConfig();
    saveBotConfig({
      ...cfg,
      lastError: err?.message || 'Unable to verify bot status',
    });
  }
}
