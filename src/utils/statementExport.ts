import * as XLSX from 'xlsx';
import {
  AccountBalanceInfo,
  AccountBalancesData,
  CardEmi,
  SavingsTransfer,
  Transaction,
  UdhaarRecord,
} from '../types';
import { getCurrentIstDate } from './formatters';

function makeUniqueSheetName(raw: string, used: Set<string>): string {
  const cleaned = raw.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet';
  let candidate = cleaned.slice(0, 31);
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${counter})`;
    candidate = `${cleaned.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    counter++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function mapTransactionRow(t: Transaction, accountLabel?: string) {
  const rimSettled = t.isReimbursement ? Number(t.reimbursementSettledAmount || 0) : 0;
  const rimPending = t.isReimbursement ? Math.max(0, Number(t.amount || 0) - rimSettled) : 0;
  return {
    Date: t.date,
    Time: t.time || '',
    Account: accountLabel || t.account || 'AX Bank',
    Type: t.type.toUpperCase(),
    'Amount (INR)': Number(t.amount || 0),
    Category: t.category,
    Description: t.description,
    'Payment Method': t.paymentMethod || '',
    Source: t.source,
    Member: t.telegramUser || '',
    Tags: Array.isArray(t.tags) ? t.tags.join(', ') : '',
    'Reimbursement Status': t.reimbursementStatus || '',
    'Reimbursement Settled (INR)': t.isReimbursement ? rimSettled : '',
    'Reimbursement Pending (INR)': t.isReimbursement ? rimPending : '',
    'Settled In Account': t.settledInAccount || '',
    'Settled Date': t.settledDate || '',
    'CC Settled Card': t.ccSettledCardId || '',
    'Transaction ID': t.id,
  };
}

function buildRowsForAccount(accountId: string, accountLabel: string, txs: Transaction[]) {
  return txs
    .filter(
      t =>
        (t.account || 'AX Bank') === accountId ||
        t.ccSettledCardId === accountId ||
        (accountId === 'Wife' &&
          t.type === 'expense' &&
          (t.isWifeTransfer || t.isSavingsTransfer) &&
          (t.account || 'AX Bank') !== 'Wife')
    )
    .map(t => {
      if (t.ccSettledCardId === accountId && (t.account || 'AX Bank') !== accountId) {
        return {
          ...mapTransactionRow(t, accountLabel),
          Type: 'CARD PAYMENT CREDIT',
          Description: `${t.description} (Paid from ${t.account || 'Bank'})`,
        };
      }
      if (
        accountId === 'Wife' &&
        t.type === 'expense' &&
        (t.isWifeTransfer || t.isSavingsTransfer) &&
        (t.account || 'AX Bank') !== 'Wife'
      ) {
        return {
          ...mapTransactionRow(t, accountLabel),
          Type: 'TRANSFER IN',
          Description: `${t.description} (Received from ${t.account || 'Bank'})`,
        };
      }
      return mapTransactionRow(t, accountLabel);
    });
}

export function exportAccountStatementExcel(accountName: string, transactions: Transaction[]) {
  const sorted = [...transactions].sort(
    (a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
  );
  const filtered = buildRowsForAccount(accountName, accountName, sorted);

  const ws = XLSX.utils.json_to_sheet(
    filtered.length > 0
      ? filtered
      : [{ Date: '', Time: '', Account: accountName, Type: '', 'Amount (INR)': 0, Category: '', Description: 'No transactions found for this account' }]
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Statement');
  const safeName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
  XLSX.writeFile(wb, `statement-${safeName}-${getCurrentIstDate()}.xlsx`);
}

export function exportAllAccountsStatementExcel(
  balances: AccountBalancesData | null,
  transactions: Transaction[],
  emis: CardEmi[] = [],
  savingsTransfers: SavingsTransfer[] = []
) {
  const wb = XLSX.utils.book_new();
  const usedSheets = new Set<string>();
  const accountList: AccountBalanceInfo[] = balances
    ? (Object.values(balances.accounts) as AccountBalanceInfo[])
    : [];

  // 1. Account Summary sheet
  const summaryRows = accountList.map(acc => {
    const isCard = acc.type === 'credit_card' || acc.type === 'rupay_card';
    const limit = isCard ? Number(acc.creditLimit || 100000) : 0;
    const outstanding = isCard ? Number(acc.currentOutstanding || 0) : 0;
    const utilPct = isCard && limit > 0 ? Number(((outstanding / limit) * 100).toFixed(1)) : 0;
    return {
      'Account ID': acc.accountId,
      'Short Label': acc.shortName,
      'Full Name': acc.name,
      Type:
        acc.type === 'rupay_card'
          ? 'RuPay UPI CC'
          : acc.type === 'credit_card'
          ? 'Credit Card'
          : acc.type === 'cash'
          ? 'Cash Wallet'
          : 'Bank Account',
      'Opening / Base (INR)': Number(acc.baseBalance || 0),
      'Total Credits / Repaid (INR)': Number(acc.credits || 0),
      'Total Debits / Spent (INR)': Number(acc.debits || 0),
      'Current Balance (INR)': isCard ? -outstanding : Number(acc.currentBalance || 0),
      'Credit Limit (INR)': isCard ? limit : '',
      'Card Outstanding (INR)': isCard ? outstanding : '',
      'Available Limit (INR)': isCard ? Number(acc.availableLimit ?? Math.max(0, limit - outstanding)) : '',
      'Utilization (%)': isCard ? utilPct : '',
      'Billing Day': isCard && acc.billingDay ? acc.billingDay : '',
      'Due Day': isCard && acc.paymentDueDay ? acc.paymentDueDay : '',
    };
  });

  if (balances) {
    summaryRows.push({
      'Account ID': 'TOTALS',
      'Short Label': 'Combined Summary',
      'Full Name': 'All Banks, Cash & Credit Cards',
      Type: 'Summary',
      'Opening / Base (INR)': accountList
        .filter(a => a.type === 'bank_account' || a.type === 'cash')
        .reduce((s, a) => s + Number(a.baseBalance || 0), 0),
      'Total Credits / Repaid (INR)': accountList.reduce((s, a) => s + Number(a.credits || 0), 0),
      'Total Debits / Spent (INR)': accountList.reduce((s, a) => s + Number(a.debits || 0), 0),
      'Current Balance (INR)': Number(balances.totalBankCashBalance || 0),
      'Credit Limit (INR)': accountList
        .filter(a => a.type === 'credit_card' || a.type === 'rupay_card')
        .reduce((s, a) => s + Number(a.creditLimit || 100000), 0),
      'Card Outstanding (INR)': Number(balances.totalCardOutstanding || 0),
      'Available Limit (INR)': Number(balances.totalCardAvailableLimit || 0),
      'Utilization (%)': '',
      'Billing Day': '',
      'Due Day': '',
    });
    if (!accountList.some(a => a.accountId === 'Wife')) {
      summaryRows.push({
        'Account ID': 'FAMILY_SAVINGS',
        'Short Label': 'Wife / Family Savings',
        'Full Name': 'Accumulated Family Savings Balance',
        Type: 'Family Reserve',
        'Opening / Base (INR)': Number(balances.wifeSavings?.baseBalance || 0),
        'Total Credits / Repaid (INR)': Number(balances.wifeSavings?.totalTransferred || 0),
        'Total Debits / Spent (INR)': 0,
        'Current Balance (INR)': Number(balances.wifeSavings?.currentBalance || 0),
        'Credit Limit (INR)': '',
        'Card Outstanding (INR)': '',
        'Available Limit (INR)': '',
        'Utilization (%)': '',
        'Billing Day': '',
        'Due Day': '',
      });
    }
  }

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      summaryRows.length > 0 ? summaryRows : [{ Info: 'No accounts configured yet' }]
    ),
    makeUniqueSheetName('Account Summary', usedSheets)
  );

  // 2. All Transactions across all accounts
  const sortedTxs = [...transactions].sort(
    (a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
  );
  const allTxRows = sortedTxs.map(t => {
    const accMeta = balances?.accounts?.[t.account || 'AX Bank'];
    return mapTransactionRow(t, accMeta?.shortName || t.account || 'AX Bank');
  });

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      allTxRows.length > 0 ? allTxRows : [{ Info: 'No transactions recorded yet' }]
    ),
    makeUniqueSheetName('All Transactions', usedSheets)
  );

  // 3. Card EMIs sheet (if any)
  if (emis.length > 0) {
    const emiRows = emis.map(e => ({
      'Card ID': e.cardId,
      Title: e.title,
      'Monthly EMI (INR)': Number(e.monthlyAmount || 0),
      'Paid Months': e.paidMonths,
      'Total Months': e.totalMonths,
      'Remaining Months': Math.max(0, e.totalMonths - e.paidMonths),
      'Remaining Amount (INR)': Math.max(0, e.totalMonths - e.paidMonths) * Number(e.monthlyAmount || 0),
      'Due Day': e.dueDay,
      'Start Date': e.startDate,
      Notes: e.notes || '',
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(emiRows),
      makeUniqueSheetName('Card EMIs', usedSheets)
    );
  }

  // 4. Family Transfers sheet (if any)
  if (savingsTransfers.length > 0) {
    const transferRows = savingsTransfers.map(s => ({
      Date: s.date,
      Recipient: s.recipient,
      'From Account': s.fromAccount,
      'Amount (INR)': Number(s.amount || 0),
      Notes: s.notes || '',
    }));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(transferRows),
      makeUniqueSheetName('Family Transfers', usedSheets)
    );
  }

  // 5. Individual sheet per account
  for (const acc of accountList) {
    const accRows = buildRowsForAccount(acc.accountId, acc.shortName, sortedTxs);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        accRows.length > 0
          ? accRows
          : [{ Date: '', Account: acc.shortName, Description: 'No transactions in this account' }]
      ),
      makeUniqueSheetName(acc.shortName || acc.accountId, usedSheets)
    );
  }

  XLSX.writeFile(wb, `all-accounts-statement-${getCurrentIstDate()}.xlsx`);
}

export function exportUdhaarStatementExcel(udhaars: UdhaarRecord[]) {
  const wb = XLSX.utils.book_new();
  const sorted = [...udhaars].sort(
    (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')
  );

  let totalLent = 0;
  let totalLentSettled = 0;
  let totalBorrowed = 0;
  let totalBorrowedSettled = 0;
  let settledCount = 0;
  let activeCount = 0;

  const statementRows = sorted.map(u => {
    const amt = Number(u.amount || 0);
    const settled = Number(u.settledAmount || 0);
    const pending = Math.max(0, amt - settled);
    if (u.type === 'lent') {
      totalLent += amt;
      totalLentSettled += settled;
    } else {
      totalBorrowed += amt;
      totalBorrowedSettled += settled;
    }
    if (u.status === 'settled') settledCount++;
    else activeCount++;

    return {
      Date: u.date,
      Time: u.time || '',
      'Person Name': u.personName,
      Type: u.type === 'lent' ? 'Lent (Diya / Receivable)' : 'Borrowed (Liya / Payable)',
      'Total Amount (INR)': amt,
      'Settled Amount (INR)': settled,
      'Pending Balance (INR)': pending,
      Status: u.status.toUpperCase(),
      Account: u.account || '',
      Description: u.description || '',
      'Settled In Account': u.settledInAccount || '',
      'Settlements Count': (u.settlementHistory || []).length,
      'Last Settled Date': u.settlementHistory?.[0]?.date || (u.settledAt ? u.settledAt.slice(0, 10) : ''),
      'Record ID': u.id,
    };
  });

  const pendingReceivable = Math.max(0, totalLent - totalLentSettled);
  const pendingPayable = Math.max(0, totalBorrowed - totalBorrowedSettled);

  // Sheet 1: Summary
  const summaryRows = [
    { Metric: 'Total Lent (Diya)', 'Amount (INR)': totalLent },
    { Metric: 'Total Lent Recovered', 'Amount (INR)': totalLentSettled },
    { Metric: 'Pending Receivable (You Will Get)', 'Amount (INR)': pendingReceivable },
    { Metric: 'Total Borrowed (Liya)', 'Amount (INR)': totalBorrowed },
    { Metric: 'Total Borrowed Repaid', 'Amount (INR)': totalBorrowedSettled },
    { Metric: 'Pending Payable (You Owe)', 'Amount (INR)': pendingPayable },
    { Metric: 'Net Udhaar Standing (Receivable - Payable)', 'Amount (INR)': pendingReceivable - pendingPayable },
    { Metric: 'Total Entries', 'Amount (INR)': udhaars.length },
    { Metric: 'Active / Pending Entries', 'Amount (INR)': activeCount },
    { Metric: 'Settled Entries', 'Amount (INR)': settledCount },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Udhaar Summary');

  // Sheet 2: Full Udhaar Statement
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      statementRows.length > 0 ? statementRows : [{ Info: 'No Udhaar records logged yet' }]
    ),
    'Udhaar Statement'
  );

  // Sheet 3: Person-wise Summary
  const byPerson = new Map<
    string,
    {
      personName: string;
      lentTotal: number;
      lentSettled: number;
      borrowedTotal: number;
      borrowedSettled: number;
      entries: number;
    }
  >();

  for (const u of sorted) {
    const cleanName = (u.personName || 'Unknown').trim();
    const key = cleanName.toLowerCase();
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        personName: cleanName,
        lentTotal: 0,
        lentSettled: 0,
        borrowedTotal: 0,
        borrowedSettled: 0,
        entries: 0,
      });
    }
    const p = byPerson.get(key)!;
    p.entries++;
    if (u.type === 'lent') {
      p.lentTotal += Number(u.amount || 0);
      p.lentSettled += Number(u.settledAmount || 0);
    } else {
      p.borrowedTotal += Number(u.amount || 0);
      p.borrowedSettled += Number(u.settledAmount || 0);
    }
  }

  const personRows = Array.from(byPerson.values()).map(p => {
    const recPending = Math.max(0, p.lentTotal - p.lentSettled);
    const payPending = Math.max(0, p.borrowedTotal - p.borrowedSettled);
    return {
      'Person Name': p.personName,
      Entries: p.entries,
      'Total Lent (INR)': p.lentTotal,
      'Lent Recovered (INR)': p.lentSettled,
      'Receivable Pending (INR)': recPending,
      'Total Borrowed (INR)': p.borrowedTotal,
      'Borrowed Repaid (INR)': p.borrowedSettled,
      'Payable Pending (INR)': payPending,
      'Net Standing (INR)': recPending - payPending,
    };
  });

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      personRows.length > 0 ? personRows : [{ Info: 'No person-wise records available' }]
    ),
    'Person-wise Summary'
  );

  // Sheet 4: Settlement History
  const settlementRows: Array<Record<string, any>> = [];
  for (const u of sorted) {
    for (const s of u.settlementHistory || []) {
      settlementRows.push({
        'Settlement Date': s.date,
        'Person Name': u.personName,
        'Udhaar Type': u.type === 'lent' ? 'Lent Recovery' : 'Borrowed Repayment',
        'Settled Amount (INR)': Number(s.amount || 0),
        Account: s.account || '',
        Notes: s.notes || '',
        'Linked Tx ID': s.linkedTxId || '',
      });
    }
  }
  settlementRows.sort((a, b) => String(b['Settlement Date'] || '').localeCompare(String(a['Settlement Date'] || '')));

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      settlementRows.length > 0 ? settlementRows : [{ Info: 'No settlements recorded yet' }]
    ),
    'Settlement History'
  );

  XLSX.writeFile(wb, `udhaar-statement-${getCurrentIstDate()}.xlsx`);
}
