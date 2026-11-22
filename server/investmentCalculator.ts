import type { InvestmentRecord } from './types.js';

export interface InvestmentMetrics {
  monthlyAmount: number;
  paidInstallments: number;
  totalInstallments: number;
  tenureMonths: number;
  tenureDays: number;
  tenureLabel: string;
  depositedPrincipal: number;
  accruedInterest: number;
  currentValue: number;
  gainAmount: number;
  absoluteRoiPercent: number;
  effectiveAnnualRoiPercent: number;
  maturityPrincipal: number;
  maturityInterest: number;
  maturityAmount: number;
  isRecurring: boolean;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function parseSafeDate(dateStr?: string): Date {
  if (!dateStr) return new Date();
  const normalized = dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function computeTenureBetweenDates(
  startDateStr?: string,
  maturityDateStr?: string
): { tenureMonths: number; tenureDays: number } | null {
  if (!startDateStr || !maturityDateStr) return null;
  const start = parseSafeDate(startDateStr);
  const end = parseSafeDate(maturityDateStr);
  if (end.getTime() <= start.getTime()) return null;

  const tenureDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
  const diffY = end.getFullYear() - start.getFullYear();
  const diffM = end.getMonth() - start.getMonth();
  const diffD = end.getDate() - start.getDate();
  const rawMonths = diffY * 12 + diffM + (diffD >= 15 ? 1 : diffD <= -15 ? -1 : 0);
  const tenureMonths = tenureDays < 25 ? 0 : Math.max(1, rawMonths);
  return { tenureMonths, tenureDays };
}

function formatTenureLabel(tenureMonths: number, tenureDays: number): string {
  if (tenureMonths <= 0) return tenureDays > 0 ? `${tenureDays}d` : '';
  if (tenureMonths >= 12) {
    const yrs = Math.floor(tenureMonths / 12);
    const remM = tenureMonths % 12;
    return remM > 0 ? `${yrs}y ${remM}m` : `${yrs}y`;
  }
  return `${tenureMonths}m`;
}

function usesAnnualCagr(type: InvestmentRecord['type'] | string): boolean {
  return type === 'Mutual Fund' || type === 'Gold' || type === 'Other';
}

function computeCompoundInterest(
  principal: number,
  annualRatePercent: number,
  years: number,
  type: InvestmentRecord['type'] | string
): number {
  if (principal <= 0 || annualRatePercent <= 0 || years <= 0) return 0;
  if (usesAnnualCagr(type)) {
    return principal * (Math.pow(1 + annualRatePercent / 100, years) - 1);
  }
  const quarterlyRate = annualRatePercent / 100 / 4;
  return principal * (Math.pow(1 + quarterlyRate, 4 * years) - 1);
}

export function calculateInvestmentMetrics(
  inv: Partial<InvestmentRecord>,
  asOfDateStr?: string
): InvestmentMetrics {
  const type = inv.type || 'Mutual Fund';
  const monthlyInput = Number(inv.monthlyAmount || 0);
  const lumpInput = Number(inv.amount || 0);
  const freqMultiplier =
    inv.installmentFrequency === 'yearly'
      ? 12
      : inv.installmentFrequency === 'quarterly'
      ? 3
      : 1;

  const rate = Number(inv.interestRate) || 0;
  const startDate = parseSafeDate(inv.date);
  const asOfDate = parseSafeDate(asOfDateStr);
  const rawDiffMs = Math.max(0, asOfDate.getTime() - startDate.getTime());

  const dateDerivedTenure = computeTenureBetweenDates(inv.date, inv.maturityDate);
  const legacyTenureMonths =
    !dateDerivedTenure && Number(inv.totalInstallments || 0) > 0
      ? Math.round(Number(inv.totalInstallments) * freqMultiplier)
      : 0;
  const tenureMonths = dateDerivedTenure ? dateDerivedTenure.tenureMonths : legacyTenureMonths;
  const tenureDays = dateDerivedTenure
    ? dateDerivedTenure.tenureDays
    : legacyTenureMonths > 0
    ? Math.round(legacyTenureMonths * 30.4375)
    : 0;
  const tenureLabel = formatTenureLabel(tenureMonths, tenureDays);

  const matDateObj = inv.maturityDate ? parseSafeDate(inv.maturityDate) : null;
  const effectiveElapsedMs =
    dateDerivedTenure && inv.maturityDate
      ? Math.min(rawDiffMs, dateDerivedTenure.tenureDays * MS_PER_DAY)
      : rawDiffMs;
  const yearsFromStart = effectiveElapsedMs / (MS_PER_DAY * 365.25);

  const isRecurring =
    monthlyInput > 0 ||
    Boolean(inv.autoDebitEnabled) ||
    (type === 'RD' && (Number(inv.totalInstallments || 0) > 1 || tenureMonths > 1));

  const hasManualCurrentValue =
    inv.currentValue !== undefined &&
    inv.currentValue !== null &&
    Number.isFinite(Number(inv.currentValue)) &&
    Number(inv.currentValue) > 0;

  if (isRecurring) {
    const monthlyAmt = monthlyInput > 0 ? monthlyInput : lumpInput;

    let totalInstallments = dateDerivedTenure
      ? Math.max(1, Math.round(Math.max(1, dateDerivedTenure.tenureMonths) / freqMultiplier))
      : Number(inv.totalInstallments) || 0;
    if (!totalInstallments) totalInstallments = 12;

    const cappedAsOf =
      dateDerivedTenure && matDateObj && asOfDate.getTime() > matDateObj.getTime()
        ? matDateObj
        : asOfDate;
    const startY = startDate.getFullYear();
    const startM = startDate.getMonth();
    const startD = startDate.getDate();
    const curY = cappedAsOf.getFullYear();
    const curM = cappedAsOf.getMonth();
    const curD = cappedAsOf.getDate();

    let monthsElapsed = (curY - startY) * 12 + (curM - startM);
    if (curD >= startD) monthsElapsed += 1;
    monthsElapsed = Math.max(0, monthsElapsed);

    let paidCount = Number(inv.paidInstallments || 0);
    if (paidCount <= 0) {
      if (lumpInput > 0 && monthlyAmt > 0) {
        paidCount = Math.max(1, Math.round(lumpInput / monthlyAmt));
      } else {
        paidCount = Math.max(
          1,
          Math.min(totalInstallments, Math.ceil(Math.max(1, monthsElapsed) / freqMultiplier))
        );
      }
    }

    const depositedPrincipal = lumpInput > 0 ? lumpInput : paidCount * monthlyAmt;

    let accruedInterest = 0;
    if (rate > 0 && depositedPrincipal > 0) {
      const effectiveSteps = Math.max(1, paidCount);
      const stepAmount = depositedPrincipal / effectiveSteps;
      for (let i = 1; i <= effectiveSteps; i++) {
        const installmentAgeMonths =
          effectiveSteps === 1 && monthsElapsed > freqMultiplier
            ? monthsElapsed
            : (effectiveSteps - i + 1) * freqMultiplier;
        accruedInterest += computeCompoundInterest(
          stepAmount,
          rate,
          installmentAgeMonths / 12,
          type
        );
      }
    }
    accruedInterest = Math.round(accruedInterest);

    const autoCurrentValue = Math.round(depositedPrincipal + accruedInterest);
    const currentValue = hasManualCurrentValue
      ? Number(inv.currentValue)
      : autoCurrentValue;
    const gainAmount = Math.round(currentValue - depositedPrincipal);
    const absoluteRoiPercent =
      depositedPrincipal > 0
        ? Number(((gainAmount / depositedPrincipal) * 100).toFixed(2))
        : 0;

    let effectiveAnnualRoiPercent = rate;
    if (rate <= 0 && hasManualCurrentValue && depositedPrincipal > 0) {
      const avgYearsHeld = Math.max(
        1 / 12,
        yearsFromStart > 0 ? yearsFromStart / 1.8 : (paidCount * freqMultiplier) / 24
      );
      effectiveAnnualRoiPercent = Number(
        ((Math.pow(currentValue / depositedPrincipal, 1 / avgYearsHeld) - 1) * 100).toFixed(2)
      );
    }

    const effectiveTotal = Math.max(totalInstallments, paidCount);
    const remainingSteps = Math.max(0, effectiveTotal - paidCount);
    const maturityPrincipal = depositedPrincipal + remainingSteps * monthlyAmt;
    let maturityInterest = 0;
    const projectionRate = rate > 0 ? rate : Math.max(0, effectiveAnnualRoiPercent);
    if (projectionRate > 0 && monthlyAmt > 0) {
      for (let i = 1; i <= effectiveTotal; i++) {
        const monthsHeld = (effectiveTotal - i + 1) * freqMultiplier;
        maturityInterest += computeCompoundInterest(
          monthlyAmt,
          projectionRate,
          monthsHeld / 12,
          type
        );
      }
      const baseExpectedPrincipal = effectiveTotal * monthlyAmt;
      if (baseExpectedPrincipal > 0 && maturityPrincipal !== baseExpectedPrincipal) {
        maturityInterest *= maturityPrincipal / baseExpectedPrincipal;
      }
    }
    maturityInterest = Math.round(maturityInterest);
    const maturityAmount =
      Number(inv.maturityAmount) > 0
        ? Number(inv.maturityAmount)
        : Math.round(maturityPrincipal + maturityInterest);

    return {
      monthlyAmount: monthlyAmt,
      paidInstallments: paidCount,
      totalInstallments: effectiveTotal,
      tenureMonths: tenureMonths || effectiveTotal * freqMultiplier,
      tenureDays: tenureDays || Math.round(effectiveTotal * freqMultiplier * 30.4375),
      tenureLabel: tenureLabel || formatTenureLabel(effectiveTotal * freqMultiplier, 0),
      depositedPrincipal,
      accruedInterest: gainAmount,
      currentValue,
      gainAmount,
      absoluteRoiPercent,
      effectiveAnnualRoiPercent,
      maturityPrincipal,
      maturityInterest,
      maturityAmount,
      isRecurring: true,
    };
  }

  const principal = lumpInput;
  const accruedInterest =
    rate > 0 && principal > 0 && inv.date
      ? Math.round(computeCompoundInterest(principal, rate, yearsFromStart, type))
      : 0;

  const autoCurrentValue = principal + accruedInterest;
  const currentValue = hasManualCurrentValue
    ? Number(inv.currentValue)
    : autoCurrentValue;
  const gainAmount = Math.round(currentValue - principal);
  const absoluteRoiPercent =
    principal > 0 ? Number(((gainAmount / principal) * 100).toFixed(2)) : 0;

  let effectiveAnnualRoiPercent = rate;
  if (rate <= 0 && hasManualCurrentValue && principal > 0) {
    const effectiveYears = Math.max(1 / 12, yearsFromStart);
    effectiveAnnualRoiPercent = Number(
      ((Math.pow(currentValue / principal, 1 / effectiveYears) - 1) * 100).toFixed(2)
    );
  }

  let maturityInterest = accruedInterest;
  let maturityAmount = currentValue;
  const projRate = rate > 0 ? rate : Math.max(0, effectiveAnnualRoiPercent);
  if (dateDerivedTenure && projRate > 0 && principal > 0) {
    maturityInterest = Math.round(
      computeCompoundInterest(principal, projRate, dateDerivedTenure.tenureDays / 365.25, type)
    );
    maturityAmount = principal + maturityInterest;
  } else if (legacyTenureMonths > 0 && projRate > 0 && principal > 0) {
    maturityInterest = Math.round(
      computeCompoundInterest(principal, projRate, legacyTenureMonths / 12, type)
    );
    maturityAmount = principal + maturityInterest;
  } else if (rate > 0 && principal > 0) {
    maturityInterest = Math.round(computeCompoundInterest(principal, rate, 1, type));
    maturityAmount = principal + maturityInterest;
  }

  if (Number(inv.maturityAmount) > 0) {
    maturityAmount = Number(inv.maturityAmount);
    maturityInterest = Math.round(maturityAmount - principal);
  }

  return {
    monthlyAmount: 0,
    paidInstallments: 1,
    totalInstallments: tenureMonths > 0 ? tenureMonths : 1,
    tenureMonths,
    tenureDays,
    tenureLabel,
    depositedPrincipal: principal,
    accruedInterest: gainAmount,
    currentValue,
    gainAmount,
    absoluteRoiPercent,
    effectiveAnnualRoiPercent,
    maturityPrincipal: principal,
    maturityInterest,
    maturityAmount,
    isRecurring: false,
  };
}
