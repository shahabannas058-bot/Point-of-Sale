import {
  ServiceError,
  log,
  type CommitSaleInput,
  type Invoice,
  type ServiceErrorCode,
} from '@pos/shared';

/**
 * React -> C# bridge over the WebView2 message channel.
 *
 *   request : window.chrome.webview.postMessage({ id, method, payload })
 *   reply   : window.chrome.webview 'message' event -> { id, ok, data } | { id, ok: false, error: { code, message, details } }
 *
 * postMessage is fire-and-forget, so every call carries a random id and the reply is matched back to its Promise.
 * Errors come back as a real ServiceError with the SAME code the TypeScript service would have thrown, so the
 * existing `err.<CODE>` translations keep working.
 *
 * A call that times out may still have been executed by C#. For sales this is safe: always send a `saleId`
 * (UUID v7), re-sending the same saleId returns the stored invoice instead of selling twice.
 */
interface WebView2Host {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface Reply {
  id: string;
  ok: boolean;
  data: unknown;
  error: {
    code: ServiceErrorCode;
    message: string;
    details?: Record<string, unknown> | null;
  } | null;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How many timed-out request ids we remember, so a late reply can still be attributed to its method. */
const TIMED_OUT_MEMORY = 100;

const host = (): WebView2Host | undefined =>
  (window as unknown as { chrome?: { webview?: WebView2Host } }).chrome?.webview;

/** True only inside the desktop shell (plain Chrome has window.chrome but no .webview). */
export const isWebView2 = (): boolean => host() !== undefined;

const pending = new Map<string, Pending>();
/** id -> method of calls that already timed out; lets a late reply be logged instead of vanishing. */
const timedOut = new Map<string, string>();
let listening = false;

function rememberTimedOut(id: string, method: string): void {
  timedOut.set(id, method);
  if (timedOut.size > TIMED_OUT_MEMORY) {
    const oldest = timedOut.keys().next().value;
    if (oldest !== undefined) timedOut.delete(oldest);
  }
}

function listen(h: WebView2Host): void {
  if (listening) return;
  listening = true;
  h.addEventListener('message', (event) => {
    const reply = event.data as Reply | null;
    if (reply === null || typeof reply !== 'object' || typeof reply.id !== 'string') return;
    const entry = pending.get(reply.id);
    if (!entry) {
      const method = timedOut.get(reply.id);
      if (method === undefined) return; // not ours
      timedOut.delete(reply.id);
      log.warn('bridge.lateReply', { id: reply.id, method, ok: reply.ok, code: reply.error?.code });
      return;
    }
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.data);
    else {
      const e = reply.error;
      // expected business errors (stock, credentials...) are shown to the user; only host faults are logged
      if (e === undefined || e === null || e.code === 'INTERNAL' || e.code === 'DB_CONSTRAINT')
        log.warn('bridge.error', {
          id: reply.id,
          method: entry.method,
          code: e?.code ?? 'INTERNAL',
          message: e?.message ?? 'Unknown native error',
        });
      entry.reject(
        new ServiceError(
          e?.code ?? 'INTERNAL',
          e?.message ?? 'Unknown native error',
          e?.details ?? {},
        ),
      );
    }
  });
}

export function call<T>(method: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
  const h = host();
  if (!h)
    return Promise.reject(new ServiceError('INTERNAL', 'Not running inside the desktop shell'));
  listen(h);
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rememberTimedOut(id, method);
      log.warn('bridge.timeout', { id, method, timeoutMs });
      reject(new ServiceError('INTERNAL', `Native call "${method}" timed out`, { method }));
    }, timeoutMs);
    pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    h.postMessage({ id, method, payload });
  });
}

/** Typed entry points. Everything else still goes through the TypeScript PosService until it is ported. */
export const posNative = {
  ping: () => call<string>('ping'),
  checkout: {
    /** `input` is the same CommitSaleInput the TS service takes; `cashierId` is the logged-in user. */
    commit: (input: CommitSaleInput, cashierId: string) =>
      call<Invoice>('checkout.commit', { input, cashierId }),
  },
};
