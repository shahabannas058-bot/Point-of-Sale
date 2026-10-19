import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../src/lib/busy-action';

/** A promise the test resolves or rejects by hand, to hold a run "in flight". */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight: one request at a time', () => {
  it('runs the action and reports busy only while it is pending', async () => {
    // Arrange
    const onBusy = vi.fn();
    const gate = singleFlight(onBusy);
    const d = deferred();

    // Act
    const ran = gate.run(() => d.promise);

    // Assert
    expect(gate.isBusy()).toBe(true);
    expect(onBusy).toHaveBeenLastCalledWith(true);
    d.resolve();
    await expect(ran).resolves.toBe(true);
    expect(gate.isBusy()).toBe(false);
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(onBusy).toHaveBeenCalledTimes(2);
  });

  it('drops a second call while the first is pending (Enter auto-repeat, double click)', async () => {
    // Arrange
    const gate = singleFlight();
    const d = deferred();
    const action = vi.fn(() => d.promise);

    // Act: two calls in the same tick, before anything settles
    const first = gate.run(action);
    const second = gate.run(action);
    const third = gate.run(action);

    // Assert
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    d.resolve();
    await expect(first).resolves.toBe(true);
  });

  it('accepts a new run once the previous one has settled', async () => {
    const gate = singleFlight();
    const action = vi.fn(() => Promise.resolve());

    await gate.run(action);
    await gate.run(action);

    expect(action).toHaveBeenCalledTimes(2);
  });

  it('re-arms after the action throws, and lets the error through', async () => {
    // Arrange
    const onBusy = vi.fn();
    const gate = singleFlight(onBusy);
    const boom = new Error('db locked');

    // Act / Assert
    await expect(gate.run(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(gate.isBusy()).toBe(false);
    expect(onBusy).toHaveBeenLastCalledWith(false);

    const action = vi.fn(() => Promise.resolve());
    await expect(gate.run(action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('a synchronous throw inside the action also re-arms the gate', async () => {
    const gate = singleFlight();
    await expect(
      gate.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(gate.isBusy()).toBe(false);
  });
});
