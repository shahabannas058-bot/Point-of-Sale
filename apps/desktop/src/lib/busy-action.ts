import { useState } from 'react';

/** A gate that lets one asynchronous run through at a time. */
export interface SingleFlight {
  /** True while a run is pending. */
  isBusy: () => boolean;
  /**
   * Runs `fn` unless an earlier run is still pending, in which case the call is dropped and resolves to false.
   * Resolves to true once `fn` has completed; an error from `fn` is rethrown after the gate has re-armed.
   */
  run: (fn: () => Promise<void>) => Promise<boolean>;
}

/**
 * The guard behind useBusyAction, kept free of React so it can be unit-tested: `pending` is a plain variable
 * checked synchronously, so two calls in the same tick (a held Enter key, a double click) cannot both pass.
 * `onBusy` is told when a run starts and when it settles.
 */
export function singleFlight(onBusy?: (busy: boolean) => void): SingleFlight {
  let pending = false;
  return {
    isBusy: () => pending,
    async run(fn) {
      if (pending) return false;
      pending = true;
      onBusy?.(true);
      try {
        await fn();
        return true;
      } finally {
        pending = false;
        onBusy?.(false);
      }
    },
  };
}

/**
 * One request at a time for a dialog's Save: `run` starts `action` unless an earlier run is still pending, so Enter
 * auto-repeat or a double click never posts a stock adjustment or a khata payment twice. `busy` is the matching
 * state for the spinner and for disabling the form; it clears when the action settles, resolved or thrown.
 * The action should handle its own errors (set an error message); anything it throws is rethrown by `run`.
 */
export function useBusyAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
): { busy: boolean; run: (...args: Args) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [gate] = useState(() => singleFlight(setBusy));
  const run = async (...args: Args): Promise<void> => {
    await gate.run(() => action(...args));
  };
  return { busy, run };
}
