import { describe, expect, it, vi } from 'vitest';

import { anycloudApi, apiTarget } from '../../../src/anycloud/client.js';
import { anycloudControl } from '../../../src/app/anycloud.js';
import { fakeHosted, HOSTED, refusesValue } from '../cli/fakes.js';
import { readOverride } from '../../../src/app/override.js';

// Records CLI arguments and API requests, the latter as `METHOD path body`.
// Each PUT answers the next of `puts` (0 drops the connection), then 204.
function fakeAnycloud(
  secrets: string[] = [],
  puts: number[] = [],
  // The binary's answer to each call: its stdout, or its failure.
  answer: (args: string[]) => string = () => '',
) {
  const calls: string[][] = [];
  const requests: string[] = [];
  const api = anycloudApi('https://c1.anycloud.sh', 't0ken', async (req) => {
    const request = req instanceof Request ? req : new Request(req);
    expect(request.headers.get('authorization')).toBe('Bearer t0ken');
    expect(request.headers.get('anycloud-client-version')).toMatch(/^\d/);
    const { pathname } = new URL(request.url);
    const body = await request.text();
    requests.push(`${request.method} ${pathname} ${body}`);
    if (refusesValue(request.method, pathname, body)) {
      return Response.json({}, { status: 400 });
    }
    if (request.method === 'GET') {
      return Response.json(
        secrets.map((name) => ({ name, createdAt: 1, updatedAt: 1 })),
      );
    }
    const status = puts.shift() ?? 204;
    if (status === 0) throw new TypeError('fetch failed');
    return status === 204
      ? new Response(null, { status })
      : Response.json({ message: 'Unavailable' }, { status });
  });
  const anycloud = anycloudControl(api, async (args) => {
    calls.push(args);
    return answer(args);
  });
  return { anycloud, calls, requests };
}

const never = async () => {
  throw new Error('signed in');
};

const connect = async (fake: ReturnType<typeof fakeHosted>) => {
  const { url, token, refresh } = await apiTarget({}, fake.run, fake.signIn);
  return anycloudApi(url, token, fake.fetch, refresh);
};

describe('the anycloud API', () => {
  it('targets the active API, with a token never in argv', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[1] === 'status'
        ? JSON.stringify({ url: 'https://c1.anycloud.sh', healthy: true })
        : 't0ken\n',
    );
    // Only a hosted API's saved token can go stale and be refreshed.
    await expect(apiTarget({}, run, never)).resolves.toEqual({
      url: 'https://c1.anycloud.sh',
      token: 't0ken',
      refresh: expect.any(Function),
    });
    expect(run.mock.calls).toEqual([
      [['api', 'status', '--json']],
      [['api', 'token']],
    ]);
    // The environment's token counts only alongside API_URL, as in the CLI.
    await expect(
      apiTarget({ ANYCLOUD_API_TOKEN: 'e' }, run, never),
    ).resolves.toEqual({
      url: 'https://c1.anycloud.sh',
      token: 't0ken',
      refresh: expect.any(Function),
    });
    await expect(
      apiTarget(
        { API_URL: 'https://c1.anycloud.sh', ANYCLOUD_API_TOKEN: 'e' },
        run,
        never,
      ),
    ).resolves.toEqual({
      url: 'https://c1.anycloud.sh',
      token: 'e',
      refresh: undefined,
    });

    const failed = new Error('anycloud exited with 1');
    const error: unknown = await apiTarget(
      {},
      () => Promise.reject(failed),
      never,
    ).catch((e) => e);
    expect(String(error)).toContain(
      "Couldn't read which control plane this machine uses; retry.",
    );
    expect((error as Error).cause).toBe(failed);
  });
});

describe('the hosted API token', () => {
  it('refreshes a rotated token once with `login`, then keeps it', async () => {
    const fake = fakeHosted();
    const api = await connect(fake);
    // Concurrent refusals share one `login`.
    await expect(
      Promise.all([api.listSecrets(), api.listSecrets()]),
    ).resolves.toEqual([[], []]);
    await expect(api.listSecrets()).resolves.toEqual([]);
    expect(fake.bearers.filter((b) => b === 'acapi_new')).toHaveLength(3);
    expect(fake.calls.slice(1)).toEqual([
      'api token',
      `login ${HOSTED}`,
      'api token',
    ]);
  });

  it('refreshes the stale GitHub sign-in behind a current token', async () => {
    const fake = fakeHosted({ staleSignIn: true });
    await expect((await connect(fake)).listSecrets()).resolves.toEqual([]);
    expect(fake.bearers).toEqual(['acapi_new', 'acapi_new']);
    expect(fake.calls).toContain(`login ${HOSTED}`);
  });

  it("signs in with backmesh, not anycloud's code, when login has no sign-in", async () => {
    const fake = fakeHosted({ login: 'relay' });
    await expect((await connect(fake)).listSecrets()).resolves.toEqual([]);
    expect(fake.signIn).toHaveBeenCalledOnce();
    // The exchange runs again with the saved sign-in, and the retry uses it.
    expect(fake.calls.filter((c) => c.startsWith('login'))).toHaveLength(2);
    expect(fake.bearers.at(-1)).toBe('acapi_new');
  });

  it("names no anycloud command when backmesh's sign-in is refused too", async () => {
    const fake = fakeHosted({ login: 'relay' });
    fake.signIn.mockImplementation(async () => undefined);
    const error = (await (
      await connect(fake)
    )
      .listSecrets()
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('refused the new GitHub sign-in too');
    expect(error.cause).toBeUndefined();
  });

  it('keeps the reason when the second exchange fails otherwise', async () => {
    const denied = fakeHosted({ login: 'relay-denied' });
    await expect((await connect(denied)).listSecrets()).rejects.toThrow(
      'API access denied',
    );
    expect(denied.signIn).toHaveBeenCalledOnce();
  });

  it('retries only once, and fails with login’s error when access is gone', async () => {
    const lost = fakeHosted({ login: 'denied' });
    await expect((await connect(lost)).listSecrets()).rejects.toThrow(
      'API access denied',
    );

    const raced = fakeHosted({ rotates: true });
    await expect((await connect(raced)).listSecrets()).rejects.toMatchObject({
      status: 401,
    });
    expect(raced.calls.filter((c) => c.startsWith('login'))).toHaveLength(1);
  });
});

describe('anycloudControl', () => {
  it("issues, rotates and removes the listener's service token, read from stdout", async () => {
    let n = 0;
    const { anycloud, calls } = fakeAnycloud([], [], (args) =>
      args.includes('--json') ? JSON.stringify({ token: `acsvc_${++n}` }) : '',
    );
    expect(await anycloud.issueServiceToken('backmesh-acme')).toBe('acsvc_1');
    expect(await anycloud.rotateServiceToken('backmesh-acme')).toBe('acsvc_2');
    await anycloud.removeService('backmesh-acme');
    await anycloud.removeServiceAccount('backmesh-acme');
    expect(calls).toEqual([
      ['api', 'access', 'add', '--service', 'backmesh-acme', '--json'],
      ['api', 'token', 'rotate', '--service', 'backmesh-acme', '--json'],
      ['api', 'access', 'remove', '--service', 'backmesh-acme'],
      ['api', 'access', 'remove', '--service-account', 'backmesh-acme'],
    ]);
  });

  it('rotates a service that already exists, and keeps the add’s refusal otherwise', async () => {
    const { anycloud, calls } = fakeAnycloud([], [], (args) => {
      if (args[1] === 'access') {
        throw new Error(
          'api access failed: backmesh-acme exists (API_ACCESS_SERVICE_EXISTS)',
        );
      }
      return JSON.stringify({ token: 'acsvc_9' });
    });
    expect(await anycloud.issueServiceToken('backmesh-acme')).toBe('acsvc_9');
    expect(calls.map((c) => c[1])).toEqual(['access', 'token']);

    // Any other refusal, such as a sign-in or a version, rotates nothing.
    const { anycloud: refused, calls: tried } = fakeAnycloud([], [], () => {
      throw new Error('only the owner issues service tokens');
    });
    await expect(refused.issueServiceToken('backmesh-acme')).rejects.toThrow(
      'only the owner',
    );
    expect(tried.map((c) => c[1])).toEqual(['access']);
  });
});

describe('readOverride', () => {
  it('is off unless set to the exact value', () => {
    const name = 'BACKMESH_UNSUPPORTED_CI_OVERRIDE';
    expect(readOverride({})).toBeUndefined();
    expect(readOverride({ [name]: 'anycloud-ci' })).toEqual({
      env: { [name]: 'anycloud-ci' },
    });
    expect(() => readOverride({ [name]: '1' })).toThrow('unknown value');
  });
});
