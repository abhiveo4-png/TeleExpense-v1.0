import { GoogleGenAI, Type } from '@google/genai';
import { CategoryDef, FinancialSummary, Transaction, UserDataStore } from './types.js';

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  return Boolean((process.env.GEMINI_API_KEY || '').trim());
}

export interface GeminiParsedEntry {
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  account?: string;
  paymentMethod?: 'UPI' | 'Wife' | 'Cash' | 'Card' | 'Net Banking' | 'Bank Transfer' | 'Other';
  isReimbursement?: boolean;
  isSavingsTransfer?: boolean;
  isWifeTransfer?: boolean;
  isCcPayment?: boolean;
  isUdhaarLent?: boolean;
  isUdhaarRecovery?: boolean;
  udhaarPersonName?: string;
  fuelOdometer?: number;
  fuelLiters?: number;
  vehicleName?: string;
}

export async function parseMessageWithGemini(
  text: string,
  categories: CategoryDef[],
  accountNames: string[]
): Promise<GeminiParsedEntry[]> {
  const ai = getGeminiClient();
  const catNames = categories.map(c => `${c.name} (${c.type})`).join(', ');
  const accList = accountNames.join(', ');

  const prompt = `Parse the following Indian personal finance / Hinglish expense or income message into structured transactions.
Message: "${text}"

Available Categories: ${catNames}
Available Accounts: ${accList}

Rules:
- One message may contain multiple items (separated by commas, newlines, or "and"). Return one entry per item.
- "rim", "reimburse", "office claim" => category "Reimbursement", isReimbursement=true.
- If paid FROM/VIA/BY Wife (e.g. "250 coffee wife", "from wife", "wife se"): account="Wife", paymentMethod="Wife", keep the actual expense category (e.g. Food & Dining, Groceries) and do NOT mark isWifeTransfer=true.
- If transferring money TO Wife (e.g. "5000 wife transfer", "sent to wife", "to wife"): category="Wife Transfer", isSavingsTransfer=true, isWifeTransfer=true.
- "cc payment", "card bill" => category "CC Payment", isCcPayment=true.
- "udhaar diya", "lent to X" => category "Udhaar Given", isUdhaarLent=true, udhaarPersonName=X.
- "udhaar wapas", "X returned" => type="income", category "Udhaar Received", isUdhaarRecovery=true, udhaarPersonName=X.
- If fuel/petrol with km/odometer reading is mentioned, extract fuelOdometer (number) and vehicleName if any.
- Always pick the closest Category name from Available Categories.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            type: { type: Type.STRING, description: 'income or expense' },
            amount: { type: Type.NUMBER, description: 'Numeric amount in INR' },
            category: { type: Type.STRING, description: 'Exact matching category name' },
            description: { type: Type.STRING, description: 'Concise clean description without account code' },
            account: { type: Type.STRING, description: 'Matched account name from Available Accounts if mentioned' },
            paymentMethod: { type: Type.STRING, description: 'UPI, Wife, Cash, Card, Net Banking, Bank Transfer, or Other' },
            isReimbursement: { type: Type.BOOLEAN },
            isSavingsTransfer: { type: Type.BOOLEAN },
            isWifeTransfer: { type: Type.BOOLEAN },
            isCcPayment: { type: Type.BOOLEAN },
            isUdhaarLent: { type: Type.BOOLEAN },
            isUdhaarRecovery: { type: Type.BOOLEAN },
            udhaarPersonName: { type: Type.STRING },
            fuelOdometer: { type: Type.NUMBER },
            fuelLiters: { type: Type.NUMBER },
            vehicleName: { type: Type.STRING },
          },
          required: ['type', 'amount', 'category', 'description'],
        },
      },
    },
  });

  const raw = (response.text ?? '[]').trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(e => Number(e.amount) > 0) : [];
}

export async function generateFinancialInsights(
  store: UserDataStore,
  summary: FinancialSummary,
  monthLabel: string
) {
  const ai = getGeminiClient();

  const recentTxs = store.transactions.slice(0, 80).map(t => ({
    date: t.date,
    type: t.type,
    amount: t.amount,
    category: t.category,
    description: t.description,
    reimbursement: Boolean(t.isReimbursement),
  }));

  const prompt = `Analyze this Indian household/personal financial ledger for ${monthLabel} and provide actionable, grounded insights in INR (₹).

Summary Metrics:
- Total Income: ₹${Math.round(summary.totalIncome)}
- Personal Expense: ₹${Math.round(summary.personalExpense)}
- Net Savings: ₹${Math.round(summary.netSavings)} (${summary.savingsRate.toFixed(1)}%)
- Monthly Budget Target: ₹${Math.round(summary.monthlyBudget)}
- Pending Reimbursements: ₹${Math.round(summary.pendingReimbursements)}
- Pending Udhaar Lent: ₹${Math.round(summary.pendingUdhaarBakaya)}

Budgets: ${JSON.stringify(store.budgets.filter(b => b.limit > 0))}
Recent Transactions (up to 80): ${JSON.stringify(recentTxs)}

Identify avoidable discretionary expenses directly from the provided transactions and give realistic monthly/yearly savings potential.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          overview: { type: Type.STRING },
          healthScore: { type: Type.NUMBER },
          verdict: { type: Type.STRING, description: 'Excellent, Good, Needs Attention, or Critical' },
          keyInsights: { type: Type.ARRAY, items: { type: Type.STRING } },
          savingTips: { type: Type.ARRAY, items: { type: Type.STRING } },
          avoidableExpenses: {
            type: Type.OBJECT,
            properties: {
              totalAvoidableAmount: { type: Type.NUMBER },
              percentageOfExpenses: { type: Type.NUMBER },
              potentialMonthlySavings: { type: Type.NUMBER },
              potentialYearlySavings: { type: Type.NUMBER },
              investmentAdvice: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    category: { type: Type.STRING },
                    amount: { type: Type.NUMBER },
                    reason: { type: Type.STRING },
                  },
                  required: ['title', 'category', 'amount', 'reason'],
                },
              },
            },
            required: [
              'totalAvoidableAmount',
              'percentageOfExpenses',
              'potentialMonthlySavings',
              'potentialYearlySavings',
              'investmentAdvice',
              'items',
            ],
          },
        },
        required: ['overview', 'healthScore', 'verdict', 'keyInsights', 'savingTips', 'avoidableExpenses'],
      },
    },
  });

  const text = (response.text ?? '{}').trim();
  return JSON.parse(text);
}

export async function askFinancialAdvisor(
  question: string,
  store: UserDataStore,
  summary: FinancialSummary
): Promise<{ answer: string; model: string }> {
  const ai = getGeminiClient();

  const categoryTotals: Record<string, number> = {};
  for (const tx of store.transactions) {
    if (tx.type === 'expense' && !tx.isReimbursement && !tx.isCcPayment && !tx.isUdhaarLent && !tx.isWifeTransfer) {
      categoryTotals[tx.category] = (categoryTotals[tx.category] || 0) + Number(tx.amount || 0);
    }
  }

  const prompt = `You are a concise, practical personal finance advisor for an Indian household ledger using ₹ (INR).
Answer the user's question directly using only the provided ledger figures.

Ledger Overview:
- Current Month Income: ₹${Math.round(summary.currentMonthIncome)}
- Current Month Personal Spend: ₹${Math.round(summary.currentMonthPersonalExpense)}
- Lifetime Income: ₹${Math.round(summary.totalIncome)}
- Lifetime Personal Spend: ₹${Math.round(summary.personalExpense)}
- Net Savings: ₹${Math.round(summary.netSavings)} (${summary.savingsRate.toFixed(1)}%)
- Pending Reimbursements: ₹${Math.round(summary.pendingReimbursements)}
- Pending Udhaar (To Receive): ₹${Math.round(summary.pendingUdhaarBakaya)}
- Category Totals: ${JSON.stringify(categoryTotals)}
- Recent 35 Transactions: ${JSON.stringify(
    store.transactions.slice(0, 35).map((t: Transaction) => ({
      date: t.date,
      type: t.type,
      amount: t.amount,
      cat: t.category,
      desc: t.description,
      acc: t.account,
    }))
  )}

User Question: ${question}`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
  });

  return {
    answer: (response.text ?? 'Unable to generate a response right now.').trim(),
    model: 'gemini-4-hydrogen',
  };
}
