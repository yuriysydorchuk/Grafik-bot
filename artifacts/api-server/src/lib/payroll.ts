// Polish "umowa zlecenie" payroll estimate.
// Policy (confirmed with owner):
//  • PIT advance = 0 (we don't withhold zaliczka na PIT).
//  • Student under 26 → fully exempt: no ZUS, no health → net = gross, no employer cost.
//  • Otherwise: employee social (pension + disability [+ optional sickness]),
//    then health 9% of (gross − employee social). Net = gross − social − health.
//  • Employer ZUS on top (pension + disability + accident + FP + FGŚP).
// All rates are configurable (stored in settings); the values below are the defaults.

export interface FinanceRates {
  vat: number;          // %  invoice VAT
  eePension: number;    // %  employee pension (emerytalne)
  eeDisability: number; // %  employee disability (rentowe)
  eeSickness: number;   // %  employee sickness (chorobowe, voluntary)
  eeHealth: number;     // %  employee health (zdrowotne)
  erPension: number;    // %  employer pension
  erDisability: number; // %  employer disability
  erAccident: number;   // %  employer accident (wypadkowe)
  erFp: number;         // %  Fundusz Pracy
  erFgsp: number;       // %  FGŚP
  defaultRate: number;  // PLN/hour gross — default for new workers
}

export const DEFAULT_RATES: FinanceRates = {
  vat: 23,
  eePension: 9.76, eeDisability: 1.5, eeSickness: 0, eeHealth: 9,
  erPension: 9.76, erDisability: 6.5, erAccident: 1.67, erFp: 2.45, erFgsp: 0.10,
  defaultRate: 31.5,
};

export interface PayrollResult {
  gross: number;
  eeSocial: number;   // employee ZUS social
  eeHealth: number;   // employee health (NFZ)
  eeTotal: number;    // total employee deductions
  net: number;        // take-home (PIT = 0)
  erTotal: number;    // employer ZUS on top
  laborCost: number;  // gross + employer ZUS — full cost to the agency
}

export function calcPayroll(gross: number, isStudent: boolean, under26: boolean, rates: FinanceRates = DEFAULT_RATES): PayrollResult {
  if (gross <= 0) return { gross: 0, eeSocial: 0, eeHealth: 0, eeTotal: 0, net: 0, erTotal: 0, laborCost: 0 };
  if (isStudent && under26) {
    return { gross, eeSocial: 0, eeHealth: 0, eeTotal: 0, net: gross, erTotal: 0, laborCost: gross };
  }
  const eeSocial = gross * (rates.eePension + rates.eeDisability + rates.eeSickness) / 100;
  const eeHealth = (gross - eeSocial) * rates.eeHealth / 100;
  const eeTotal = eeSocial + eeHealth;
  const net = gross - eeTotal;
  const erTotal = gross * (rates.erPension + rates.erDisability + rates.erAccident + rates.erFp + rates.erFgsp) / 100;
  return { gross, eeSocial, eeHealth, eeTotal, net, erTotal, laborCost: gross + erTotal };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
