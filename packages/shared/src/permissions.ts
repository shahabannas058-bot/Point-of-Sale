import type { Role } from './primitives';

export const PERMISSIONS = [
  'sell',
  'view_catalog',
  'edit_catalog',
  'adjust_stock',
  'receive_stock',
  'receive_khata',
  'view_reports',
  'view_cost',
  'return_void',
  'discount_unlimited',
  'manage_settings',
  'manage_users',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CASHIER: readonly Permission[] = ['sell', 'view_catalog', 'receive_khata'];

const MANAGER: readonly Permission[] = [
  ...CASHIER,
  'edit_catalog',
  'adjust_stock',
  'receive_stock',
  'view_reports',
  'view_cost',
  'return_void',
  'discount_unlimited',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  manager: MANAGER,
  cashier: CASHIER,
};

export const hasPermission = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);
