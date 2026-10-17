import { Navigate, createHashRouter } from 'react-router';
import { AppShell, RequireSession } from './components/AppShell';
import { Billing } from './screens/Billing';
import { CustomerDetail } from './screens/CustomerDetail';
import { Customers } from './screens/Customers';
import { Inventory } from './screens/Inventory';
import { Login } from './screens/Login';
import { ReceiptPage } from './screens/ReceiptPage';
import { RepairDetail } from './screens/RepairDetail';
import { Repairs } from './screens/Repairs';
import { Reports } from './screens/Reports';
import { Sales } from './screens/Sales';
import { Settings } from './screens/Settings';
import { SupplierDetail } from './screens/SupplierDetail';
import { Suppliers } from './screens/Suppliers';
import { Warranty } from './screens/Warranty';

export const router = createHashRouter([
  { path: '/login', element: <Login /> },
  {
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <Billing /> },
      { path: 'inventory', element: <Inventory /> },
      { path: 'sales', element: <Sales /> },
      { path: 'customers', element: <Customers /> },
      { path: 'customers/:id', element: <CustomerDetail /> },
      { path: 'suppliers', element: <Suppliers /> },
      { path: 'suppliers/:id', element: <SupplierDetail /> },
      { path: 'repairs', element: <Repairs /> },
      { path: 'repairs/:id', element: <RepairDetail /> },
      { path: 'warranty', element: <Warranty /> },
      { path: 'reports', element: <Reports /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
  {
    path: '/receipt/:id',
    element: (
      <RequireSession>
        <ReceiptPage />
      </RequireSession>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
