import { Navigate, createHashRouter } from 'react-router';
import { AppShell, RequireSession } from './components/AppShell';
import { RequireModule } from './components/RequireModule';
import { Billing } from './screens/Billing';
import { CustomerDetail } from './screens/CustomerDetail';
import { CustomerStatement } from './screens/CustomerStatement';
import { Customers } from './screens/Customers';
import { Expiry } from './screens/Expiry';
import { Inventory } from './screens/Inventory';
import { Login } from './screens/Login';
import { PendingUdhaar } from './screens/PendingUdhaar';
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
      { path: 'customers/pending', element: <PendingUdhaar /> },
      { path: 'customers/:id', element: <CustomerDetail /> },
      { path: 'customers/:id/statement', element: <CustomerStatement /> },
      { path: 'suppliers', element: <Suppliers /> },
      { path: 'suppliers/:id', element: <SupplierDetail /> },
      {
        path: 'repairs',
        element: (
          <RequireModule module="repair">
            <Repairs />
          </RequireModule>
        ),
      },
      {
        path: 'repairs/:id',
        element: (
          <RequireModule module="repair">
            <RepairDetail />
          </RequireModule>
        ),
      },
      {
        path: 'warranty',
        element: (
          <RequireModule module="warranty">
            <Warranty />
          </RequireModule>
        ),
      },
      {
        path: 'expiry',
        element: (
          <RequireModule module="batch_expiry">
            <Expiry />
          </RequireModule>
        ),
      },
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
