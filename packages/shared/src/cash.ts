import { z } from 'zod';
import type { Paisa } from './primitives';

/** expense = shop spending (needs a category); cash_in / cash_out = money put into or taken out of the drawer. */
export const CASH_ENTRY_TYPES = ['expense', 'cash_in', 'cash_out'] as const;
export const CashEntryTypeSchema = z.enum(CASH_ENTRY_TYPES);
export type CashEntryType = z.infer<typeof CashEntryTypeSchema>;

export const EXPENSE_CATEGORIES = [
  'rent',
  'salary',
  'bills',
  'tea_food',
  'transport',
  'maintenance',
  'other',
] as const;
export const ExpenseCategorySchema = z.enum(EXPENSE_CATEGORIES);
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

/** Append-only. A mistake is cancelled by a reversal: the same entry with a negative amount and `reversesId`. */
export interface CashEntry {
  id: string;
  branchId: string;
  type: CashEntryType;
  category: ExpenseCategory | null; // set exactly when type = 'expense'
  amount: Paisa; // > 0, or < 0 for a reversal
  note: string | null;
  reversesId: string | null;
  createdBy: string;
  createdAt: number;
}

/** Where the drawer's cash came from and went to in one period. All amounts are positive magnitudes except repairCash. */
export interface DrawerBreakdown {
  opening: Paisa; // what the previous close left in the drawer
  cashSales: Paisa; // cash taken on sale invoices
  cashRefunds: Paisa; // cash given back on returns / voids
  udhaarCollected: Paisa; // customers paying their udhaar in cash
  supplierPaid: Paisa; // cash paid to suppliers (pay now on a purchase, or a later payment)
  repairCash: Paisa; // signed: repair advances and balances minus repair refunds
  expenses: Paisa; // net of reversals
  cashIn: Paisa;
  cashOut: Paisa;
  /** opening + cashSales - cashRefunds + udhaarCollected - supplierPaid + repairCash - expenses + cashIn - cashOut */
  expected: Paisa;
}
