import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { BotConfig, TelegramLog, UserDataStore, UserProfile } from './types.js';
import { DEFAULT_BUDGETS, DEFAULT_CATEGORIES, getIstDateTime } from './defaults.js';

const { Pool } = pg;

export const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.PERSISTENT_DATA_DIR ||
  path.join(process.cwd(), '.data');
const USERS_DIR = path.join(DATA_DIR, 'users');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');
const LOGS_FILE = path.join(DATA_DIR, 'telegram_logs.json');
const ACTIVE_ACCOUNTS_FILE = path.join(DATA_DIR, 'active_accounts.json');
const AI_ADVISOR_MODE_FILE = path.join(DATA_DIR, 'ai_advisor_mode.json');

let pgPool: pg.Pool | null = null;
let isPgConnected = false;

const rawDbUrl =
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING ||
  process.env.POSTGRES_URL ||
  '';

if (rawDbUrl.trim()) {
  try {
    const isLocal = rawDbUrl.includes('localhost') || rawDbUrl.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: rawDbUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    });
    pgPool.on('error', (err) => {
      console.error('[Storage] Idle PostgreSQL client error:', err?.message || err);
    });
  } catch (err) {
    console.error('[Storage] Failed to initialize PostgreSQL pool:', err);
    pgPool = null;
  }
}

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    }
  } catch (err) {
    console.error(`[Storage] Error reading ${path.basename(filePath)}:`, err);
  }
  return fallback;
}

function saveJson<T>(filePath: string, data: T): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[Storage] Error writing ${path.basename(filePath)}:`, err);
  }
}

function getSafeUserFilePath(userId: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized) throw new Error('Invalid user id');
  const resolved = path.resolve(USERS_DIR, `${sanitized}.json`);
  if (!resolved.startsWith(path.resolve(USERS_DIR) + path.sep)) {
    throw new Error('Invalid storage path');
  }
  return resolved;
}

async function persistToPg(key: string, data: unknown): Promise<void> {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO teleexpense_store (key, data, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE
       SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(data)]
    );
  } catch (err: any) {
    console.error(`[Storage] Postgres write failed (${key}):`, err?.message || err);
  }
}

export function generateLinkCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function getEnvBotToken(): string {
  const candidates = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.BOT_TOKEN,
    process.env.TELEGRAM_TOKEN,
    process.env.TG_BOT_TOKEN,
  ];
  for (const val of candidates) {
    if (val) {
      const cleaned = val.trim().replace(/^["']|["']$/g, '').trim();
      if (cleaned) return cleaned;
    }
  }
  return '';
}

let users: UserProfile[] = loadJson<UserProfile[]>(USERS_FILE, []);
let telegramLogs: TelegramLog[] = loadJson<TelegramLog[]>(LOGS_FILE, []);
let chatActiveAccounts: Record<string, string> = loadJson<Record<string, string>>(ACTIVE_ACCOUNTS_FILE, {});
let chatAiAdvisorMode: Record<string, boolean> = loadJson<Record<string, boolean>>(AI_ADVISOR_MODE_FILE, {});
let botConfig: BotConfig = loadJson<BotConfig>(BOT_CONFIG_FILE, {
  botToken: '',
  isWebhookSet: false,
  isConnected: false,
  botUsername: '',
  botName: '',
});

const envToken = getEnvBotToken();
if (envToken) {
  botConfig.botToken = envToken;
  botConfig.isConnected = true;
}

if (users.length === 0) {
  users.push({
    id: 'user_ansh',
    name: 'Ansh',
    email: 'ansh@teleexpense.ai',
    linkedMembers: [],
    pendingRequests: [],
    linkCode: '838107',
    createdAt: new Date().toISOString(),
    trackingStartMonth: getIstDateTime().month,
  });
  saveJson(USERS_FILE, users);
}

const userDataCache = new Map<string, UserDataStore>();

export function syncBudgetsWithCategories(store: UserDataStore): boolean {
  let changed = false;
  if (!Array.isArray(store.categories) || store.categories.length === 0) {
    store.categories = DEFAULT_CATEGORIES.map(c => ({ ...c }));
    changed = true;
  }
  if (!Array.isArray(store.budgets)) {
    store.budgets = [];
    changed = true;
  }
  if (!Array.isArray(store.deletedCategories)) {
    store.deletedCategories = [];
  }

  const deletedSet = new Set(store.deletedCategories.map(d => d.toLowerCase()));
  for (const def of DEFAULT_CATEGORIES) {
    if (deletedSet.has(def.id.toLowerCase()) || deletedSet.has(def.name.toLowerCase())) continue;
    const found = store.categories.find(
      c => c.id === def.id || c.name.toLowerCase() === def.name.toLowerCase()
    );
    if (!found) {
      store.categories.push({ ...def });
      changed = true;
    } else if (def.excludeFromBudget !== undefined && found.excludeFromBudget === undefined) {
      found.excludeFromBudget = def.excludeFromBudget;
      changed = true;
    }
  }

  const budgetable = store.categories.filter(c => c.type === 'expense' || c.type === 'both');
  for (const cat of budgetable) {
    const existing = store.budgets.find(b => b.category.toLowerCase() === cat.name.toLowerCase());
    if (!existing) {
      const defLimit =
        DEFAULT_BUDGETS.find(db => db.category.toLowerCase() === cat.name.toLowerCase())?.limit ?? 0;
      store.budgets.push({ category: cat.name, limit: defLimit, period: 'monthly' });
      changed = true;
    } else if (existing.category !== cat.name) {
      existing.category = cat.name;
      changed = true;
    }
  }

  const validNames = new Set(store.categories.map(c => c.name.toLowerCase()));
  const beforeLen = store.budgets.length;
  store.budgets = store.budgets.filter(b => validNames.has(b.category.toLowerCase()));
  if (store.budgets.length !== beforeLen) changed = true;

  return changed;
}

function normalizeUserStore(raw: Partial<UserDataStore>): UserDataStore {
  const store: UserDataStore = {
    transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    budgets: Array.isArray(raw.budgets) ? raw.budgets : DEFAULT_BUDGETS.map(b => ({ ...b })),
    categories: Array.isArray(raw.categories) && raw.categories.length > 0
      ? raw.categories
      : DEFAULT_CATEGORIES.map(c => ({ ...c })),
    udhaars: Array.isArray(raw.udhaars) ? raw.udhaars : [],
    cardEmis: Array.isArray(raw.cardEmis) ? raw.cardEmis : [],
    savingsTransfers: Array.isArray(raw.savingsTransfers) ? raw.savingsTransfers : [],
    investments: Array.isArray(raw.investments) ? raw.investments : [],
    fuelLogs: Array.isArray(raw.fuelLogs) ? raw.fuelLogs : [],
    dailyItemLimits: Array.isArray(raw.dailyItemLimits) ? raw.dailyItemLimits : [],
    piggyBankFunds: Array.isArray(raw.piggyBankFunds) ? raw.piggyBankFunds : [],
    piggyBankTransactions: Array.isArray(raw.piggyBankTransactions) ? raw.piggyBankTransactions : [],
    collectedSurplusMonths: Array.isArray(raw.collectedSurplusMonths) ? raw.collectedSurplusMonths : [],
    dataVersion: typeof raw.dataVersion === 'number' ? raw.dataVersion : 1,
    accountBaseBalances: raw.accountBaseBalances && typeof raw.accountBaseBalances === 'object' ? raw.accountBaseBalances : {},
    accountBalanceSetTimestamps: raw.accountBalanceSetTimestamps && typeof raw.accountBalanceSetTimestamps === 'object' ? raw.accountBalanceSetTimestamps : {},
    wifeBaseBalance: typeof raw.wifeBaseBalance === 'number' ? raw.wifeBaseBalance : 0,
    wifeBalanceSetTimestamp: raw.wifeBalanceSetTimestamp,
    cardCreditLimits: raw.cardCreditLimits && typeof raw.cardCreditLimits === 'object' ? raw.cardCreditLimits : {},
    customAccounts: Array.isArray(raw.customAccounts) ? raw.customAccounts : [],
    deletedCategories: Array.isArray(raw.deletedCategories) ? raw.deletedCategories : [],
  };
  return store;
}

export function getUsers(): UserProfile[] {
  return users;
}

export function saveUsers(nextUsers: UserProfile[]): void {
  users = nextUsers;
  saveJson(USERS_FILE, users);
  persistToPg('users', users).catch(() => {});
}

export function getUserById(userId: string): UserProfile | undefined {
  return users.find(u => u.id === userId);
}

export function getUserData(userId: string): UserDataStore {
  if (userDataCache.has(userId)) {
    return userDataCache.get(userId)!;
  }
  const filePath = getSafeUserFilePath(userId);
  const raw = loadJson<Partial<UserDataStore>>(filePath, {});
  const store = normalizeUserStore(raw);
  const changed = syncBudgetsWithCategories(store);
  if (changed || !fs.existsSync(filePath)) {
    saveJson(filePath, store);
    persistToPg(`user_data:${userId}`, store).catch(() => {});
  }
  userDataCache.set(userId, store);
  return store;
}

export function saveUserData(userId: string, store: UserDataStore): void {
  store.dataVersion = (store.dataVersion || 1) + 1;
  userDataCache.set(userId, store);
  const filePath = getSafeUserFilePath(userId);
  saveJson(filePath, store);
  persistToPg(`user_data:${userId}`, store).catch(() => {});
}

export function deleteUserStore(userId: string): void {
  userDataCache.delete(userId);
  const filePath = getSafeUserFilePath(userId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (pgPool) {
    pgPool.query('DELETE FROM teleexpense_store WHERE key = $1', [`user_data:${userId}`]).catch(() => {});
  }
}

export function getBotConfig(): BotConfig {
  const token = getEnvBotToken();
  if (token && botConfig.botToken !== token) {
    botConfig.botToken = token;
    botConfig.isConnected = true;
  }
  return botConfig;
}

export function getActiveBotToken(): string {
  const envTok = getEnvBotToken();
  if (envTok) return envTok;
  return (botConfig.botToken || '').trim();
}

export function saveBotConfig(next: BotConfig): void {
  botConfig = next;
  saveJson(BOT_CONFIG_FILE, botConfig);
  persistToPg('bot_config', botConfig).catch(() => {});
}

export function getTelegramLogs(): TelegramLog[] {
  return telegramLogs;
}

export function addTelegramLog(entry: Omit<TelegramLog, 'id' | 'timestamp'>): void {
  const log: TelegramLog = {
    ...entry,
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
  };
  telegramLogs = [log, ...telegramLogs].slice(0, 200);
  saveJson(LOGS_FILE, telegramLogs);
  persistToPg('telegram_logs', telegramLogs).catch(() => {});
}

export function clearTelegramLogs(): void {
  telegramLogs = [];
  saveJson(LOGS_FILE, telegramLogs);
  persistToPg('telegram_logs', telegramLogs).catch(() => {});
}

export function getActiveAccountsMap(): Record<string, string> {
  return chatActiveAccounts;
}

export function setActiveAccountForChat(chatId: string | number, userId: string): void {
  const key = String(chatId).trim();
  if (!key) return;
  chatActiveAccounts[key] = userId;
  saveJson(ACTIVE_ACCOUNTS_FILE, chatActiveAccounts);
  persistToPg('active_accounts', chatActiveAccounts).catch(() => {});
}

export function isChatInAiAdvisorMode(chatId: string | number): boolean {
  return Boolean(chatAiAdvisorMode[String(chatId).trim()]);
}

export function setChatAiAdvisorMode(chatId: string | number, enabled: boolean): void {
  const key = String(chatId).trim();
  if (!key) return;
  if (enabled) chatAiAdvisorMode[key] = true;
  else delete chatAiAdvisorMode[key];
  saveJson(AI_ADVISOR_MODE_FILE, chatAiAdvisorMode);
  persistToPg('ai_advisor_mode', chatAiAdvisorMode).catch(() => {});
}

export async function initDatabase(): Promise<boolean> {
  if (!pgPool) {
    console.log(`[Storage] Using local persistent storage at ${DATA_DIR}`);
    return false;
  }
  try {
    const client = await pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS teleexpense_store (
          key VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      isPgConnected = true;
      const res = await client.query('SELECT key, data FROM teleexpense_store');
      if (res.rows.length === 0) {
        await persistToPg('users', users);
        await persistToPg('bot_config', botConfig);
        await persistToPg('telegram_logs', telegramLogs);
        await persistToPg('active_accounts', chatActiveAccounts);
        for (const u of users) {
          await persistToPg(`user_data:${u.id}`, getUserData(u.id));
        }
      } else {
        for (const row of res.rows) {
          if (row.key === 'users' && Array.isArray(row.data) && row.data.length > 0) {
            users = row.data;
            saveJson(USERS_FILE, users);
          } else if (row.key === 'bot_config' && row.data) {
            botConfig = { ...botConfig, ...row.data };
            if (getEnvBotToken()) {
              botConfig.botToken = getEnvBotToken();
              botConfig.isConnected = true;
            }
            saveJson(BOT_CONFIG_FILE, botConfig);
          } else if (row.key === 'telegram_logs' && Array.isArray(row.data)) {
            telegramLogs = row.data;
            saveJson(LOGS_FILE, telegramLogs);
          } else if (row.key === 'active_accounts' && row.data) {
            chatActiveAccounts = row.data;
            saveJson(ACTIVE_ACCOUNTS_FILE, chatActiveAccounts);
          } else if (row.key === 'ai_advisor_mode' && row.data) {
            chatAiAdvisorMode = row.data;
            saveJson(AI_ADVISOR_MODE_FILE, chatAiAdvisorMode);
          } else if (typeof row.key === 'string' && row.key.startsWith('user_data:') && row.data) {
            const uid = row.key.slice('user_data:'.length);
            const normalized = normalizeUserStore(row.data);
            userDataCache.set(uid, normalized);
            saveJson(getSafeUserFilePath(uid), normalized);
          }
        }
      }
      return true;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[Storage] PostgreSQL connection failed, falling back to local disk:', err?.message);
    isPgConnected = false;
    return false;
  }
}

export async function syncAllToPg(): Promise<boolean> {
  if (!pgPool || !isPgConnected) return false;
  await persistToPg('users', users);
  await persistToPg('bot_config', botConfig);
  await persistToPg('telegram_logs', telegramLogs);
  await persistToPg('active_accounts', chatActiveAccounts);
  for (const u of users) {
    await persistToPg(`user_data:${u.id}`, getUserData(u.id));
  }
  return true;
}

export function getStorageStatus() {
  return {
    engine: isPgConnected ? 'postgresql' : 'local_disk',
    isPgConnected,
    dataDir: DATA_DIR,
    userCount: users.length,
  };
}
