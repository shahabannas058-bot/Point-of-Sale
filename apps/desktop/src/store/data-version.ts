import { create } from 'zustand';

/** Bumped after every successful write; `useServiceQuery` refetches when it changes. */
export const useDataVersion = create<{ version: number; bump: () => void }>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
