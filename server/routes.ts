import express, { Router } from 'express';
import * as XLSX from 'xlsx';
import {
  AuthedRequest,
  hashPassword,
  issueToken,
  migrateLegacyPasswordIfNeeded,
  resolveUserContext,
  toSafeUser,
  verifyPassword,
} from './auth.js';
import { DEFAULT_BUDGETS, DEFAULT_CATEGORIES, getIstDateTime } from './defaults.js';
import {
  askFinancialAdvisor,
  generateFinancialInsights,
  isGeminiConfigured,
  parseMessageWithGemini,
} from './geminiService.js';
import { calculateInvestmentMetrics } from './investmentCalculator.js';
import {
  computeAccountBalances,
  computeDailyLimits,
  computeFinancialSummary,
  computeGullakSummary,
  computePiggyBankSummary,
  detectAccountFromText,
  getMergedAccounts,
  matchCategory,
  parseMessageDeterministic,
  processInvestmentAutoDebits,
  recalculateFuelLogs,
} from './ledgerEngine.js';
import {
  clearTelegramLogs,
  deleteUserStore,
  generateLinkCode,
  getActiveBotToken,
  getBotConfig,
  getEnvBotToken,
  getStorageStatus,
  getTelegramLogs,
  getUserById,
  getUserData,
  getUsers,
  saveBotConfig,
  saveUserData,
  saveUsers,
  syncAllToPg,
  syncBudgetsWithCategories,
} from './storage.js';
import {
  callTelegramApi,
  processIncomingTelegramText,
  refreshTelegramBotInfo,
  sendTelegramMessage,
  syncBotCommands,
} from './telegram.js';
import {
  CategoryBudget,
  CategoryDef,
  DailyItemLimit,
  InvestmentRecord,
  PiggyBankItem,
  Transaction,
  UdhaarRecord,
  UserDataStore,
} from './types.js';

export function createApiRouter(): Router {
  const router = Router();

  // ---------------- Public Auth & User Discovery ----------------
  router.get(['/users/me', '/auth/me'], (req: AuthedRequest, res) => {
    const allUsers = getUsers();
    const headerUid = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const active = (headerUid ? getUserById(headerUid) : undefined) || allUsers[0] || null;
    res.json({
      user: active ? toSafeUser(active) : null,
      users: allUsers.map(toSafeUser),
    });
  });

  router.get(['/users', '/auth/users'], (_req, res) => {
    res.json({ users: getUsers().map(toSafeUser) });
  });

  router.post('/auth/register', (req, res) => {
    const { name, email, password } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanName || !cleanEmail) {
      res.status(400).json({ error: 'Name and email are required.' });
      return;
    }

    const all = getUsers();
    if (all.some(u => u.email.toLowerCase() === cleanEmail)) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newUser = {
      id,
      name: cleanName,
      email: cleanEmail,
      passwordHash: password ? hashPassword(String(password)) : undefined,
      linkedMembers: [],
      pendingRequests: [],
      linkCode: generateLinkCode(),
      createdAt: new Date().toISOString(),
      trackingStartMonth: getIstDateTime().month,
    };

    all.push(newUser);
    saveUsers(all);
    getUserData(id); // Initialize store

    const token = issueToken({ userId: id, role: 'owner' });
    res.status(201).json({ success: true, user: toSafeUser(newUser), token });
  });

  router.post('/auth/login', (req, res) => {
    const { userId, email, password } = req.body || {};
    const all = getUsers();
    const target = userId
      ? all.find(u => u.id === String(userId))
      : all.find(u => u.email.toLowerCase() === String(email || '').trim().toLowerCase());

    if (!target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    if (target.passwordHash || target.password) {
      const ok = verifyPassword(String(password || ''), target.passwordHash, target.password);
      if (!ok) {
        res.status(401).json({ error: 'Incorrect password.' });
        return;
      }
      migrateLegacyPasswordIfNeeded(target, String(password || ''));
    }

    const token = issueToken({ userId: target.id, role: 'owner' });
    res.json({ success: true, user: toSafeUser(target), token, role: 'owner', isOwner: true });
  });

  router.post('/auth/family-login', (req, res) => {
    const { userId, memberName, linkCode } = req.body || {};
    const all = getUsers();
    const target = userId ? all.find(u => u.id === String(userId)) : all[0];
    if (!target) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    if (linkCode && String(linkCode).trim() !== target.linkCode) {
      res.status(401).json({ error: 'Invalid family workspace code.' });
      return;
    }
    const cleanMember = String(memberName || 'Family').trim();
    const token = issueToken({ userId: target.id, role: 'family', memberName: cleanMember });
    res.json({
      success: true,
      user: toSafeUser(target),
      token,
      role: 'family',
      isOwner: false,
      memberName: cleanMember,
    });
  });

  // ---------------- Telegram Webhook (Public endpoint for Telegram servers) ----------------
  router.post('/telegram/webhook', async (req, res) => {
    res.status(200).json({ ok: true });
    try {
      const update = req.body;
      const msg = update?.message || update?.edited_message;
      if (!msg?.text || !msg?.chat?.id) return;

      const chatId = String(msg.chat.id);
      const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram User';
      await processIncomingTelegramText({
        text: msg.text,
        chatId,
        senderName,
        username: msg.from?.username,
        messageId: msg.message_id,
        source: 'telegram',
      });
    } catch (err) {
      console.error('[Telegram Webhook] Processing error:', err);
    }
  });

  // ---------------- Protected Routes ----------------
  router.use(resolveUserContext);

  router.post('/auth/change-password', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) {
      res.status(400).json({ error: 'New password must be at least 4 characters.' });
      return;
    }
    if (user.passwordHash || user.password) {
      if (!verifyPassword(String(currentPassword || ''), user.passwordHash, user.password)) {
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
    }
    user.passwordHash = hashPassword(String(newPassword));
    delete user.password;
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    const token = issueToken({ userId: user.id, role: 'owner' });
    res.json({ success: true, user: toSafeUser(user), token });
  });

  router.post('/auth/regenerate-linkcode', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    user.linkCode = generateLinkCode();
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    res.json({ success: true, user: toSafeUser(user) });
  });

  router.post(['/auth/delete-account', '/users/delete'], (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const all = getUsers();
    if (all.length <= 1) {
      res.status(400).json({ error: 'Cannot delete the sole workspace profile.' });
      return;
    }
    const next = all.filter(u => u.id !== user.id);
    saveUsers(next);
    deleteUserStore(user.id);
    res.json({ success: true, nextUser: toSafeUser(next[0]) });
  });

  router.get('/auth/members', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    res.json({
      linkedMembers: user.linkedMembers || [],
      pendingRequests: user.pendingRequests || [],
      linkCode: user.linkCode,
    });
  });

  router.post('/auth/members/alias', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const { memberId, customAlias } = req.body || {};
    user.linkedMembers = (user.linkedMembers || []).map(m =>
      m.id === memberId ? { ...m, customAlias: String(customAlias || '').trim() } : m
    );
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    res.json({ success: true, user: toSafeUser(user) });
  });

  router.delete('/auth/members/:memberId', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    user.linkedMembers = (user.linkedMembers || []).filter(m => m.id !== req.params.memberId);
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    res.json({ success: true, user: toSafeUser(user) });
  });

  router.get(['/members/pending-requests', '/auth/members/pending-requests'], (req: AuthedRequest, res) => {
    res.json({ pendingRequests: req.activeUser!.pendingRequests || [] });
  });

  router.post(['/members/approve-request', '/auth/members/approve-request'], (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const { requestId, customAlias, role } = req.body || {};
    const reqObj = (user.pendingRequests || []).find(r => r.id === requestId);
    if (!reqObj) {
      res.status(404).json({ error: 'Pending request not found.' });
      return;
    }
    user.pendingRequests = (user.pendingRequests || []).filter(r => r.id !== requestId);
    user.linkedMembers = user.linkedMembers || [];
    if (!user.linkedMembers.some(m => m.telegramChatId === reqObj.chatId)) {
      user.linkedMembers.push({
        id: `mem_${reqObj.chatId}`,
        name: reqObj.name,
        customAlias: customAlias ? String(customAlias).trim() : undefined,
        role: role || 'family',
        telegramChatId: reqObj.chatId,
        telegramUsername: reqObj.telegramUsername,
        linkedAt: new Date().toISOString(),
      });
    }
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    sendTelegramMessage(
      reqObj.chatId,
      `✅ <b>Approved!</b> You are now connected to <b>${user.name}</b>'s TeleExpense ledger.\nSend <code>150 chai cash</code> or <code>/help</code> to start.`
    ).catch(() => {});
    res.json({ success: true, user: toSafeUser(user) });
  });

  router.post(['/members/reject-request', '/auth/members/reject-request'], (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const { requestId } = req.body || {};
    user.pendingRequests = (user.pendingRequests || []).filter(r => r.id !== requestId);
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    res.json({ success: true, user: toSafeUser(user) });
  });

  router.post(['/gullak/start-month', '/users/tracking-start-month'], (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const { trackingStartMonth } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(trackingStartMonth || ''))) {
      res.status(400).json({ error: 'Invalid YYYY-MM format.' });
      return;
    }
    user.trackingStartMonth = String(trackingStartMonth);
    saveUsers(getUsers().map(u => (u.id === user.id ? user : u)));
    res.json({ success: true, user: toSafeUser(user) });
  });

  // ---------------- Sync Version ----------------
  router.get('/sync/version', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({
      v: store.dataVersion || 1,
      txCount: store.transactions.length,
      udhaarCount: store.udhaars.length,
      fuelCount: store.fuelLogs.length,
    });
  });

  // ---------------- Transactions ----------------
  router.get('/transactions', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    res.json({
      transactions: store.transactions,
      summary: computeFinancialSummary(store, month),
      customAccounts: store.customAccounts || [],
    });
  });

  router.post('/transactions/quick-parse', async (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const rawText = String(req.body?.text || '').trim();
    if (!rawText) {
      res.status(400).json({ error: 'Please enter a message to parse.' });
      return;
    }

    let parsed = [];
    let usedGemini = false;
    if (isGeminiConfigured()) {
      try {
        const accounts = Object.keys(computeAccountBalances(store).accounts);
        const aiRes = await parseMessageWithGemini(rawText, store.categories, accounts);
        if (aiRes.length > 0) {
          usedGemini = true;
          parsed = aiRes.map(e => ({
            ...e,
            account: e.account || 'AX Bank',
            paymentMethod: e.paymentMethod || 'UPI',
          }));
        }
      } catch {
        // Fallback to deterministic parser
      }
    }
    if (parsed.length === 0) {
      parsed = parseMessageDeterministic(rawText, store);
    }
    if (parsed.length === 0) {
      res.status(400).json({ error: 'Could not detect an amount. Example: "250 coffee cash"' });
      return;
    }

    const ist = getIstDateTime();
    const created: Transaction[] = [];
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
        source: 'manual',
        rawMessage: rawText,
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
      created.push(tx);

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

      if (item.fuelOdometer && item.fuelOdometer > 0) {
        store.fuelLogs = recalculateFuelLogs([
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
      }
    }

    saveUserData(user.id, store);
    res.status(201).json({
      success: true,
      usedGemini,
      created,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  router.post('/transactions', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'Amount must be greater than zero.' });
      return;
    }

    const ist = getIstDateTime();
    const tx: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId: user.id,
      type: body.type === 'income' ? 'income' : 'expense',
      amount,
      category: String(body.category || (body.type === 'income' ? 'Other Income' : 'Other Expense')),
      description: String(body.description || 'Manual entry').trim(),
      date: String(body.date || ist.date),
      time: String(body.time || ist.time),
      paymentMethod: body.paymentMethod || (body.account === 'Wife' ? 'Wife' : 'UPI'),
      account: body.account || (body.paymentMethod === 'Wife' ? 'Wife' : 'AX Bank'),
      source: body.source || 'manual',
      telegramUser: body.telegramUser || req.authMemberName,
      createdAt: new Date().toISOString(),
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      isReimbursement: Boolean(body.isReimbursement || body.category === 'Reimbursement'),
      reimbursementStatus:
        body.isReimbursement || body.category === 'Reimbursement' ? 'pending' : undefined,
      isSavingsTransfer: Boolean(body.isSavingsTransfer || body.category === 'Wife Transfer'),
      isWifeTransfer: Boolean(body.isWifeTransfer || body.category === 'Wife Transfer'),
      isCcPayment: Boolean(body.isCcPayment || body.category === 'CC Payment'),
      isInvestment: Boolean(body.isInvestment || body.category === 'Investments & Savings'),
      isUdhaarLent: Boolean(body.isUdhaarLent || body.category === 'Udhaar Given'),
      udhaarPersonName: body.udhaarPersonName ? String(body.udhaarPersonName) : undefined,
    };

    store.transactions.unshift(tx);
    saveUserData(user.id, store);
    res.status(201).json({
      transaction: tx,
      summary: computeFinancialSummary(store),
    });
  });

  router.put('/transactions/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const idx = store.transactions.findIndex(t => t.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    const existing = store.transactions[idx];
    const patch = req.body || {};
    const updated: Transaction = {
      ...existing,
      ...patch,
      id: existing.id,
      userId: existing.userId,
      amount: patch.amount !== undefined ? Number(patch.amount) : existing.amount,
    };
    store.transactions[idx] = updated;
    saveUserData(user.id, store);
    res.json({
      success: true,
      transaction: updated,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  router.delete('/transactions/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.transactions = store.transactions.filter(t => t.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({
      success: true,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  router.delete('/transactions', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.transactions = [];
    saveUserData(user.id, store);
    res.json({ success: true, summary: computeFinancialSummary(store) });
  });

  router.post('/transactions/bulk-delete', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const rawIds = req.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      res.status(400).json({ error: 'Provide at least one transaction ID to delete.' });
      return;
    }

    const idSet = new Set(
      rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    );
    if (idSet.size === 0) {
      res.status(400).json({ error: 'No valid transaction IDs provided.' });
      return;
    }

    const beforeCount = store.transactions.length;
    store.transactions = store.transactions.filter(t => !idSet.has(t.id));
    const deletedCount = beforeCount - store.transactions.length;

    saveUserData(user.id, store);
    res.json({
      success: true,
      deletedCount,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- Bulk Import & CSV Export (Date,Time,Month,Type,Amount (INR),Category,Description,Payment Method,Account / Card,Source,Raw Message,Telegram User,Tags,Reimbursement Status,Transaction ID) ----------------
  router.post('/transactions/bulk-import', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const {
      rows,
      defaultAccount = 'AX Bank',
      skipDuplicates = true,
      autoCreateCategories = true,
      autoCreateAccounts = true,
      syncUdhaar = false,
    } = req.body || {};

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'Provide at least one transaction row to import.' });
      return;
    }

    const ist = getIstDateTime();
    const mergedAccounts = getMergedAccounts(store);

    const normalizeImportDate = (raw: unknown): string => {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const parsed = XLSX.SSF.parse_date_code(raw);
        if (parsed?.y && parsed?.m && parsed?.d) {
          return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
        }
      }
      const str = String(raw || '').trim();
      if (!str) return ist.date;
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
      const ymdSlash = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (ymdSlash) {
        const [, y, m, d] = ymdSlash;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
      if (dmy) {
        const [, d, m, y] = dmy;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      const parsedDate = new Date(str);
      if (!Number.isNaN(parsedDate.getTime())) {
        return `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
      }
      return ist.date;
    };

    const normalizePaymentMethod = (raw: unknown): Transaction['paymentMethod'] => {
      const val = String(raw || '').trim().toLowerCase();
      if (val === 'wife' || val === 'wife bank' || val === 'wife account') return 'Wife';
      if (val === 'cash') return 'Cash';
      if (val === 'card') return 'Card';
      if (val === 'bank transfer') return 'Bank Transfer';
      if (val === 'net banking') return 'Net Banking';
      if (val === 'upi/cash') return 'UPI/Cash';
      if (val === 'other') return 'Other';
      return 'UPI';
    };

    const normalizeSource = (raw: unknown): Transaction['source'] => {
      const val = String(raw || '').trim().toLowerCase();
      if (val === 'telegram') return 'telegram';
      if (val === 'manual') return 'manual';
      if (val === 'simulator') return 'simulator';
      if (val === 'wealth') return 'wealth';
      return 'import';
    };

    const parseTags = (raw: unknown): string[] | undefined => {
      if (Array.isArray(raw)) {
        const list = raw.map(v => String(v).trim()).filter(Boolean);
        return list.length > 0 ? list : undefined;
      }
      const s = String(raw || '').trim();
      if (!s) return undefined;
      const list = s.split(',').map(part => part.trim()).filter(Boolean);
      return list.length > 0 ? list : undefined;
    };

    const existingIds = new Set(store.transactions.map(t => t.id));
    const existingSignatures = new Set(
      store.transactions.map(
        t => `${t.date}|${t.type}|${Number(t.amount).toFixed(2)}|${(t.description || '').trim().toLowerCase()}`
      )
    );

    const palette = ['#38BDF8', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#F97316', '#14B8A6', '#06B6D4'];
    let importedCount = 0;
    let skippedCount = 0;
    let categoriesCreated = 0;
    let accountsCreated = 0;
    const createdTransactions: Transaction[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        skippedCount++;
        continue;
      }

      const rawAmount = row.amount ?? row['Amount (INR)'] ?? row['Amount'] ?? row['amount (inr)'];
      const cleanedAmount = Number(String(rawAmount ?? '').replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(cleanedAmount) || cleanedAmount <= 0) {
        skippedCount++;
        continue;
      }

      const rawType = String(row.type ?? row.Type ?? 'EXPENSE').trim().toLowerCase();
      const txType: 'income' | 'expense' = rawType === 'income' ? 'income' : 'expense';

      const dateStr = normalizeImportDate(row.date ?? row.Date);
      const rawTime = String(row.time ?? row.Time ?? '').trim();
      const txTime = rawTime || ist.time;
      const rawCat = String(row.category ?? row.Category ?? (txType === 'income' ? 'Other Income' : 'Other Expense')).trim();
      const description = String(row.description ?? row.Description ?? rawCat).trim() || rawCat;
      const paymentMethod = normalizePaymentMethod(row.paymentMethod ?? row['Payment Method']);
      const source = normalizeSource(row.source ?? row.Source);
      const rawMessage = String(row.rawMessage ?? row['Raw Message'] ?? '').trim();
      const telegramUser = String(row.telegramUser ?? row['Telegram User'] ?? '').trim() || undefined;
      const tags = parseTags(row.tags ?? row.Tags);
      const incomingId = String(row.transactionId ?? row['Transaction ID'] ?? row.id ?? '').trim();
      const rawReimbStatus = String(row.reimbursementStatus ?? row['Reimbursement Status'] ?? '').trim().toLowerCase();

      const sig = `${dateStr}|${txType}|${cleanedAmount.toFixed(2)}|${description.toLowerCase()}`;
      if (skipDuplicates && ((incomingId && existingIds.has(incomingId)) || existingSignatures.has(sig))) {
        skippedCount++;
        continue;
      }

      // Match or auto-create category
      let matchedCat = store.categories.find(
        c => c.name.toLowerCase() === rawCat.toLowerCase() && (c.type === txType || c.type === 'both')
      );
      if (!matchedCat) {
        matchedCat = store.categories.find(c => c.name.toLowerCase() === rawCat.toLowerCase());
        if (matchedCat && matchedCat.type !== txType && matchedCat.type !== 'both') {
          matchedCat.type = 'both';
        }
      }

      if (!matchedCat && autoCreateCategories && rawCat) {
        const lowerCat = rawCat.toLowerCase();
        const excludeFromBudget =
          lowerCat === 'cc payment' ||
          lowerCat === 'wife transfer' ||
          lowerCat === 'udhaar given' ||
          lowerCat === 'reimbursement' ||
          lowerCat === 'udhaar recovery' ||
          lowerCat === 'udhaar received';

        matchedCat = {
          id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: rawCat,
          type: txType,
          icon: 'Tag',
          color: palette[(store.categories.length + categoriesCreated) % palette.length],
          keywords: [lowerCat],
          isCustom: true,
          excludeFromBudget,
        };
        store.categories.push(matchedCat);
        categoriesCreated++;
      }

      const categoryName = matchedCat ? matchedCat.name : rawCat;
      const lowerCat = categoryName.toLowerCase();

      const hasValidReimbStatus =
        rawReimbStatus === 'pending' || rawReimbStatus === 'settled' || rawReimbStatus === 'partial';
      const isReimbursement =
        (txType === 'expense' && lowerCat === 'reimbursement') || (txType === 'expense' && hasValidReimbStatus);
      const isReimbursementInflow = txType === 'income' && lowerCat === 'reimbursement';
      const isCcPayment = lowerCat === 'cc payment';
      const isWifeTransfer = lowerCat === 'wife transfer';
      const isUdhaarLent = txType === 'expense' && lowerCat === 'udhaar given';
      const isUdhaarRecovery = txType === 'income' && (lowerCat === 'udhaar recovery' || lowerCat === 'udhaar received');
      const isInvestment =
        lowerCat === 'rd' ||
        lowerCat === 'fd' ||
        lowerCat === 'insurance' ||
        lowerCat === 'investments & savings';

      // Resolve explicit Account / Card column first, then infer
      const explicitAccount =
        row.account ?? row['Account / Card'] ?? row.Account ?? row['Source Bank'] ?? row.sourceBank;
      let account = explicitAccount ? String(explicitAccount).trim() : '';
      if (!account) {
        const detected = detectAccountFromText(`${rawMessage} ${description}`, store);
        if (detected) {
          account = detected;
        } else if (paymentMethod === 'Wife') {
          account = 'Wife';
        } else if (paymentMethod === 'Cash') {
          account = 'Cash';
        } else if (paymentMethod === 'Card') {
          account = 'ICICI CC 0000';
        } else {
          account = String(defaultAccount || 'AX Bank');
        }
      }

      // Match existing account case-insensitively or auto-create custom account (e.g. "Axis 2904")
      const existingAccKey = Object.keys(mergedAccounts).find(
        k => k.toLowerCase() === account.toLowerCase()
      );
      if (existingAccKey) {
        account = existingAccKey;
      } else if (autoCreateAccounts && account) {
        const lowerAcc = account.toLowerCase();
        const isLikelyCard =
          /\b\d{4}\b/.test(account) ||
          lowerAcc.includes('cc') ||
          lowerAcc.includes('card') ||
          paymentMethod === 'Card' ||
          description.toLowerCase().includes('on card') ||
          description.toLowerCase().includes('card)');
        const newAcc: UserDataStore['customAccounts'][number] = {
          id: account,
          name: account,
          shortName: account,
          type: lowerAcc === 'cash' ? 'cash' : isLikelyCard ? 'credit_card' : 'bank_account',
          badge: isLikelyCard ? 'Custom CC' : 'Custom Bank',
          color: palette[(Object.keys(mergedAccounts).length + accountsCreated) % palette.length],
          creditLimit: isLikelyCard ? 100000 : undefined,
          isCustom: true,
        };
        store.customAccounts.push(newAcc);
        mergedAccounts[account] = newAcc;
        accountsCreated++;
      }

      // Extract Udhaar person name if applicable
      let udhaarPersonName: string | undefined;
      if (isUdhaarLent || isUdhaarRecovery) {
        const m = description.match(/(?:udhaar diya|udhaar wapas mila)\s*:\s*([^(\n]+?)(?:\(|$)/i);
        if (m) udhaarPersonName = m[1].trim();
      }

      const txId =
        incomingId && !existingIds.has(incomingId)
          ? incomingId
          : `tx_bulk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const tx: Transaction = {
        id: txId,
        userId: user.id,
        type: txType,
        amount: cleanedAmount,
        category: categoryName,
        description,
        date: dateStr,
        time: txTime,
        paymentMethod,
        account,
        source,
        telegramUser,
        rawMessage: rawMessage || undefined,
        tags,
        createdAt: new Date().toISOString(),
        isReimbursement,
        isReimbursementInflow,
        reimbursementStatus: isReimbursement
          ? hasValidReimbStatus
            ? (rawReimbStatus as 'pending' | 'settled' | 'partial')
            : 'pending'
          : undefined,
        isCcPayment,
        isWifeTransfer,
        isSavingsTransfer: isWifeTransfer,
        isUdhaarLent,
        isUdhaarRecovery,
        isInvestment,
        udhaarPersonName,
      };

      store.transactions.push(tx);
      createdTransactions.push(tx);
      existingIds.add(txId);
      existingSignatures.add(sig);
      importedCount++;

      if (syncUdhaar && isUdhaarLent) {
        store.udhaars.unshift({
          id: `udh_bulk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userId: user.id,
          type: 'lent',
          personName: udhaarPersonName || description,
          amount: cleanedAmount,
          settledAmount: 0,
          description,
          date: dateStr,
          time: txTime,
          status: 'pending',
          account,
          linkedTransactionId: txId,
          createdAt: tx.createdAt,
        });
      }
    }

    if (categoriesCreated > 0) {
      syncBudgetsWithCategories(store);
    }
    store.transactions.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    saveUserData(user.id, store);

    res.status(201).json({
      success: true,
      importedCount,
      skippedCount,
      categoriesCreated,
      accountsCreated,
      transactions: store.transactions,
      categories: store.categories,
      budgets: store.budgets,
      customAccounts: store.customAccounts,
      summary: computeFinancialSummary(store),
    });
  });

  router.get('/transactions/export-csv', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    const escapeCsv = (val: unknown): string => {
      const s = String(val ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const getMonthShort = (iso: string): string => {
      const m = (iso || '').match(/^\d{4}-(\d{2})-\d{2}$/);
      if (!m) return '';
      const idx = Number(m[1]) - 1;
      return monthNames[idx] || '';
    };

    const header =
      'Date,Time,Month,Type,Amount (INR),Category,Description,Payment Method,Account / Card,Source,Raw Message,Telegram User,Tags,Reimbursement Status,Reimbursement Settled (INR),Settled In Account,Settled Date,Transaction ID';
    const lines = store.transactions.map(t =>
      [
        t.date,
        t.time || '',
        getMonthShort(t.date),
        t.type.toUpperCase(),
        t.amount,
        t.category,
        t.description,
        t.paymentMethod || 'UPI',
        t.account || 'AX Bank',
        t.source || 'manual',
        t.rawMessage || '',
        t.telegramUser || '',
        Array.isArray(t.tags) ? t.tags.join(', ') : '',
        t.reimbursementStatus || '',
        t.isReimbursement ? Number(t.reimbursementSettledAmount || 0) : '',
        t.settledInAccount || '',
        t.settledDate || '',
        t.id,
      ]
        .map(escapeCsv)
        .join(',')
    );

    const csv = [header, ...lines].join('\r\n');
    res.setHeader('Content-Disposition', `attachment; filename="teleexpense_${req.activeUser!.name}_${getIstDateTime().date}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  });

  router.post('/transactions/:id/settle-reimbursement', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const tx = store.transactions.find(t => t.id === req.params.id);
    if (!tx) {
      res.status(404).json({ error: 'Reimbursement transaction not found.' });
      return;
    }

    const ist = getIstDateTime();
    const account = String(req.body?.account || 'AX Bank');
    const alreadySettled = Number(tx.reimbursementSettledAmount || 0);
    const remaining = Math.max(0, Number(tx.amount) - alreadySettled);
    if (remaining <= 0) {
      res.status(400).json({ error: 'Reimbursement is already fully settled.' });
      return;
    }

    const hasExplicitAmount = req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== '';
    const requestedAmount = hasExplicitAmount ? Number(req.body.amount) : remaining;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      res.status(400).json({ error: 'Enter a valid settlement amount greater than ₹0.' });
      return;
    }
    const settleAmount = Math.min(remaining, Math.round(requestedAmount * 100) / 100);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    tx.reimbursementSettledAmount = Math.round((alreadySettled + settleAmount) * 100) / 100;
    tx.reimbursementStatus = tx.reimbursementSettledAmount >= tx.amount - 0.01 ? 'settled' : 'partial';
    if (tx.reimbursementStatus === 'settled') tx.reimbursementSettledAmount = tx.amount;
    tx.settledInAccount = account;
    tx.settledDate = String(req.body?.date || ist.date);

    const paymentMethod =
      account === 'Cash'
        ? 'Cash'
        : account === 'Wife'
        ? 'Wife'
        : account.includes('CC') || account === 'IC Bank 2005'
        ? 'Card'
        : 'Bank Transfer';

    // Record inflow in selected account
    const inflowTx: Transaction = {
      id: `tx_rim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: user.id,
      type: 'income',
      amount: settleAmount,
      category: 'Reimbursement',
      description: `Claim Settled${tx.reimbursementStatus === 'partial' ? ' (Partial)' : ''}: ${tx.description}${note ? ` · ${note}` : ''}`,
      date: tx.settledDate,
      time: ist.time,
      paymentMethod,
      account,
      source: 'manual',
      createdAt: new Date().toISOString(),
      isReimbursementInflow: true,
      linkedTransferId: tx.id,
    };
    store.transactions.unshift(inflowTx);
    saveUserData(user.id, store);

    res.json({
      success: true,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  router.post('/transactions/settle-all-reimbursements', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const account = String(req.body?.account || 'AX Bank');
    const ist = getIstDateTime();
    let totalSettled = 0;

    for (const tx of store.transactions) {
      if (tx.type === 'expense' && tx.isReimbursement && tx.reimbursementStatus !== 'settled') {
        const rem = Math.max(0, Number(tx.amount) - Number(tx.reimbursementSettledAmount || 0));
        if (rem > 0) {
          totalSettled += rem;
          tx.reimbursementSettledAmount = tx.amount;
          tx.reimbursementStatus = 'settled';
          tx.settledInAccount = account;
          tx.settledDate = ist.date;
        }
      }
    }

    if (totalSettled > 0) {
      store.transactions.unshift({
        id: `tx_rim_all_${Date.now()}`,
        userId: user.id,
        type: 'income',
        amount: totalSettled,
        category: 'Reimbursement',
        description: 'Bulk Reimbursement Settlement',
        date: ist.date,
        time: ist.time,
        paymentMethod: account === 'Cash' ? 'Cash' : account === 'Wife' ? 'Wife' : 'Bank Transfer',
        account,
        source: 'manual',
        createdAt: new Date().toISOString(),
        isReimbursementInflow: true,
      });
      saveUserData(user.id, store);
    }

    res.json({
      success: true,
      totalSettled,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- Categories & Budgets ----------------
  router.get('/categories', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ categories: store.categories });
  });

  router.post('/categories', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const { name, type, icon, color, keywords, excludeFromBudget } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Category name is required.' });
      return;
    }
    if (store.categories.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) {
      res.status(409).json({ error: 'Category already exists.' });
      return;
    }
    const newCat: CategoryDef = {
      id: `cat_${Date.now()}`,
      name: cleanName,
      type: type === 'income' || type === 'both' ? type : 'expense',
      icon: String(icon || 'Tag'),
      color: String(color || '#6366F1'),
      keywords: Array.isArray(keywords)
        ? keywords.map((k: string) => String(k).trim()).filter(Boolean)
        : String(keywords || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
      isCustom: true,
      excludeFromBudget: Boolean(excludeFromBudget),
    };
    store.categories.push(newCat);
    syncBudgetsWithCategories(store);
    saveUserData(user.id, store);
    res.status(201).json({ success: true, categories: store.categories, budgets: store.budgets });
  });

  router.put('/categories/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const idx = store.categories.findIndex(c => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Category not found.' });
      return;
    }
    const prevName = store.categories[idx].name;
    const patch = req.body || {};
    store.categories[idx] = {
      ...store.categories[idx],
      name: patch.name ? String(patch.name).trim() : prevName,
      color: patch.color || store.categories[idx].color,
      icon: patch.icon || store.categories[idx].icon,
      keywords: Array.isArray(patch.keywords)
        ? patch.keywords
        : typeof patch.keywords === 'string'
        ? patch.keywords.split(',').map((s: string) => s.trim()).filter(Boolean)
        : store.categories[idx].keywords,
      excludeFromBudget:
        patch.excludeFromBudget !== undefined
          ? Boolean(patch.excludeFromBudget)
          : store.categories[idx].excludeFromBudget,
    };
    if (patch.name && patch.name.trim().toLowerCase() !== prevName.toLowerCase()) {
      const nextName = store.categories[idx].name;
      for (const tx of store.transactions) {
        if ((tx.category || '').trim().toLowerCase() === prevName.trim().toLowerCase()) {
          tx.category = nextName;
        }
      }
      for (const b of store.budgets) {
        if ((b.category || '').trim().toLowerCase() === prevName.trim().toLowerCase()) {
          b.category = nextName;
        }
      }
    }
    syncBudgetsWithCategories(store);
    saveUserData(user.id, store);
    res.json({ success: true, categories: store.categories, budgets: store.budgets, transactions: store.transactions });
  });

  router.delete('/categories/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const target = store.categories.find(c => c.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Category not found.' });
      return;
    }
    store.categories = store.categories.filter(c => c.id !== req.params.id);
    store.deletedCategories = Array.from(new Set([...(store.deletedCategories || []), target.id, target.name]));
    syncBudgetsWithCategories(store);
    saveUserData(user.id, store);
    res.json({ success: true, categories: store.categories, budgets: store.budgets });
  });

  router.post('/categories/bulk-exclude', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const excludeFromBudget = Boolean(req.body?.excludeFromBudget);

    for (const cat of store.categories) {
      if (cat.type !== 'income') {
        cat.excludeFromBudget = excludeFromBudget;
      }
    }

    syncBudgetsWithCategories(store);
    saveUserData(user.id, store);
    res.json({
      success: true,
      categories: store.categories,
      budgets: store.budgets,
      summary: computeFinancialSummary(store),
    });
  });

  router.get('/budgets', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    const rawMonth = typeof req.query.month === 'string' ? req.query.month : getIstDateTime().month;
    const isAllMonths = rawMonth === 'all';
    const spentMap: Record<string, number> = {};
    const countMap: Record<string, number> = {};
    const catByLower = new Map(store.categories.map(c => [c.name.trim().toLowerCase(), c]));
    for (const tx of store.transactions) {
      if (tx.type !== 'expense' || (!isAllMonths && !tx.date?.startsWith(rawMonth))) continue;
      const key = (tx.category || '').trim().toLowerCase();
      const catDef = catByLower.get(key);
      const hasNonPersonalFlag = Boolean(
        tx.isReimbursement || tx.isCcPayment || tx.isUdhaarLent || tx.isWifeTransfer || tx.isSavingsTransfer
      );
      if (hasNonPersonalFlag && catDef?.excludeFromBudget !== false) {
        continue;
      }
      spentMap[key] = (spentMap[key] || 0) + Number(tx.amount || 0);
      countMap[key] = (countMap[key] || 0) + 1;
    }
    const enriched = store.budgets.map(b => {
      const key = b.category.trim().toLowerCase();
      return {
        ...b,
        spent: spentMap[key] || 0,
        txCount: countMap[key] || 0,
      };
    });
    res.json({ budgets: enriched, summary: computeFinancialSummary(store, rawMonth) });
  });

  router.put(['/budgets', '/budgets/set'], (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const list: CategoryBudget[] = req.body?.newBudgets || req.body?.budgets || [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const existing = store.budgets.find(b => b.category.toLowerCase() === String(item.category).toLowerCase());
        if (existing) {
          existing.limit = Math.max(0, Number(item.limit || 0));
        } else {
          store.budgets.push({ category: String(item.category), limit: Math.max(0, Number(item.limit || 0)), period: 'monthly' });
        }
      }
      saveUserData(user.id, store);
    }
    res.json({ success: true, budgets: store.budgets, summary: computeFinancialSummary(store) });
  });

  router.get('/budgets/template', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    const catByName = new Map(store.categories.map(c => [c.name.toLowerCase(), c]));
    const rows = store.budgets.map(b => {
      const cat = catByName.get(b.category.toLowerCase());
      return {
        Category: b.category,
        MonthlyLimitINR: b.limit,
        Type: cat?.type || 'expense',
        Keywords: (cat?.keywords || []).join(', '),
        ExcludeFromPersonalSpend: cat?.excludeFromBudget ? 'Yes' : 'No',
        OldCategoryMap: '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Budgets');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="teleexpense-budgets-template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  router.post('/budgets/import-excel', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const rows = req.body?.rows;
    const replaceExisting = Boolean(req.body?.replaceExisting);
    const remapTransactions = req.body?.remapTransactions !== false;

    if (!Array.isArray(rows)) {
      res.status(400).json({ error: 'Invalid budget rows payload.' });
      return;
    }

    const PALETTE = ['#38BDF8', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#F97316', '#14B8A6', '#EF4444', '#6366F1', '#06B6D4'];
    const parsedRows: Array<{
      name: string;
      limit: number;
      type: 'expense' | 'income' | 'both';
      keywords: string[];
      oldMaps: string[];
      color?: string;
      excludeFromBudget?: boolean;
    }> = [];

    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const catRaw = r.Category ?? r.category ?? r['Category Name'] ?? r.Name ?? r.name ?? '';
      const name = String(catRaw).trim();
      if (!name) continue;
      const rawLimit =
        r.MonthlyLimitINR ??
        r['Monthly Limit (INR)'] ??
        r['Monthly Limit'] ??
        r.Limit ??
        r.limit ??
        r.Budget ??
        r.budget ??
        r.Amount ??
        r.amount ??
        0;
      const numLimit = Number(String(rawLimit).replace(/[₹,\s]/g, ''));
      const limit = Number.isFinite(numLimit) ? Math.max(0, numLimit) : 0;
      const rawType = String(r.Type ?? r.type ?? 'expense').trim().toLowerCase();
      const type: 'expense' | 'income' | 'both' =
        rawType === 'income' ? 'income' : rawType === 'both' ? 'both' : 'expense';
      const rawKw = r.Keywords ?? r.keywords ?? '';
      const keywords = Array.isArray(rawKw)
        ? rawKw.map((k: unknown) => String(k).trim()).filter(Boolean)
        : String(rawKw)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
      const rawOldMap = r.OldCategoryMap ?? r['Old Category'] ?? r.MapFrom ?? r.Alias ?? '';
      const oldMaps = String(rawOldMap)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      const color = typeof r.Color === 'string' && r.Color.trim() ? r.Color.trim() : undefined;
      const rawExclude =
        r.ExcludeFromPersonalSpend ??
        r['Exclude From Personal Spend'] ??
        r.ExcludeFromBudget ??
        r.Excluded;
      const hasExplicitExclude = rawExclude !== undefined && String(rawExclude).trim() !== '';
      const excludeFromBudget = hasExplicitExclude
        ? typeof rawExclude === 'boolean'
          ? rawExclude
          : /^(yes|true|1|y|exclude|excluded)$/i.test(String(rawExclude).trim())
        : undefined;

      parsedRows.push({ name, limit, type, keywords, oldMaps, color, excludeFromBudget });
    }

    if (parsedRows.length === 0) {
      res.status(400).json({ error: 'No valid Category rows found in the uploaded sheet.' });
      return;
    }

    const prevCategories = [...store.categories];
    const seedPool = [...prevCategories, ...DEFAULT_CATEGORIES];
    const buildKeywords = (name: string, explicitKeywords: string[]) => {
      if (explicitKeywords.length > 0) return explicitKeywords;
      const exactSeed = seedPool.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (exactSeed?.keywords?.length) return [...exactSeed.keywords];
      const words = name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 3 && !['and', 'the', 'for', 'misc'].includes(w));
      const inherited = new Set<string>([name.toLowerCase(), ...words]);
      for (const seed of seedPool) {
        const seedWords = seed.name.toLowerCase().split(/[^a-z0-9]+/);
        if (words.some(w => seedWords.includes(w) || (seed.keywords || []).some(k => k.toLowerCase() === w))) {
          for (const kw of seed.keywords || []) inherited.add(kw.toLowerCase());
        }
      }
      return Array.from(inherited);
    };

    const oldToNewMap = new Map<string, string>();
    for (const row of parsedRows) {
      for (const oldKey of row.oldMaps) {
        oldToNewMap.set(oldKey, row.name);
      }
    }

    let removedOldCount = 0;
    if (replaceExisting) {
      const importedNamesLower = new Set(parsedRows.map(r => r.name.toLowerCase()));
      const hasIncomeRows = parsedRows.some(r => r.type === 'income');

      // Preserve special system categories (Reimbursement, Wife Transfer, CC Payment, Udhaar, Salary/Income unless imported)
      const preserved = store.categories.filter(c => {
        if (importedNamesLower.has(c.name.toLowerCase())) return false;
        if (c.excludeFromBudget) return true;
        if (c.id === 'uncategorized' || c.id === 'udhaar_recovery') return true;
        if (c.type === 'income' && !hasIncomeRows) return true;
        return false;
      });

      const removedCategories = store.categories.filter(
        c => !importedNamesLower.has(c.name.toLowerCase()) && !preserved.some(p => p.id === c.id)
      );
      removedOldCount = removedCategories.length;

      const deletedSet = new Set(store.deletedCategories || []);
      for (const rem of removedCategories) {
        if (rem.isDefault || DEFAULT_CATEGORIES.some(d => d.id === rem.id || d.name.toLowerCase() === rem.name.toLowerCase())) {
          deletedSet.add(rem.id);
          deletedSet.add(rem.name);
        }
      }
      // Un-delete any default category re-introduced by the import
      for (const row of parsedRows) {
        const matchDef = DEFAULT_CATEGORIES.find(d => d.name.toLowerCase() === row.name.toLowerCase());
        if (matchDef) {
          deletedSet.delete(matchDef.id);
          deletedSet.delete(matchDef.name);
        }
        deletedSet.delete(row.name);
      }
      store.deletedCategories = Array.from(deletedSet);

      const nextImportedCategories: CategoryDef[] = parsedRows.map((row, idx) => {
        const prev = seedPool.find(c => c.name.toLowerCase() === row.name.toLowerCase());
        return {
          id: prev?.id || `cat_${Date.now()}_${idx}`,
          name: row.name,
          type: row.type,
          icon: prev?.icon || 'Tag',
          color: row.color || prev?.color || PALETTE[idx % PALETTE.length],
          keywords: buildKeywords(row.name, row.keywords),
          isCustom: !prev?.isDefault,
          isDefault: prev?.isDefault,
          excludeFromBudget:
            row.excludeFromBudget !== undefined ? row.excludeFromBudget : prev?.excludeFromBudget,
        };
      });

      store.categories = [...nextImportedCategories, ...preserved];
      store.budgets = parsedRows
        .filter(r => r.type === 'expense' || r.type === 'both')
        .map(r => ({
          category: r.name,
          limit: r.limit,
          period: 'monthly' as const,
        }));
    } else {
      for (let idx = 0; idx < parsedRows.length; idx++) {
        const row = parsedRows[idx];
        const existingCat = store.categories.find(c => c.name.toLowerCase() === row.name.toLowerCase());
        if (!existingCat) {
          store.categories.push({
            id: `cat_${Date.now()}_${idx}`,
            name: row.name,
            type: row.type,
            icon: 'Tag',
            color: row.color || PALETTE[idx % PALETTE.length],
            keywords: buildKeywords(row.name, row.keywords),
            isCustom: true,
            excludeFromBudget: row.excludeFromBudget,
          });
        } else {
          existingCat.name = row.name;
          if (row.keywords.length > 0) existingCat.keywords = row.keywords;
          if (row.color) existingCat.color = row.color;
          if (row.excludeFromBudget !== undefined) existingCat.excludeFromBudget = row.excludeFromBudget;
        }

        if (row.type === 'expense' || row.type === 'both') {
          const existingBudget = store.budgets.find(b => b.category.toLowerCase() === row.name.toLowerCase());
          if (existingBudget) {
            existingBudget.category = row.name;
            existingBudget.limit = row.limit;
          } else {
            store.budgets.push({ category: row.name, limit: row.limit, period: 'monthly' });
          }
        }
      }
    }

    // Remap / sync transactions to current categories
    let transactionsUpdated = 0;
    if (remapTransactions) {
      const activeCatsByLower = new Map(store.categories.map(c => [c.name.toLowerCase(), c]));
      const nonSpecialCats = store.categories.filter(c => !c.excludeFromBudget && c.id !== 'uncategorized');
      const fallbackExpenseCat =
        nonSpecialCats.find(c => /\bother/i.test(c.name))?.name ||
        nonSpecialCats.find(c => c.type === 'expense' || c.type === 'both')?.name;

      for (const tx of store.transactions) {
        const currLower = (tx.category || '').trim().toLowerCase();
        // Keep special accounting tags untouched unless explicitly mapped
        if (
          (tx.isReimbursement || tx.isReimbursementInflow || tx.isCcPayment || tx.isWifeTransfer || tx.isSavingsTransfer || tx.isUdhaarLent || tx.isUdhaarRecovery || tx.isUdhaarRepaid) &&
          !oldToNewMap.has(currLower)
        ) {
          continue;
        }

        let targetCategory: string | undefined = oldToNewMap.get(currLower);
        if (!targetCategory) {
          const direct = activeCatsByLower.get(currLower);
          if (direct) targetCategory = direct.name;
        }
        if (!targetCategory) {
          // Try keyword / description / old-category matching against active categories
          const candidates = nonSpecialCats.filter(c => c.type === tx.type || c.type === 'both');
          if (candidates.length > 0) {
            const matched = matchCategory(`${tx.description || ''} ${tx.rawMessage || ''} ${tx.category || ''}`, tx.type, candidates);
            const fallbackId = tx.type === 'income' ? 'other_income' : 'other_expense';
            if (matched && matched.id !== fallbackId) {
              targetCategory = matched.name;
            } else if (replaceExisting) {
              // Try word overlap between old category name and imported category names
              const oldWords = currLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
              const wordHit = candidates.find(c => {
                const cWords = c.name.toLowerCase().split(/[^a-z0-9]+/);
                return oldWords.some(w => cWords.includes(w));
              });
              targetCategory = wordHit?.name || (tx.type === 'expense' ? fallbackExpenseCat : undefined);
            }
          }
        }

        if (targetCategory && targetCategory !== tx.category) {
          tx.category = targetCategory;
          transactionsUpdated++;
        }
      }
    }

    syncBudgetsWithCategories(store);
    saveUserData(user.id, store);
    res.json({
      success: true,
      mode: replaceExisting ? 'replace' : 'merge',
      updated: parsedRows.length,
      removedOldCount,
      transactionsUpdated,
      categories: store.categories,
      budgets: store.budgets,
      transactions: store.transactions,
      summary: computeFinancialSummary(store),
    });
  });

  router.post('/transactions/recategorize', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const activeCatsByLower = new Map(store.categories.map(c => [c.name.toLowerCase(), c]));
    const nonSpecialCats = store.categories.filter(c => !c.excludeFromBudget && c.id !== 'uncategorized');
    const fallbackExpenseCat =
      nonSpecialCats.find(c => /\bother/i.test(c.name))?.name ||
      nonSpecialCats.find(c => c.type === 'expense' || c.type === 'both')?.name;

    let updatedCount = 0;
    for (const tx of store.transactions) {
      if (tx.isReimbursement || tx.isReimbursementInflow || tx.isCcPayment || tx.isWifeTransfer || tx.isSavingsTransfer || tx.isUdhaarLent || tx.isUdhaarRecovery || tx.isUdhaarRepaid) {
        continue;
      }
      const currLower = (tx.category || '').trim().toLowerCase();
      if (activeCatsByLower.has(currLower) && req.body?.forceAll !== true) {
        const canonical = activeCatsByLower.get(currLower)!.name;
        if (canonical !== tx.category) {
          tx.category = canonical;
          updatedCount++;
        }
        continue;
      }
      const candidates = nonSpecialCats.filter(c => c.type === tx.type || c.type === 'both');
      if (candidates.length === 0) continue;
      const matched = matchCategory(`${tx.description || ''} ${tx.rawMessage || ''} ${tx.category || ''}`, tx.type, candidates);
      const nextCat = matched?.name || (tx.type === 'expense' ? fallbackExpenseCat : tx.category);
      if (nextCat && nextCat !== tx.category) {
        tx.category = nextCat;
        updatedCount++;
      }
    }

    if (updatedCount > 0) saveUserData(user.id, store);
    res.json({
      success: true,
      updatedCount,
      transactions: store.transactions,
      budgets: store.budgets,
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- Accounts, EMIs & Savings Transfers ----------------
  router.get('/accounts/balances', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json(computeAccountBalances(store));
  });

  router.post('/accounts/balances', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const { accountBaseBalances, wifeBaseBalance, cardCreditLimits, resetTimestampForAccount } = req.body || {};

    if (accountBaseBalances && typeof accountBaseBalances === 'object') {
      for (const [accId, val] of Object.entries(accountBaseBalances)) {
        const numVal = Number(val || 0);
        store.accountBaseBalances[accId] = numVal;
        if (resetTimestampForAccount === accId) {
          store.accountBalanceSetTimestamps[accId] = new Date().toISOString();
        }
        if (accId === 'Wife') {
          store.wifeBaseBalance = numVal;
          if (resetTimestampForAccount === 'Wife') {
            store.wifeBalanceSetTimestamp = store.accountBalanceSetTimestamps['Wife'];
          }
        }
      }
    }
    if (wifeBaseBalance !== undefined) {
      const numWife = Number(wifeBaseBalance || 0);
      const nowIso = new Date().toISOString();
      store.wifeBaseBalance = numWife;
      store.wifeBalanceSetTimestamp = nowIso;
      store.accountBaseBalances['Wife'] = numWife;
      store.accountBalanceSetTimestamps['Wife'] = nowIso;
    }
    if (cardCreditLimits && typeof cardCreditLimits === 'object') {
      for (const [cid, lim] of Object.entries(cardCreditLimits)) {
        store.cardCreditLimits[cid] = Math.max(0, Number(lim || 0));
      }
    }
    saveUserData(user.id, store);
    res.json({ success: true, ...computeAccountBalances(store) });
  });

  router.post('/accounts/custom', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const { name, shortName, type, badge, color, creditLimit, billingDay, paymentDueDay } = req.body || {};
    const cleanShort = String(shortName || name || '').trim();
    if (!cleanShort) {
      res.status(400).json({ error: 'Account name is required.' });
      return;
    }
    const id = cleanShort;
    store.customAccounts = store.customAccounts.filter(a => a.id !== id);
    store.customAccounts.push({
      id,
      name: String(name || cleanShort).trim(),
      shortName: cleanShort,
      type: type || 'bank_account',
      badge: String(badge || 'Custom'),
      color: String(color || '#38BDF8'),
      creditLimit: creditLimit ? Number(creditLimit) : undefined,
      billingDay: billingDay ? Number(billingDay) : undefined,
      paymentDueDay: paymentDueDay ? Number(paymentDueDay) : undefined,
      isCustom: true,
    });
    saveUserData(user.id, store);
    res.status(201).json({ success: true, ...computeAccountBalances(store) });
  });

  router.put('/accounts/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const id = req.params.id;
    const merged = getMergedAccounts(store);
    const existing = merged[id];
    if (!existing) {
      res.status(404).json({ error: 'Account or credit card not found.' });
      return;
    }

    const b = req.body || {};
    const cleanShort = String(b.shortName ?? existing.shortName ?? id).trim();
    const cleanName = String(b.name ?? existing.name ?? cleanShort).trim();
    if (!cleanShort || !cleanName) {
      res.status(400).json({ error: 'Card name and short label are required.' });
      return;
    }

    const validTypes = new Set(['credit_card', 'rupay_card', 'bank_account', 'cash']);
    const nextType = validTypes.has(b.type) ? b.type : existing.type;
    const isCard = nextType === 'credit_card' || nextType === 'rupay_card';
    const nextLimit =
      b.creditLimit !== undefined && b.creditLimit !== ''
        ? Math.max(0, Number(b.creditLimit || 0))
        : existing.creditLimit;

    const parseDay = (val: unknown, fallback?: number) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Math.round(Number(val));
      if (!Number.isFinite(n) || n < 1 || n > 31) return fallback;
      return n;
    };

    const nextBillingDay =
      b.billingDay !== undefined ? parseDay(b.billingDay, existing.billingDay) : existing.billingDay;
    const nextDueDay =
      b.paymentDueDay !== undefined
        ? parseDay(b.paymentDueDay, existing.paymentDueDay)
        : existing.paymentDueDay;

    const updatedMeta = {
      ...existing,
      id,
      name: cleanName,
      shortName: cleanShort,
      type: nextType,
      badge:
        b.badge !== undefined
          ? String(b.badge).trim() || existing.badge
          : nextType === 'rupay_card'
          ? 'RuPay CC'
          : isCard
          ? existing.badge || 'Credit Card'
          : existing.badge,
      creditLimit: isCard ? nextLimit : undefined,
      billingDay: isCard ? nextBillingDay : undefined,
      paymentDueDay: isCard ? nextDueDay : undefined,
      isCustom: true,
    };

    store.customAccounts = (store.customAccounts || []).filter(a => a.id !== id);
    store.customAccounts.push(updatedMeta);

    if (isCard && nextLimit !== undefined && Number.isFinite(nextLimit)) {
      store.cardCreditLimits[id] = nextLimit;
    }

    if (b.baseBalance !== undefined && b.baseBalance !== '') {
      const nextBase = Number(b.baseBalance);
      if (Number.isFinite(nextBase)) {
        store.accountBaseBalances[id] = nextBase;
        if (b.resetTimestamp) {
          store.accountBalanceSetTimestamps[id] = new Date().toISOString();
        }
      }
    }

    saveUserData(user.id, store);
    res.json({ success: true, ...computeAccountBalances(store) });
  });

  router.post('/accounts/:id/settle-card', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const cardId = req.params.id;
    const merged = getMergedAccounts(store);
    const card = merged[cardId];
    if (!card || (card.type !== 'credit_card' && card.type !== 'rupay_card')) {
      res.status(404).json({ error: 'Credit card not found.' });
      return;
    }

    const { amount, fromAccount, date, note } = req.body || {};
    const numAmount = Number(amount || 0);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: 'Please enter a valid settlement amount greater than zero.' });
      return;
    }

    const cleanAmount = Math.round(numAmount * 100) / 100;
    const ist = getIstDateTime();
    const cleanDate =
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? date.trim() : ist.date;
    const cleanFrom = String(fromAccount || 'AX Bank').trim() || 'AX Bank';
    const isExternal = cleanFrom === 'EXTERNAL';
    const cleanNote = String(note || '').trim();

    if (!isExternal && cleanFrom === cardId) {
      res.status(400).json({ error: 'Source payment account cannot be the same credit card.' });
      return;
    }

    const balancesBefore = computeAccountBalances(store);
    const currentOut = Number(balancesBefore.accounts[cardId]?.currentOutstanding || 0);
    const settlementTypeLabel =
      currentOut > 0 && cleanAmount + 0.01 < currentOut ? 'Partial' : 'Full';

    const tx: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId: user.id,
      date: cleanDate,
      time: ist.time,
      type: isExternal ? 'income' : 'expense',
      amount: cleanAmount,
      category: 'CC Payment',
      description: cleanNote
        ? `CC ${settlementTypeLabel} Settle — ${card.shortName} (${cleanNote})`
        : isExternal
        ? `CC ${settlementTypeLabel} Settle — ${card.shortName} (External)`
        : `CC ${settlementTypeLabel} Payment — ${card.shortName}`,
      rawMessage: `CC settle ${card.shortName} ₹${cleanAmount} (${settlementTypeLabel}) via ${cleanFrom}`,
      paymentMethod: isExternal ? 'Card' : cleanFrom === 'Cash' ? 'Cash' : cleanFrom === 'Wife' ? 'Wife' : 'UPI',
      account: isExternal ? cardId : cleanFrom,
      source: 'manual',
      tags: ['cc-settlement', settlementTypeLabel.toLowerCase()],
      isCcPayment: true,
      ccSettledCardId: cardId,
      createdAt: new Date().toISOString(),
    };

    store.transactions.unshift(tx);
    saveUserData(user.id, store);
    res.status(201).json({
      success: true,
      transaction: tx,
      ...computeAccountBalances(store),
      summary: computeFinancialSummary(store),
    });
  });

  router.delete('/accounts/custom/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.customAccounts = store.customAccounts.filter(a => a.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, ...computeAccountBalances(store) });
  });

  router.get('/emis', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ emis: store.cardEmis });
  });

  router.post('/emis', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const emi = {
      id: `emi_${Date.now()}`,
      userId: user.id,
      cardId: String(b.cardId || 'ICICI CC 0000'),
      title: String(b.title || 'Card EMI').trim(),
      monthlyAmount: Number(b.monthlyAmount || 0),
      totalMonths: Math.max(1, Number(b.totalMonths || 6)),
      paidMonths: Math.max(0, Number(b.paidMonths || 0)),
      dueDay: Math.min(31, Math.max(1, Number(b.dueDay || 5))),
      startDate: String(b.startDate || getIstDateTime().date),
      notes: b.notes ? String(b.notes) : undefined,
      createdAt: new Date().toISOString(),
    };
    store.cardEmis.unshift(emi);
    saveUserData(user.id, store);
    res.status(201).json({ success: true, emi, emis: store.cardEmis });
  });

  router.put('/emis/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const idx = store.cardEmis.findIndex(e => e.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'EMI not found.' });
      return;
    }
    store.cardEmis[idx] = { ...store.cardEmis[idx], ...req.body, id: store.cardEmis[idx].id };
    saveUserData(user.id, store);
    res.json({ success: true, emis: store.cardEmis });
  });

  router.delete('/emis/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.cardEmis = store.cardEmis.filter(e => e.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, emis: store.cardEmis });
  });

  router.get('/savings-transfers', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ savingsTransfers: store.savingsTransfers });
  });

  router.post('/savings-transfers', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'Amount must be greater than 0.' });
      return;
    }
    const ist = getIstDateTime();
    const txId = `tx_wife_${Date.now()}`;
    const transfer = {
      id: `sav_${Date.now()}`,
      userId: user.id,
      amount,
      date: String(b.date || ist.date),
      recipient: String(b.recipient || "Wife's Savings"),
      fromAccount: String(b.fromAccount || 'AX Bank'),
      notes: b.notes ? String(b.notes) : undefined,
      linkedTransactionId: txId,
      createdAt: new Date().toISOString(),
    };
    store.savingsTransfers.unshift(transfer);
    store.transactions.unshift({
      id: txId,
      userId: user.id,
      type: 'expense',
      amount,
      category: 'Wife Transfer',
      description: transfer.notes || `Transfer to ${transfer.recipient}`,
      date: transfer.date,
      time: ist.time,
      paymentMethod: 'Bank Transfer',
      account: transfer.fromAccount,
      source: 'wealth',
      createdAt: transfer.createdAt,
      isSavingsTransfer: true,
      isWifeTransfer: true,
    });
    saveUserData(user.id, store);
    res.status(201).json({ success: true, savingsTransfers: store.savingsTransfers });
  });

  router.delete('/savings-transfers/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const target = store.savingsTransfers.find(s => s.id === req.params.id);
    if (target?.linkedTransactionId) {
      store.transactions = store.transactions.filter(t => t.id !== target.linkedTransactionId);
    }
    store.savingsTransfers = store.savingsTransfers.filter(s => s.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, savingsTransfers: store.savingsTransfers });
  });

  // ---------------- Gullak, Daily Limits & Piggy Bank ----------------
  router.get('/gullak', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    res.json(computeGullakSummary(store, user));
  });

  router.get('/daily-limits', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json(computeDailyLimits(store));
  });

  router.post('/daily-limits', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const itemName = String(b.itemName || '').trim();
    const dailyLimit = Number(b.dailyLimit || 0);
    if (!itemName || dailyLimit <= 0) {
      res.status(400).json({ error: 'Item name and positive daily limit required.' });
      return;
    }
    const item: DailyItemLimit = {
      id: `dl_${Date.now()}`,
      userId: user.id,
      itemName,
      dailyLimit,
      keywords: Array.isArray(b.keywords)
        ? b.keywords
        : String(b.keywords || itemName)
            .split(',')
            .map((s: string) => s.trim().toLowerCase())
            .filter(Boolean),
      category: String(b.category || 'Food & Dining'),
      notes: b.notes ? String(b.notes) : undefined,
      isActive: b.isActive !== false,
      createdAt: new Date().toISOString(),
    };
    store.dailyItemLimits.unshift(item);
    saveUserData(user.id, store);
    res.status(201).json({ success: true, ...computeDailyLimits(store) });
  });

  router.put('/daily-limits/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const idx = store.dailyItemLimits.findIndex(d => d.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Daily limit not found.' });
      return;
    }
    store.dailyItemLimits[idx] = { ...store.dailyItemLimits[idx], ...req.body, id: store.dailyItemLimits[idx].id };
    saveUserData(user.id, store);
    res.json({ success: true, ...computeDailyLimits(store) });
  });

  router.delete('/daily-limits/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.dailyItemLimits = store.dailyItemLimits.filter(d => d.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, ...computeDailyLimits(store) });
  });

  router.get('/piggy-bank', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    res.json({
      funds: store.piggyBankFunds,
      transactions: store.piggyBankTransactions,
      summary: computePiggyBankSummary(store, user),
    });
  });

  router.post('/piggy-bank', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Goal fund name is required.' });
      return;
    }
    const fund: PiggyBankItem = {
      id: `pb_${Date.now()}`,
      userId: user.id,
      name,
      category: b.category || 'goal',
      targetAmount: b.targetAmount ? Number(b.targetAmount) : undefined,
      currentBalance: Number(b.currentBalance || 0),
      color: String(b.color || '#10B981'),
      notes: b.notes ? String(b.notes) : undefined,
      isSurplusFund: Boolean(b.isSurplusFund),
      targetDate: b.targetDate ? String(b.targetDate) : undefined,
      createdAt: new Date().toISOString(),
    };
    store.piggyBankFunds.push(fund);
    saveUserData(user.id, store);
    res.status(201).json({
      success: true,
      funds: store.piggyBankFunds,
      transactions: store.piggyBankTransactions,
      summary: computePiggyBankSummary(store, user),
    });
  });

  router.post('/piggy-bank/collect-surplus', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const currentMonth = getIstDateTime().month;
    const summary = computePiggyBankSummary(store, user);
    const amount = summary.currentMonthUncollectedSurplus;
    if (amount <= 0) {
      res.status(400).json({ error: 'No uncollected surplus available for this month.' });
      return;
    }

    let surplusFund = store.piggyBankFunds.find(f => f.isSurplusFund);
    if (!surplusFund) {
      surplusFund = {
        id: `pb_surplus_${Date.now()}`,
        userId: user.id,
        name: 'Monthly Budget Surplus',
        category: 'general',
        currentBalance: 0,
        color: '#10B981',
        isSurplusFund: true,
        createdAt: new Date().toISOString(),
      };
      store.piggyBankFunds.unshift(surplusFund);
    }

    surplusFund.currentBalance += amount;
    store.collectedSurplusMonths = Array.from(new Set([...(store.collectedSurplusMonths || []), currentMonth]));
    store.piggyBankTransactions.unshift({
      id: `pbtx_${Date.now()}`,
      userId: user.id,
      fundId: surplusFund.id,
      fundName: surplusFund.name,
      type: 'surplus_collect',
      amount,
      notes: `Collected unspent budget surplus (${currentMonth})`,
      date: getIstDateTime().date,
      createdAt: new Date().toISOString(),
    });
    saveUserData(user.id, store);
    res.json({
      success: true,
      collected: amount,
      funds: store.piggyBankFunds,
      transactions: store.piggyBankTransactions,
      summary: computePiggyBankSummary(store, user),
    });
  });

  router.post('/piggy-bank/:id/transact', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const fund = store.piggyBankFunds.find(f => f.id === req.params.id);
    if (!fund) {
      res.status(404).json({ error: 'Piggy bank fund not found.' });
      return;
    }
    const { type, amount, notes } = req.body || {};
    const amt = Number(amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) {
      res.status(400).json({ error: 'Amount must be greater than zero.' });
      return;
    }
    if (type === 'withdraw') {
      if (fund.currentBalance < amt) {
        res.status(400).json({ error: 'Insufficient balance in this fund.' });
        return;
      }
      fund.currentBalance -= amt;
    } else {
      fund.currentBalance += amt;
    }
    store.piggyBankTransactions.unshift({
      id: `pbtx_${Date.now()}`,
      userId: user.id,
      fundId: fund.id,
      fundName: fund.name,
      type: type === 'withdraw' ? 'withdraw' : 'deposit',
      amount: amt,
      notes: notes ? String(notes) : undefined,
      date: getIstDateTime().date,
      createdAt: new Date().toISOString(),
    });
    saveUserData(user.id, store);
    res.json({
      success: true,
      funds: store.piggyBankFunds,
      transactions: store.piggyBankTransactions,
      summary: computePiggyBankSummary(store, user),
    });
  });

  router.delete('/piggy-bank/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.piggyBankFunds = store.piggyBankFunds.filter(f => f.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({
      success: true,
      funds: store.piggyBankFunds,
      summary: computePiggyBankSummary(store, user),
    });
  });

  // ---------------- Investments ----------------
  router.get('/investments', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ investments: store.investments });
  });

  router.post('/investments', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const parseOptNum = (val: unknown): number | undefined => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Number(val);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const inv: InvestmentRecord = {
      id: `inv_${Date.now()}`,
      userId: user.id,
      type: b.type || 'Mutual Fund',
      name: String(b.name || 'New Investment').trim(),
      amount: Number(b.amount || 0),
      monthlyAmount: parseOptNum(b.monthlyAmount),
      paidInstallments: parseOptNum(b.paidInstallments) ?? 0,
      totalInstallments: parseOptNum(b.totalInstallments),
      installmentFrequency: b.installmentFrequency || 'monthly',
      account: String(b.account || 'AX Bank'),
      date: String(b.date || getIstDateTime().date),
      maturityDate: b.maturityDate ? String(b.maturityDate) : undefined,
      interestRate: parseOptNum(b.interestRate),
      currentValue: parseOptNum(b.currentValue),
      maturityAmount: parseOptNum(b.maturityAmount),
      autoDebitEnabled: Boolean(b.autoDebitEnabled),
      autoDebitDay: parseOptNum(b.autoDebitDay),
      notes: b.notes ? String(b.notes) : undefined,
      createdAt: new Date().toISOString(),
    };
    if (inv.maturityDate && inv.date) {
      const m = calculateInvestmentMetrics(inv);
      if (m.tenureMonths > 0) inv.totalInstallments = m.totalInstallments;
    }
    store.investments.unshift(inv);
    saveUserData(user.id, store);
    res.status(201).json({ success: true, investments: store.investments });
  });

  router.patch('/investments/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const inv = store.investments.find(i => i.id === req.params.id);
    if (!inv) {
      res.status(404).json({ error: 'Investment not found.' });
      return;
    }
    const b = req.body || {};
    const parseOptNum = (val: unknown): number | undefined => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Number(val);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };

    if (b.type !== undefined) inv.type = b.type;
    if (b.name !== undefined && String(b.name).trim()) inv.name = String(b.name).trim();
    if (b.amount !== undefined && Number.isFinite(Number(b.amount))) inv.amount = Math.max(0, Number(b.amount));
    if (b.monthlyAmount !== undefined) inv.monthlyAmount = parseOptNum(b.monthlyAmount);
    if (b.paidInstallments !== undefined) inv.paidInstallments = parseOptNum(b.paidInstallments) ?? 0;
    if (b.totalInstallments !== undefined) inv.totalInstallments = parseOptNum(b.totalInstallments);
    if (b.installmentFrequency !== undefined) inv.installmentFrequency = b.installmentFrequency || 'monthly';
    if (b.account !== undefined) inv.account = String(b.account || 'AX Bank');
    if (b.date !== undefined && String(b.date).trim()) inv.date = String(b.date).trim();
    if (b.maturityDate !== undefined) {
      inv.maturityDate = b.maturityDate ? String(b.maturityDate).slice(0, 10) : undefined;
      if (!inv.maturityDate && b.totalInstallments === undefined) {
        inv.totalInstallments = undefined;
      }
    }
    if (b.interestRate !== undefined) inv.interestRate = parseOptNum(b.interestRate);
    if (b.currentValue !== undefined) inv.currentValue = parseOptNum(b.currentValue);
    if (b.maturityAmount !== undefined) inv.maturityAmount = parseOptNum(b.maturityAmount);
    if (b.autoDebitEnabled !== undefined) inv.autoDebitEnabled = Boolean(b.autoDebitEnabled);
    if (b.autoDebitDay !== undefined) inv.autoDebitDay = parseOptNum(b.autoDebitDay);
    if (b.notes !== undefined) inv.notes = b.notes ? String(b.notes) : undefined;

    if (inv.maturityDate && inv.date) {
      const m = calculateInvestmentMetrics(inv);
      if (m.tenureMonths > 0) inv.totalInstallments = m.totalInstallments;
    }

    saveUserData(user.id, store);
    res.json({ success: true, investment: inv, investments: store.investments });
  });

  router.post('/investments/:id/pay-installment', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const inv = store.investments.find(i => i.id === req.params.id);
    if (!inv) {
      res.status(404).json({ error: 'Investment not found.' });
      return;
    }
    const amt = Number(req.body?.amount || inv.monthlyAmount || 0);
    if (amt <= 0) {
      res.status(400).json({ error: 'Positive installment amount required.' });
      return;
    }
    const ist = getIstDateTime();
    const txId = `tx_inv_${Date.now()}`;
    store.transactions.unshift({
      id: txId,
      userId: user.id,
      type: 'expense',
      amount: amt,
      category: 'Investments & Savings',
      description: `Installment: ${inv.name}`,
      date: ist.date,
      time: ist.time,
      paymentMethod:
        String(req.body?.account || inv.account || 'AX Bank') === 'Wife'
          ? 'Wife'
          : String(req.body?.account || inv.account || 'AX Bank') === 'Cash'
          ? 'Cash'
          : 'Bank Transfer',
      account: String(req.body?.account || inv.account || 'AX Bank'),
      source: 'wealth',
      createdAt: new Date().toISOString(),
      isInvestment: true,
    });
    inv.amount += amt;
    if (inv.currentValue && inv.currentValue > 0) {
      inv.currentValue += amt;
    }
    inv.paidInstallments = (inv.paidInstallments || 0) + 1;
    inv.lastAutoDebitMonth = ist.month;
    saveUserData(user.id, store);
    res.json({ success: true, investments: store.investments, transactions: store.transactions });
  });

  router.post('/investments/process-auto-debits', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const { processedCount } = processInvestmentAutoDebits(user.id, store);
    if (processedCount > 0) saveUserData(user.id, store);
    res.json({ success: true, processedCount, investments: store.investments });
  });

  router.delete('/investments/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.investments = store.investments.filter(i => i.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, investments: store.investments });
  });

  // ---------------- Udhaar Khata ----------------
  router.get('/udhaar', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ udhaars: store.udhaars });
  });

  router.post('/udhaar', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    const personName = String(b.personName || '').trim();
    if (!personName || amount <= 0) {
      res.status(400).json({ error: 'Person name and positive amount required.' });
      return;
    }
    const ist = getIstDateTime();
    const type: 'lent' | 'borrowed' = b.type === 'borrowed' ? 'borrowed' : 'lent';
    const account = String(b.account || 'AX Bank');
    const txId = `tx_udh_${Date.now()}`;

    const record: UdhaarRecord = {
      id: `udh_${Date.now()}`,
      userId: user.id,
      type,
      personName,
      amount,
      settledAmount: 0,
      settlementHistory: [],
      description: b.description ? String(b.description) : undefined,
      date: String(b.date || ist.date),
      time: ist.time,
      status: 'pending',
      account,
      linkedTransactionId: txId,
      createdAt: new Date().toISOString(),
    };
    store.udhaars.unshift(record);

    if (type === 'lent') {
      store.transactions.unshift({
        id: txId,
        userId: user.id,
        type: 'expense',
        amount,
        category: 'Udhaar Given',
        description: `Udhaar to ${personName}${b.description ? ` (${b.description})` : ''}`,
        date: record.date,
        time: ist.time,
        paymentMethod: account === 'Cash' ? 'Cash' : account === 'Wife' ? 'Wife' : 'UPI',
        account,
        source: 'manual',
        createdAt: record.createdAt,
        isUdhaarLent: true,
        linkedUdhaarId: record.id,
        udhaarPersonName: personName,
      });
    }

    saveUserData(user.id, store);
    res.status(201).json({ success: true, udhaars: store.udhaars, transactions: store.transactions });
  });

  router.post('/udhaar/:id/settle', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const record = store.udhaars.find(u => u.id === req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Udhaar record not found.' });
      return;
    }
    const remaining = Math.max(0, record.amount - Number(record.settledAmount || 0));
    if (remaining <= 0) {
      res.status(400).json({ error: 'Record already settled.' });
      return;
    }

    const hasExplicitAmount = req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== '';
    const requestedAmount = hasExplicitAmount ? Number(req.body.amount) : remaining;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      res.status(400).json({ error: 'Enter a valid settlement amount greater than ₹0.' });
      return;
    }
    const amt = Math.min(remaining, Math.round(requestedAmount * 100) / 100);

    const ist = getIstDateTime();
    const account = String(req.body?.account || record.account || 'AX Bank');
    const date = String(req.body?.date || ist.date);
    const note = String(req.body?.notes ?? req.body?.note ?? '').trim();
    const txId = `tx_udh_settle_${Date.now()}`;

    const nextSettled = Math.round((Number(record.settledAmount || 0) + amt) * 100) / 100;
    const isNowSettled = nextSettled >= record.amount - 0.01;
    const paymentMethod =
      account === 'Cash'
        ? 'Cash'
        : account === 'Wife'
        ? 'Wife'
        : account.includes('CC') || account === 'IC Bank 2005'
        ? 'Card'
        : 'UPI';

    store.transactions.unshift({
      id: txId,
      userId: user.id,
      type: record.type === 'lent' ? 'income' : 'expense',
      amount: amt,
      category: record.type === 'lent' ? 'Udhaar Received' : 'Other Expense',
      description: `${record.type === 'lent' ? 'Udhaar Recovery from' : 'Udhaar Repaid to'} ${record.personName}${isNowSettled ? '' : ' (Partial)'}${note ? ` · ${note}` : ''}`,
      date,
      time: ist.time,
      paymentMethod,
      account,
      source: 'manual',
      createdAt: new Date().toISOString(),
      isUdhaarRecovery: record.type === 'lent',
      isUdhaarRepaid: record.type === 'borrowed',
      linkedUdhaarId: record.id,
      udhaarPersonName: record.personName,
    });

    record.settledAmount = isNowSettled ? record.amount : nextSettled;
    record.status = isNowSettled ? 'settled' : 'partial';
    record.settledInAccount = account;
    if (record.status === 'settled') record.settledAt = new Date().toISOString();
    record.settlementHistory = record.settlementHistory || [];
    record.settlementHistory.unshift({
      id: `us_${Date.now()}`,
      amount: amt,
      account,
      date,
      notes: note || undefined,
      linkedTxId: txId,
      createdAt: new Date().toISOString(),
    });

    saveUserData(user.id, store);
    res.json({ success: true, udhaars: store.udhaars, transactions: store.transactions });
  });

  router.delete('/udhaar/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.udhaars = store.udhaars.filter(u => u.id !== req.params.id);
    saveUserData(user.id, store);
    res.json({ success: true, udhaars: store.udhaars });
  });

  router.delete('/udhaar', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const deletedCount = store.udhaars.length;
    store.udhaars = [];
    saveUserData(user.id, store);
    res.json({
      success: true,
      deletedCount,
      udhaars: [],
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- Fuel & Mileage ----------------
  router.get('/fuel', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    res.json({ fuelLogs: recalculateFuelLogs(store.fuelLogs) });
  });

  router.post('/fuel', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const b = req.body || {};
    const fuelAmount = Number(b.fuelAmount || 0);
    const odometer = Number(b.odometer || 0);
    if (fuelAmount <= 0 || odometer <= 0) {
      res.status(400).json({ error: 'Fuel amount and odometer reading are required.' });
      return;
    }
    const ist = getIstDateTime();
    const newLog = {
      id: `fuel_${Date.now()}`,
      userId: user.id,
      date: String(b.date || ist.date),
      time: ist.time,
      vehicleName: String(b.vehicleName || 'Primary Vehicle').trim(),
      fuelAmount,
      fuelLiters: b.fuelLiters ? Number(b.fuelLiters) : undefined,
      odometer,
      notes: b.notes ? String(b.notes) : undefined,
      createdAt: new Date().toISOString(),
    };
    store.fuelLogs = recalculateFuelLogs([newLog, ...store.fuelLogs]);

    if (b.alsoLogTransaction !== false) {
      store.transactions.unshift({
        id: `tx_fuel_${Date.now()}`,
        userId: user.id,
        type: 'expense',
        amount: fuelAmount,
        category: 'Transportation & Fuel',
        description: `Fuel (${newLog.vehicleName} · ${odometer} km)`,
        date: newLog.date,
        time: ist.time,
        paymentMethod: 'UPI',
        account: String(b.account || 'ICICI CC 0000'),
        source: 'manual',
        createdAt: newLog.createdAt,
      });
    }

    saveUserData(user.id, store);
    res.status(201).json({ success: true, fuelLogs: store.fuelLogs, transactions: store.transactions });
  });

  router.delete('/fuel/:id', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    store.fuelLogs = recalculateFuelLogs(store.fuelLogs.filter(f => f.id !== req.params.id));
    saveUserData(user.id, store);
    res.json({ success: true, fuelLogs: store.fuelLogs });
  });

  // ---------------- Analytics Compare ----------------
  router.get('/analytics/compare', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    const byMonth: Record<string, { month: string; income: number; expense: number; savings: number }> = {};
    for (const tx of store.transactions) {
      const m = tx.date?.slice(0, 7);
      if (!m) continue;
      if (!byMonth[m]) byMonth[m] = { month: m, income: 0, expense: 0, savings: 0 };
      if (tx.type === 'income' && !tx.isReimbursementInflow && !tx.isUdhaarRecovery) {
        byMonth[m].income += Number(tx.amount || 0);
      } else if (
        tx.type === 'expense' &&
        !tx.isReimbursement &&
        !tx.isCcPayment &&
        !tx.isUdhaarLent &&
        !tx.isWifeTransfer
      ) {
        byMonth[m].expense += Number(tx.amount || 0);
      }
      byMonth[m].savings = byMonth[m].income - byMonth[m].expense;
    }
    res.json({
      months: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
    });
  });

  // ---------------- Excel Export & Restore ----------------
  router.get('/transactions/export-backup', (req: AuthedRequest, res) => {
    const store = getUserData(req.activeUser!.id);
    const wb = XLSX.utils.book_new();

    const txRows = store.transactions.map(t => ({
      ...t,
      tags: Array.isArray(t.tags) ? t.tags.join(', ') : t.tags || '',
    }));

    const catRows = (store.categories || []).map(c => ({
      ...c,
      keywords: Array.isArray(c.keywords) ? c.keywords.join(', ') : c.keywords || '',
      excludeFromBudget: Boolean(c.excludeFromBudget),
    }));

    const udhaarRows = (store.udhaars || []).map(u => ({
      ...u,
      settlementHistoryJson:
        Array.isArray(u.settlementHistory) && u.settlementHistory.length > 0
          ? JSON.stringify(u.settlementHistory)
          : '',
      settlementHistory: undefined,
    }));

    const udhaarSettlementRows = (store.udhaars || []).flatMap(u =>
      (u.settlementHistory || []).map(s => ({
        udhaarId: u.id,
        personName: u.personName,
        udhaarType: u.type,
        date: s.date,
        amount: Number(s.amount || 0),
        account: s.account,
        notes: s.notes || '',
        linkedTxId: s.linkedTxId || '',
      }))
    );

    const dailyLimitRows = (store.dailyItemLimits || []).map(d => ({
      ...d,
      keywords: Array.isArray(d.keywords) ? d.keywords.join(', ') : d.keywords || '',
    }));

    const accountSettingsRows = [
      { key: 'accountBaseBalances', value: JSON.stringify(store.accountBaseBalances || {}) },
      { key: 'accountBalanceSetTimestamps', value: JSON.stringify(store.accountBalanceSetTimestamps || {}) },
      { key: 'cardCreditLimits', value: JSON.stringify(store.cardCreditLimits || {}) },
      { key: 'wifeBaseBalance', value: String(Number(store.wifeBaseBalance || 0)) },
      { key: 'wifeBalanceSetTimestamp', value: store.wifeBalanceSetTimestamp || '' },
      { key: 'customAccounts', value: JSON.stringify(store.customAccounts || []) },
    ];

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(txRows), 'Transactions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Categories');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.budgets || []), 'Budgets');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(udhaarRows), 'Udhaar');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(udhaarSettlementRows), 'UdhaarSettlements');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.investments || []), 'Investments');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.fuelLogs || []), 'FuelLogs');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.cardEmis || []), 'CardEMIs');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.savingsTransfers || []), 'SavingsTransfers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyLimitRows), 'DailyLimits');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(store.piggyBankFunds || []), 'PiggyBankFunds');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(accountSettingsRows), 'AccountSettings');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="teleexpense-backup-${getIstDateTime().date}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  router.post('/transactions/restore-backup', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const body = req.body || {};
    const {
      transactions: incomingTxs,
      budgets: incomingBudgets,
      categories: incomingCategories,
      udhaars: incomingUdhaars,
      investments: incomingInvestments,
      fuelLogs: incomingFuelLogs,
      cardEmis: incomingEmis,
      savingsTransfers: incomingSavings,
      dailyItemLimits: incomingDailyLimits,
      piggyBankFunds: incomingPiggyFunds,
      accountSettings: incomingAccountSettings,
    } = body;

    if (!Array.isArray(incomingTxs)) {
      res.status(400).json({ error: 'Transactions array required for restore.' });
      return;
    }

    const toBool = (v: unknown): boolean | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
      return undefined;
    };

    const existingIds = new Set(store.transactions.map(t => t.id));
    let restoredCount = 0;
    for (const raw of incomingTxs) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || `tx_imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      if (existingIds.has(id)) continue;
      const amt = Number(raw.amount || 0);
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const tags = Array.isArray(raw.tags)
        ? raw.tags.map((x: unknown) => String(x).trim()).filter(Boolean)
        : typeof raw.tags === 'string' && raw.tags.trim()
        ? raw.tags.split(',').map((x: string) => x.trim()).filter(Boolean)
        : undefined;

      existingIds.add(id);
      store.transactions.push({
        ...raw,
        id,
        userId: user.id,
        type: String(raw.type).toLowerCase() === 'income' ? 'income' : 'expense',
        amount: amt,
        category: String(raw.category || 'Other Expense'),
        description: String(raw.description || 'Imported entry'),
        date: String(raw.date || getIstDateTime().date),
        source: raw.source || 'import',
        tags,
        isReimbursement: toBool(raw.isReimbursement),
        isReimbursementInflow: toBool(raw.isReimbursementInflow),
        reimbursementSettledAmount:
          raw.reimbursementSettledAmount !== undefined && raw.reimbursementSettledAmount !== ''
            ? Number(raw.reimbursementSettledAmount)
            : undefined,
        isSavingsTransfer: toBool(raw.isSavingsTransfer),
        isWifeTransfer: toBool(raw.isWifeTransfer),
        isCcPayment: toBool(raw.isCcPayment),
        isInvestment: toBool(raw.isInvestment),
        isUdhaarLent: toBool(raw.isUdhaarLent),
        isUdhaarRecovery: toBool(raw.isUdhaarRecovery),
        isUdhaarRepaid: toBool(raw.isUdhaarRepaid),
        createdAt: raw.createdAt || new Date().toISOString(),
      });
      restoredCount++;
    }

    let categoriesUpdated = 0;
    if (Array.isArray(incomingCategories)) {
      for (const rawCat of incomingCategories) {
        if (!rawCat?.name) continue;
        const keywords = Array.isArray(rawCat.keywords)
          ? rawCat.keywords.map((k: unknown) => String(k).trim()).filter(Boolean)
          : typeof rawCat.keywords === 'string'
          ? rawCat.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
          : [];
        const excl = toBool(rawCat.excludeFromBudget);
        const existingCat = store.categories.find(
          c => c.id === rawCat.id || c.name.toLowerCase() === String(rawCat.name).trim().toLowerCase()
        );
        if (existingCat) {
          if (excl !== undefined) existingCat.excludeFromBudget = excl;
          if (keywords.length > 0) existingCat.keywords = keywords;
          if (rawCat.color) existingCat.color = String(rawCat.color);
          categoriesUpdated++;
        } else {
          store.categories.push({
            id: String(rawCat.id || `cat_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`),
            name: String(rawCat.name).trim(),
            type: rawCat.type === 'income' || rawCat.type === 'both' ? rawCat.type : 'expense',
            icon: String(rawCat.icon || 'Tag'),
            color: String(rawCat.color || '#38BDF8'),
            keywords,
            isCustom: toBool(rawCat.isCustom) ?? true,
            excludeFromBudget: excl,
          });
          categoriesUpdated++;
        }
      }
    }

    if (Array.isArray(incomingBudgets)) {
      for (const b of incomingBudgets) {
        if (!b?.category) continue;
        const found = store.budgets.find(x => x.category.toLowerCase() === String(b.category).toLowerCase());
        if (found) found.limit = Number(b.limit || 0);
        else store.budgets.push({ category: String(b.category), limit: Number(b.limit || 0), period: 'monthly' });
      }
    }

    const mergeSheetById = <T extends { id?: string; userId?: string }>(target: T[], src: unknown, normalize?: (r: any) => T | null) => {
      if (!Array.isArray(src)) return 0;
      const seen = new Set(target.map(x => x.id).filter(Boolean));
      let added = 0;
      for (const raw of src) {
        if (!raw || typeof raw !== 'object') continue;
        const item = normalize ? normalize(raw) : ({ ...raw, userId: user.id } as T);
        if (!item) continue;
        if (item.id && seen.has(item.id)) continue;
        if (item.id) seen.add(item.id);
        target.push(item);
        added++;
      }
      return added;
    };

    const restoredUdhaars = mergeSheetById(store.udhaars, incomingUdhaars, (raw) => {
      if (!raw.personName || !Number(raw.amount)) return null;
      let settlementHistory = Array.isArray(raw.settlementHistory) ? raw.settlementHistory : undefined;
      if (!settlementHistory && typeof raw.settlementHistoryJson === 'string' && raw.settlementHistoryJson.trim()) {
        try {
          const parsed = JSON.parse(raw.settlementHistoryJson);
          if (Array.isArray(parsed)) settlementHistory = parsed;
        } catch {}
      }
      const out: any = {
        ...raw,
        id: String(raw.id || `udh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
        userId: user.id,
        amount: Number(raw.amount),
        settledAmount: Number(raw.settledAmount || 0),
        settlementHistory,
      };
      delete out.settlementHistoryJson;
      return out;
    });

    const numOrUndef = (v: unknown) =>
      v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const restoredInvestments = mergeSheetById(store.investments, incomingInvestments, (raw) =>
      raw.name
        ? {
            ...raw,
            id: String(raw.id || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
            userId: user.id,
            amount: Number(raw.amount || 0),
            monthlyAmount: numOrUndef(raw.monthlyAmount),
            paidInstallments: numOrUndef(raw.paidInstallments),
            totalInstallments: numOrUndef(raw.totalInstallments),
            maturityDate: raw.maturityDate ? String(raw.maturityDate).slice(0, 10) : undefined,
            interestRate: numOrUndef(raw.interestRate),
            currentValue: numOrUndef(raw.currentValue),
            maturityAmount: numOrUndef(raw.maturityAmount),
            autoDebitDay: numOrUndef(raw.autoDebitDay),
            autoDebitEnabled: toBool(raw.autoDebitEnabled),
          }
        : null
    );

    const restoredFuel = mergeSheetById(store.fuelLogs, incomingFuelLogs, (raw) =>
      Number(raw.fuelAmount) > 0 ? { ...raw, id: String(raw.id || `fuel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`), userId: user.id, fuelAmount: Number(raw.fuelAmount), odometer: Number(raw.odometer || 0) } : null
    );
    if (restoredFuel > 0) store.fuelLogs = recalculateFuelLogs(store.fuelLogs);

    const restoredEmis = mergeSheetById(store.cardEmis, incomingEmis, (raw) =>
      raw.title ? { ...raw, id: String(raw.id || `emi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`), userId: user.id, monthlyAmount: Number(raw.monthlyAmount || 0), totalMonths: Number(raw.totalMonths || 1), paidMonths: Number(raw.paidMonths || 0) } : null
    );

    const restoredSavings = mergeSheetById(store.savingsTransfers, incomingSavings, (raw) =>
      Number(raw.amount) > 0 ? { ...raw, id: String(raw.id || `sav_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`), userId: user.id, amount: Number(raw.amount) } : null
    );

    mergeSheetById(store.dailyItemLimits, incomingDailyLimits, (raw) =>
      raw.itemName
        ? {
            ...raw,
            id: String(raw.id || `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
            userId: user.id,
            dailyLimit: Number(raw.dailyLimit || 0),
            keywords: Array.isArray(raw.keywords)
              ? raw.keywords
              : typeof raw.keywords === 'string'
              ? raw.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
              : [],
            isActive: toBool(raw.isActive) ?? true,
          }
        : null
    );

    mergeSheetById(store.piggyBankFunds, incomingPiggyFunds, (raw) =>
      raw.name ? { ...raw, id: String(raw.id || `pb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`), userId: user.id, currentBalance: Number(raw.currentBalance || 0) } : null
    );

    if (Array.isArray(incomingAccountSettings)) {
      const kv = new Map<string, string>();
      for (const row of incomingAccountSettings) {
        if (row?.key) kv.set(String(row.key), String(row.value ?? ''));
      }
      const safeParse = <T,>(s: string | undefined): T | null => {
        if (!s) return null;
        try {
          return JSON.parse(s) as T;
        } catch {
          return null;
        }
      };
      const baseMap = safeParse<Record<string, number>>(kv.get('accountBaseBalances'));
      if (baseMap && typeof baseMap === 'object') {
        store.accountBaseBalances = { ...baseMap, ...store.accountBaseBalances };
      }
      const limitMap = safeParse<Record<string, number>>(kv.get('cardCreditLimits'));
      if (limitMap && typeof limitMap === 'object') {
        store.cardCreditLimits = { ...limitMap, ...store.cardCreditLimits };
      }
      const wifeBase = Number(kv.get('wifeBaseBalance'));
      if (Number.isFinite(wifeBase) && (store.wifeBaseBalance || 0) === 0 && wifeBase !== 0) {
        store.wifeBaseBalance = wifeBase;
      }
      const customAccs = safeParse<UserDataStore['customAccounts']>(kv.get('customAccounts'));
      if (Array.isArray(customAccs)) {
        mergeSheetById(store.customAccounts, customAccs);
      }
    }

    syncBudgetsWithCategories(store);
    store.transactions.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    saveUserData(user.id, store);

    const extraParts = [
      restoredUdhaars ? `${restoredUdhaars} udhaar` : '',
      restoredInvestments ? `${restoredInvestments} investments` : '',
      restoredEmis ? `${restoredEmis} card EMIs` : '',
      restoredSavings ? `${restoredSavings} transfers` : '',
      categoriesUpdated ? `${categoriesUpdated} categories` : '',
    ].filter(Boolean);

    res.json({
      success: true,
      message: `Restored ${restoredCount} new transactions${extraParts.length > 0 ? ` (${extraParts.join(', ')})` : ''}.`,
      restoredCount,
      categoriesCreated: categoriesUpdated,
      transactions: store.transactions,
      categories: store.categories,
      budgets: store.budgets,
      customAccounts: store.customAccounts,
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- 1-Click Full Account Migration (Export & Import Everything) ----------------
  router.get('/account/export-full', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const safeName = (user.name || 'account').replace(/[^a-zA-Z0-9_-]/g, '_');

    const bundle = {
      format: 'teleexpense-migration-v1',
      exportedAt: new Date().toISOString(),
      sourceUser: {
        name: user.name,
        email: user.email,
        trackingStartMonth: user.trackingStartMonth,
      },
      stats: {
        transactions: store.transactions.length,
        categories: store.categories.length,
        budgets: store.budgets.length,
        udhaars: store.udhaars.length,
        investments: store.investments.length,
        fuelLogs: store.fuelLogs.length,
        cardEmis: store.cardEmis.length,
        savingsTransfers: store.savingsTransfers.length,
        dailyItemLimits: store.dailyItemLimits.length,
        piggyBankFunds: store.piggyBankFunds.length,
        piggyBankTransactions: store.piggyBankTransactions.length,
        customAccounts: store.customAccounts.length,
      },
      data: {
        transactions: store.transactions,
        budgets: store.budgets,
        categories: store.categories,
        deletedCategories: store.deletedCategories || [],
        udhaars: store.udhaars,
        cardEmis: store.cardEmis,
        savingsTransfers: store.savingsTransfers,
        investments: store.investments,
        fuelLogs: store.fuelLogs,
        dailyItemLimits: store.dailyItemLimits,
        piggyBankFunds: store.piggyBankFunds,
        piggyBankTransactions: store.piggyBankTransactions,
        collectedSurplusMonths: store.collectedSurplusMonths || [],
        accountBaseBalances: store.accountBaseBalances || {},
        accountBalanceSetTimestamps: store.accountBalanceSetTimestamps || {},
        wifeBaseBalance: Number(store.wifeBaseBalance || 0),
        wifeBalanceSetTimestamp: store.wifeBalanceSetTimestamp,
        cardCreditLimits: store.cardCreditLimits || {},
        customAccounts: store.customAccounts || [],
      },
    };

    const jsonStr = JSON.stringify(bundle, null, 2);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="teleexpense-migration-${safeName}-${getIstDateTime().date}.json"`
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(jsonStr);
  });

  router.post('/account/import-full', (req: AuthedRequest, res) => {
    const user = req.activeUser!;
    const store = getUserData(user.id);
    const body = req.body || {};
    const mode: 'replace' | 'merge' = body.mode === 'merge' ? 'merge' : 'replace';
    const rawBundle = body.bundle && typeof body.bundle === 'object' ? body.bundle : body;
    const payloadData =
      rawBundle?.data && typeof rawBundle.data === 'object' ? rawBundle.data : rawBundle;

    if (!payloadData || typeof payloadData !== 'object' || !Array.isArray(payloadData.transactions)) {
      res.status(400).json({
        error: 'Invalid migration file. Expected a TeleExpense migration JSON exported from an account.',
      });
      return;
    }

    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const sanitizeNumericMap = (raw: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
      for (const [k, v] of Object.entries(raw)) {
        if (FORBIDDEN_KEYS.has(k)) continue;
        const num = Number(v);
        if (Number.isFinite(num)) out[k] = num;
      }
      return out;
    };
    const sanitizeStringMap = (raw: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
      for (const [k, v] of Object.entries(raw)) {
        if (FORBIDDEN_KEYS.has(k)) continue;
        if (typeof v === 'string' && v.trim()) out[k] = v;
      }
      return out;
    };
    const rebindUser = <T extends { userId?: string }>(arr: unknown): T[] => {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((item): item is T => Boolean(item && typeof item === 'object'))
        .map((item) => ({ ...item, userId: user.id }));
    };

    const incomingTransactions = rebindUser<Transaction>(payloadData.transactions);
    const incomingCategories = Array.isArray(payloadData.categories)
      ? payloadData.categories.filter((c: any) => c && typeof c === 'object' && c.name)
      : [];
    const incomingBudgets = Array.isArray(payloadData.budgets)
      ? payloadData.budgets.filter((b: any) => b && typeof b === 'object' && b.category)
      : [];
    const incomingUdhaars = rebindUser<UdhaarRecord>(payloadData.udhaars);
    const incomingEmis = rebindUser<UserDataStore['cardEmis'][number]>(payloadData.cardEmis);
    const incomingSavings = rebindUser<UserDataStore['savingsTransfers'][number]>(payloadData.savingsTransfers);
    const incomingInvestments = rebindUser<InvestmentRecord>(payloadData.investments);
    const incomingFuelLogs = rebindUser<UserDataStore['fuelLogs'][number]>(payloadData.fuelLogs);
    const incomingDailyLimits = rebindUser<DailyItemLimit>(payloadData.dailyItemLimits);
    const incomingPiggyFunds = rebindUser<PiggyBankItem>(payloadData.piggyBankFunds);
    const incomingPiggyTxs = rebindUser<UserDataStore['piggyBankTransactions'][number]>(
      payloadData.piggyBankTransactions
    );
    const incomingCollectedMonths: string[] = Array.isArray(payloadData.collectedSurplusMonths)
      ? payloadData.collectedSurplusMonths.map((m: unknown) => String(m)).filter(Boolean)
      : [];
    const incomingDeletedCats: string[] = Array.isArray(payloadData.deletedCategories)
      ? payloadData.deletedCategories.map((c: unknown) => String(c)).filter(Boolean)
      : [];
    const incomingBaseBalances = sanitizeNumericMap(payloadData.accountBaseBalances);
    const incomingTimestamps = sanitizeStringMap(payloadData.accountBalanceSetTimestamps);
    const incomingCardLimits = sanitizeNumericMap(payloadData.cardCreditLimits);
    const incomingCustomAccounts: UserDataStore['customAccounts'] = Array.isArray(payloadData.customAccounts)
      ? payloadData.customAccounts.filter((a: any) => a && typeof a === 'object' && a.id)
      : [];

    if (mode === 'replace') {
      store.transactions = incomingTransactions;
      store.categories = incomingCategories.length > 0 ? incomingCategories : store.categories;
      store.deletedCategories = incomingDeletedCats;
      store.budgets = incomingBudgets;
      store.udhaars = incomingUdhaars;
      store.cardEmis = incomingEmis;
      store.savingsTransfers = incomingSavings;
      store.investments = incomingInvestments;
      store.fuelLogs = recalculateFuelLogs(incomingFuelLogs);
      store.dailyItemLimits = incomingDailyLimits;
      store.piggyBankFunds = incomingPiggyFunds;
      store.piggyBankTransactions = incomingPiggyTxs;
      store.collectedSurplusMonths = incomingCollectedMonths;
      store.accountBaseBalances = incomingBaseBalances;
      store.accountBalanceSetTimestamps = incomingTimestamps;
      store.wifeBaseBalance = Number(payloadData.wifeBaseBalance || 0);
      store.wifeBalanceSetTimestamp =
        typeof payloadData.wifeBalanceSetTimestamp === 'string'
          ? payloadData.wifeBalanceSetTimestamp
          : undefined;
      store.cardCreditLimits = incomingCardLimits;
      store.customAccounts = incomingCustomAccounts;
    } else {
      const mergeById = <T extends { id?: string }>(target: T[], src: T[]) => {
        const seen = new Set(target.map(x => x.id).filter(Boolean));
        for (const item of src) {
          if (!item.id || !seen.has(item.id)) {
            target.push(item);
            if (item.id) seen.add(item.id);
          }
        }
      };

      mergeById(store.transactions, incomingTransactions);
      for (const cat of incomingCategories) {
        if (!store.categories.some(c => c.name.toLowerCase() === String(cat.name).toLowerCase())) {
          store.categories.push(cat);
        }
      }
      for (const b of incomingBudgets) {
        const found = store.budgets.find(x => x.category.toLowerCase() === String(b.category).toLowerCase());
        if (found) found.limit = Number(b.limit || 0);
        else store.budgets.push({ category: String(b.category), limit: Number(b.limit || 0), period: 'monthly' });
      }
      mergeById(store.udhaars, incomingUdhaars);
      mergeById(store.cardEmis, incomingEmis);
      mergeById(store.savingsTransfers, incomingSavings);
      mergeById(store.investments, incomingInvestments);
      mergeById(store.fuelLogs, incomingFuelLogs);
      store.fuelLogs = recalculateFuelLogs(store.fuelLogs);
      mergeById(store.dailyItemLimits, incomingDailyLimits);
      mergeById(store.piggyBankFunds, incomingPiggyFunds);
      mergeById(store.piggyBankTransactions, incomingPiggyTxs);
      mergeById(store.customAccounts, incomingCustomAccounts);
      store.collectedSurplusMonths = Array.from(
        new Set([...(store.collectedSurplusMonths || []), ...incomingCollectedMonths])
      );
      store.deletedCategories = Array.from(
        new Set([...(store.deletedCategories || []), ...incomingDeletedCats])
      );
      store.accountBaseBalances = { ...store.accountBaseBalances, ...incomingBaseBalances };
      store.accountBalanceSetTimestamps = {
        ...store.accountBalanceSetTimestamps,
        ...incomingTimestamps,
      };
      store.cardCreditLimits = { ...store.cardCreditLimits, ...incomingCardLimits };
      if (store.wifeBaseBalance === 0 && Number(payloadData.wifeBaseBalance || 0) !== 0) {
        store.wifeBaseBalance = Number(payloadData.wifeBaseBalance);
      }
    }

    const srcTrackingMonth = rawBundle?.sourceUser?.trackingStartMonth;
    if (typeof srcTrackingMonth === 'string' && /^\d{4}-\d{2}$/.test(srcTrackingMonth)) {
      const allUsers = getUsers();
      const targetUser = allUsers.find(u => u.id === user.id);
      if (targetUser) {
        targetUser.trackingStartMonth = srcTrackingMonth;
        saveUsers(allUsers);
      }
    }

    syncBudgetsWithCategories(store);
    store.transactions.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    saveUserData(user.id, store);

    res.json({
      success: true,
      mode,
      counts: {
        transactions: store.transactions.length,
        categories: store.categories.length,
        budgets: store.budgets.length,
        udhaars: store.udhaars.length,
        investments: store.investments.length,
        fuelLogs: store.fuelLogs.length,
        cardEmis: store.cardEmis.length,
        savingsTransfers: store.savingsTransfers.length,
        dailyItemLimits: store.dailyItemLimits.length,
        piggyBankFunds: store.piggyBankFunds.length,
        customAccounts: store.customAccounts.length,
      },
      customAccounts: store.customAccounts,
      categories: store.categories,
      budgets: store.budgets,
      summary: computeFinancialSummary(store),
    });
  });

  // ---------------- Telegram & AI Routes ----------------
  router.get('/telegram/config', async (req, res) => {
    try {
      await refreshTelegramBotInfo();
    } catch {
      // Never fail config fetch if Telegram API is temporarily unreachable
    }
    const cfg = getBotConfig();
    const rawHostUrl = `${req.protocol}://${req.get('host')}`;
    const appUrl = (process.env.APP_URL || rawHostUrl).replace(/\/+$/, '');
    const activeToken = getActiveBotToken();
    const maskedToken = activeToken
      ? `${activeToken.slice(0, 6)}••••${activeToken.slice(-4)}`
      : '';
    res.json({
      config: {
        ...cfg,
        botToken: maskedToken,
        hasEnvToken: Boolean(getEnvBotToken()),
      },
      appUrl,
      webhookUrl: `${appUrl}/api/telegram/webhook`,
      geminiConfigured: isGeminiConfigured(),
    });
  });

  router.post('/telegram/config', async (req, res) => {
    try {
      const rawToken = String(req.body?.botToken || '').trim();
      if (!rawToken || !/^\d{6,15}:[A-Za-z0-9_-]{25,}$/.test(rawToken)) {
        res.status(400).json({ error: 'Invalid Telegram Bot Token format.' });
        return;
      }
      const me = await callTelegramApi(rawToken, 'getMe');
      if (!me.ok) {
        res.status(400).json({ error: me.description || 'Telegram rejected this bot token.' });
        return;
      }
      const cfg = getBotConfig();
      saveBotConfig({
        ...cfg,
        botToken: rawToken,
        isConnected: true,
        botUsername: me.result?.username,
        botName: me.result?.first_name,
        lastError: undefined,
      });
      await syncBotCommands(rawToken);
      res.json({ success: true, botUsername: me.result?.username, botName: me.result?.first_name });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Failed to verify Telegram bot token.' });
    }
  });

  router.post('/telegram/set-webhook', async (req, res) => {
    try {
      const token = getActiveBotToken();
      if (!token) {
        res.status(400).json({ error: 'Configure a Telegram Bot Token first.' });
        return;
      }
      const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      let webhookUrl = String(req.body?.webhookUrl || `${appUrl}/api/telegram/webhook`).trim();
      if (webhookUrl.startsWith('http://') && !webhookUrl.includes('localhost') && !webhookUrl.includes('127.0.0.1')) {
        webhookUrl = webhookUrl.replace(/^http:\/\//i, 'https://');
      }

      const result = await callTelegramApi(token, 'setWebhook', { url: webhookUrl });
      if (!result.ok) {
        const errMsg = result.description || 'Failed to set webhook.';
        const cfg = getBotConfig();
        saveBotConfig({ ...cfg, lastError: errMsg });
        res.status(400).json({ error: errMsg });
        return;
      }

      const cfg = getBotConfig();
      saveBotConfig({
        ...cfg,
        isWebhookSet: true,
        webhookUrl,
        lastError: undefined,
      });
      await syncBotCommands(token);
      await refreshTelegramBotInfo();
      res.json({ success: true, webhookUrl, config: getBotConfig() });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Failed to activate Telegram webhook.' });
    }
  });

  router.post('/telegram/delete-webhook', async (_req, res) => {
    try {
      const token = getActiveBotToken();
      if (token) await callTelegramApi(token, 'deleteWebhook');
      const cfg = getBotConfig();
      saveBotConfig({ ...cfg, isWebhookSet: false, webhookUrl: '', lastError: undefined });
      res.json({ success: true });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Failed to delete webhook.' });
    }
  });

  router.get('/telegram/logs', (req: AuthedRequest, res) => {
    const uid = req.activeUser!.id;
    const logs = getTelegramLogs().filter(l => !l.userId || l.userId === uid);
    res.json({ logs });
  });

  router.delete('/telegram/logs', (_req, res) => {
    clearTelegramLogs();
    res.json({ success: true });
  });

  router.post('/telegram/simulate-message', async (req: AuthedRequest, res) => {
    try {
      const user = req.activeUser!;
      const text = String(req.body?.text || '').trim();
      if (!text) {
        res.status(400).json({ error: 'Message text is required.' });
        return;
      }
      const chatId = user.telegramChatId || `sim_${user.id}`;
      const result = await processIncomingTelegramText({
        text,
        chatId,
        senderName: user.name,
        source: 'simulator',
      });
      const store = getUserData(user.id);
      res.json({
        ...result,
        allTransactions: store.transactions,
        summary: computeFinancialSummary(store),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Simulator error.' });
    }
  });

  router.get('/ai/status', (_req, res) => {
    res.json({ configured: isGeminiConfigured(), model: 'gemini-4-hydrogen' });
  });

  router.post('/ai/insights', async (req: AuthedRequest, res) => {
    try {
      const store = getUserData(req.activeUser!.id);
      const month = typeof req.body?.month === 'string' && req.body.month !== 'all' ? req.body.month : getIstDateTime().month;
      const summary = computeFinancialSummary(store, month);
      const insights = await generateFinancialInsights(store, summary, month);
      res.json({ insights });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Unable to generate AI insights.' });
    }
  });

  router.post('/ai/ask', async (req: AuthedRequest, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) {
      res.status(400).json({ error: 'Question is required.' });
      return;
    }
    try {
      const store = getUserData(req.activeUser!.id);
      const summary = computeFinancialSummary(store);
      const result = await askFinancialAdvisor(question, store, summary);
      res.json({ ...result, source: 'gemini' });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Unable to reach AI advisor.' });
    }
  });

  // ---------------- Storage Status ----------------
  router.get('/storage/status', (_req, res) => {
    res.json(getStorageStatus());
  });

  router.post('/storage/sync-now', async (_req, res) => {
    try {
      const ok = await syncAllToPg();
      res.json({ success: ok, ...getStorageStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Storage sync failed.' });
    }
  });

  return router;
}
