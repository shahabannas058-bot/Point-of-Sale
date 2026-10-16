import { create } from 'zustand';
import { hasPermission, type Permission, type Session } from '@pos/shared';

interface SessionState {
  session: Session | null;
  set: (s: Session | null) => void;
}

export const useSession = create<SessionState>()((set) => ({
  session: null,
  set: (session) => set({ session }),
}));

/** Reactive permission check for the signed-in user. */
export function useCan(): (p: Permission) => boolean {
  const role = useSession((s) => s.session?.user.role);
  return (p) => (role ? hasPermission(role, p) : false);
}
