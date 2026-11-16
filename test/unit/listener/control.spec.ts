import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  ListenerControl,
  serve,
  type ControlDeps,
} from '../../../src/listener/control.js';
import { DRAINING, type DrainStatus } from '../../../src/listener/drain.js';
import { listenerStatusSchema } from '../../../src/listener/status.js';

// The loopback server on an ephemeral port, as `anycloud exec` reaches it.
async function listen(control: ListenerControl) {
  const server = serve(control, 0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
    });
    return { code: response.status, body: (await response.json()) as unknown };
  };
  return { call, close: () => server.close() };
}

// Until `signal` aborts, as the installation wait does.
const waitForever = (signal: AbortSignal) =>
  new Promise<void>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted'))),
  );

const OUTAGE = { since: '2026-11-04T12:40:00.000Z', error: 'Error: 503' };

const LOST = {
  since: '2026-11-04T12:40:00.000Z',
  installUrl: 'https://github.com/apps/backmesh/installations/new',
};

const controlDeps = (): ControlDeps => ({
  broker: () => OUTAGE,
  notInstalled: () => LOST,
});

const until = async (check: () => Promise<boolean>) => {
  while (!(await check())) await new Promise((r) => setTimeout(r, 1));
};

describe('ListenerControl', () => {
  it('answers before the App is installed, and drains to done', async () => {
    const control = new ListenerControl(controlDeps());
    const listening = control.listen(waitForever);
    const { call, close } = await listen(control);
    try {
      const status = await call('/status');
      expect(listenerStatusSchema.parse(status.body)).toEqual({
        installed: false,
        actionsPermission: null,
        broker: OUTAGE,
        notInstalled: LOST,
        runners: 0,
        cap: 500,
        scaleSets: [],
      });
      expect(await call('/drain')).toEqual({ code: 200, body: null });
      expect((await call('/drain', 'POST')).body).toEqual(DRAINING);
      await listening;
      await until(
        async () =>
          ((await call('/drain')).body as DrainStatus).state !== 'running',
      );
      expect((await call('/drain')).body).toEqual({
        ...DRAINING,
        state: 'done',
      });
      expect(control.drainStarted).toBe(true);
      expect((await call('/nope')).code).toBe(404);
    } finally {
      close();
    }
  });

  it('drains an installed listener once its sessions end, and reruns a failed drain', async () => {
    const control = new ListenerControl(controlDeps());
    const outcomes: DrainStatus[] = [
      { ...DRAINING, state: 'failed', error: 'API down' },
      { ...DRAINING, state: 'done' },
    ];
    let drains = 0;
    const listening = control.listen(async (signal) => {
      control.ready({
        scaler: { status: () => ({ runners: 1, cap: 500, scaleSets: [] }) },
        actionsPermission: () => 'read',
        telemetry: () => ({ lastError: null, lastStatus: null, pending: 0 }),
        drain: async (progress) => {
          drains++;
          progress(1);
          return outcomes.shift()!;
        },
      });
      await waitForever(signal).catch(() => undefined);
    });
    expect(control.status()).toMatchObject({
      installed: true,
      actionsPermission: 'read',
      runners: 1,
    });

    control.drain(true);
    await listening;
    await until(async () => control.drain(false)?.state !== 'running');
    expect(control.drain(false)?.state).toBe('failed');
    control.drain(true);
    await until(async () => control.drain(false)?.state !== 'running');
    expect(control.drain(false)).toMatchObject({ state: 'done' });
    expect(drains).toBe(2);
  });
});
