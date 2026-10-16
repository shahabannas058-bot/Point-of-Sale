import type { ReactNode } from 'react';
import { RouterProvider } from 'react-router/dom';
import { PrintRoot } from './components/Receipt';
import { Toaster } from './components/ui/Toaster';
import { router } from './router';
import { RuntimeProvider, type AppRuntime } from './service/context';

export function App({ runtime }: { runtime: AppRuntime }): ReactNode {
  return (
    <RuntimeProvider runtime={runtime}>
      <RouterProvider router={router} />
      <PrintRoot />
      <Toaster />
    </RuntimeProvider>
  );
}
