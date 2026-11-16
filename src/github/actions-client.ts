import type { Octokit } from '@octokit/rest';
import { z } from 'zod';

import { actionsError, ActionsServiceError } from './errors.js';
import { redact, sleepFor, type Fetch, type Log, type Sleep } from './retry.js';
import {
  JOB_KINDS,
  jitConfigSchema,
  jobMessageSchema,
  listOf,
  messageEnvelopeSchema,
  runnerGroupSchema,
  runnerSchema,
  scaleSetSchema,
  sessionSchema,
  type Message,
  type Runner,
  type RunnerGroup,
  type ScaleSet,
  type Session,
} from './types.js';

// The scale-set API, hand-written after ARC's Go client
// (actions-runner-controller `github/actions/client.go` at
// gha-runner-scale-set-0.13.0, since moved to actions/scaleset `client.go`,
// 258f2c7b). Org scope only: backmesh's scale sets are org-level.

const SCALE_SETS = '_apis/runtime/runnerscalesets';
const RUNNERS = '_apis/distributedtask/pools/0/agents';
const API_VERSION = '6.0-preview';

const adminConnectionSchema = z.object({ url: z.string(), token: z.string() });
const jwtClaimsSchema = z.object({ exp: z.number() });
const kindSchema = z.object({ messageType: z.string() });

export interface ActionsClientOptions {
  org: string;
  // Authenticated as the App installation (installationOctokit).
  octokit: Octokit;
  // A retryingFetch, for the Actions service and the message queue.
  fetch: Fetch;
  now?: () => Date;
  sleep?: Sleep;
  // Ends the admin connection's retry waits, shared by every call: the
  // listener's shutdown.
  signal?: AbortSignal;
  log?: Log;
}

interface RequestOptions {
  // The admin token, or a session whose queue token a 401 renews.
  auth: string | Session;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  // A 404 passes: the thing is already gone, so cleanup can rerun.
  missingOk?: boolean;
}

// A job asking for this label too isn't rerun after a reclaim.
export const NO_RETRY_LABEL = 'backmesh-noretry';

export class ActionsClient {
  private admin: { url: string; token: string; expiresAt: number } | undefined;
  private pendingAdmin: Promise<{ url: string; token: string }> | undefined;

  constructor(private readonly options: ActionsClientOptions) {}

  async getRunnerGroupByName(name: string): Promise<RunnerGroup | undefined> {
    const path = `_apis/runtime/runnergroups/?groupName=${encodeURIComponent(name)}`;
    return (await this.service('GET', path, listOf(runnerGroupSchema)))
      .value[0];
  }

  async getScaleSet(
    runnerGroupId: number,
    name: string,
  ): Promise<ScaleSet | undefined> {
    const path = `${SCALE_SETS}?runnerGroupId=${runnerGroupId}&name=${encodeURIComponent(name)}`;
    return (await this.service('GET', path, listOf(scaleSetSchema))).value[0];
  }

  // Ephemeral runners that never self-update, as ARC's controller creates
  // them (`autoscalingrunnerset_controller.go:428-442` at 0.13.0, with the Go
  // JSON tags' casing). Labels: the scale set's name, and the retry's opt-out
  // as a second one.
  async ensureScaleSet(name: string, runnerGroupId: number): Promise<ScaleSet> {
    const existing = await this.getScaleSet(runnerGroupId, name);
    return (
      existing ??
      this.service('POST', SCALE_SETS, scaleSetSchema, {
        name,
        runnerGroupId,
        labels: [name, NO_RETRY_LABEL].map((label) => ({
          name: label,
          type: 'System',
        })),
        RunnerSetting: { ephemeral: true, disableUpdate: true },
      })
    );
  }

  async deleteScaleSet(id: number): Promise<void> {
    await this.service('DELETE', `${SCALE_SETS}/${id}`, undefined, undefined, {
      missingOk: true,
    });
  }

  // A scale set has one session at a time. A 409 means another listener
  // holds it: like ARC's listener, this waits 30 s and tries 10 times, long
  // enough for a replaced listener's session to be deleted or lapse, then
  // fails with code `conflict` (`cmd/ghalistener/listener/listener.go:225-257`
  // at 0.13.0). An abort ends the wait, as `ctx.Done()` does there.
  async createSession(
    scaleSetId: number,
    owner: string,
    signal?: AbortSignal,
  ): Promise<Session> {
    const path = `${SCALE_SETS}/${scaleSetId}/sessions`;
    for (let attempt = 1; ; attempt++) {
      try {
        const session = await this.service('POST', path, sessionSchema, {
          ownerName: owner,
        });
        return { ...session, scaleSetId };
      } catch (error) {
        const conflict =
          error instanceof ActionsServiceError && error.code === 'conflict';
        if (!conflict || attempt >= 10) throw error;
        this.options.log?.({
          msg: 'another listener holds the session; waiting',
          scaleSetId,
          attempt,
        });
        await (this.options.sleep ?? sleepFor)(30_000, signal);
      }
    }
  }

  // Deletes the session so another listener can open one at once.
  async deleteSession(session: Session): Promise<void> {
    const path = `${SCALE_SETS}/${session.scaleSetId}/sessions/${session.sessionId}`;
    await this.service('DELETE', path, undefined, undefined, {
      missingOk: true,
    });
  }

  // The long poll: the queue holds the request about 50 s and answers 202
  // when nothing arrived. A message is redelivered until deleteMessage.
  // `maxCapacity` tells GitHub how many more runners the listener can add.
  async getMessage(
    session: Session,
    lastMessageId: number,
    maxCapacity: number,
    signal?: AbortSignal,
  ): Promise<Message | undefined> {
    // Built per attempt: a renewed session may name another queue URL.
    const url = () => {
      const url = new URL(session.messageQueueUrl);
      if (lastMessageId > 0) {
        url.searchParams.set('lastMessageId', String(lastMessageId));
      }
      return url;
    };
    const response = await this.request('GET', url, {
      auth: session,
      headers: {
        Accept: `application/json; api-version=${API_VERSION}`,
        'X-ScaleSetMaxCapacity': String(Math.max(0, maxCapacity)),
      },
      signal,
    });
    if (response.status === 202) {
      await response.body?.cancel();
      return undefined;
    }
    const envelope = await parseBody(
      'GET',
      url(),
      response,
      messageEnvelopeSchema,
    );
    return this.parseMessage(envelope);
  }

  // The ack.
  async deleteMessage(session: Session, messageId: number): Promise<void> {
    const url = () => {
      const url = new URL(session.messageQueueUrl);
      url.pathname = `${url.pathname}/${messageId}`;
      return url;
    };
    await this.request('DELETE', url, { auth: session });
  }

  // Acquires offered jobs by runnerRequestId with the queue token; returns
  // the IDs granted.
  async acquireJobs(session: Session, requestIds: number[]): Promise<number[]> {
    if (requestIds.length === 0) return [];
    const { url: base } = await this.adminConnection();
    const path = `${SCALE_SETS}/${session.scaleSetId}/acquirejobs`;
    const url = serviceUrl(base, path);
    const response = await this.request('POST', url, {
      auth: session,
      body: requestIds,
    });
    return (await parseBody('POST', url, response, listOf(z.number().int())))
      .value;
  }

  // Mints a single-use JIT config for a runner of this name.
  async generateJitConfig(
    scaleSetId: number,
    runnerName: string,
  ): Promise<{ runner: Runner; encodedJitConfig: string }> {
    const path = `${SCALE_SETS}/${scaleSetId}/generatejitconfig`;
    const config = await this.service('POST', path, jitConfigSchema, {
      name: runnerName,
      workFolder: '_work',
    });
    return { runner: config.runner, encodedJitConfig: config.encodedJITConfig };
  }

  // A restarted listener knows its runners by name only (the Job ID), so
  // its scale-down looks up the ID to remove _(inference)_.
  async getRunnerByName(name: string): Promise<Runner | undefined> {
    const path = `${RUNNERS}?agentName=${encodeURIComponent(name)}`;
    return (await this.service('GET', path, listOf(runnerSchema))).value[0];
  }

  // Removes a runner's registration. GitHub refuses a runner with a job,
  // which ARC treats as "still running, skip": that's `busy`. A runner GitHub
  // already removed (`AgentNotFoundException`) counts as removed.
  async removeRunner(runnerId: number): Promise<'removed' | 'busy'> {
    try {
      await this.service('DELETE', `${RUNNERS}/${runnerId}`, undefined);
      return 'removed';
    } catch (error) {
      if (!(error instanceof ActionsServiceError)) throw error;
      if (error.code === 'job-still-running') return 'busy';
      if (error.code === 'runner-not-found') return 'removed';
      throw error;
    }
  }

  // Calls the Actions service with the admin token and parses the body.
  private async service<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | undefined,
    body?: unknown,
    { missingOk = false } = {},
  ): Promise<T> {
    const { url: base, token } = await this.adminConnection();
    const url = serviceUrl(base, path);
    const response = await this.request(method, url, {
      auth: token,
      body,
      missingOk,
    });
    if (schema) return parseBody(method, url, response, schema);
    await response.body?.cancel();
    return undefined as T;
  }

  // `target` is a function where a session renewal can change the URL.
  private async request(
    method: string,
    target: URL | (() => URL),
    options: RequestOptions,
  ): Promise<Response> {
    const { auth, body, headers, signal, missingOk } = options;
    for (let renewed = false; ; renewed = true) {
      const url = typeof target === 'function' ? target() : target;
      const token =
        typeof auth === 'string' ? auth : auth.messageQueueAccessToken;
      const response = await this.options.fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'backmesh',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if ([200, 202, 204].includes(response.status)) return response;
      if (missingOk && response.status === 404) return response;
      // A 401 from the message queue means its token expired: renew it once
      // and retry, as the scaleset client does (`session_client.go:100-140`
      // at 258f2c7b).
      if (typeof auth !== 'string' && response.status === 401 && !renewed) {
        await response.body?.cancel();
        await this.renewSession(auth);
        continue;
      }
      throw await actionsError(method, url.toString(), response);
    }
  }

  // Renews the session's queue token in place.
  private async renewSession(session: Session): Promise<void> {
    const path = `${SCALE_SETS}/${session.scaleSetId}/sessions/${session.sessionId}`;
    Object.assign(session, await this.service('PATCH', path, sessionSchema));
  }

  // The queue's envelope carries the batch of job messages as a JSON string
  // (actions/scaleset `client.go:662-726`). Kinds it doesn't know are skipped,
  // as there. An envelope of another type comes back with no jobs, so the
  // caller acks it instead of failing on it at every poll.
  private parseMessage(envelope: z.infer<typeof messageEnvelopeSchema>) {
    const { messageId, messageType } = envelope;
    const message: Message = {
      messageId,
      statistics: envelope.statistics ?? undefined,
      jobs: [],
    };
    if (messageType !== 'RunnerScaleSetJobMessages') {
      this.options.log?.({
        msg: 'skipping a message of unknown type',
        messageId,
        messageType,
      });
      return message;
    }
    const kinds: readonly string[] = JOB_KINDS;
    const batch = envelope.body
      ? z.array(kindSchema.loose()).parse(JSON.parse(envelope.body))
      : [];
    message.jobs = batch
      .filter((item) => kinds.includes(item.messageType))
      .map((item) => jobMessageSchema.parse(item));
    return message;
  }

  // The admin connection: an org registration token, exchanged at
  // `POST /actions/runner-registration` for the org's Actions service URL and
  // an admin JWT, renewed a minute before it expires (ARC `client.go:1092-1188,
  // 1255-1283`).
  private async adminConnection(): Promise<{ url: string; token: string }> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (this.admin && this.admin.expiresAt - now > 60_000) return this.admin;
    this.pendingAdmin ??= this.connect().finally(
      () => (this.pendingAdmin = undefined),
    );
    return this.pendingAdmin;
  }

  private async connect(): Promise<{ url: string; token: string }> {
    const { org, octokit, fetch, sleep = sleepFor, signal } = this.options;
    const { data } = await octokit.actions.createRegistrationTokenForOrg({
      org,
      request: { signal },
    });
    const url = 'https://api.github.com/actions/runner-registration';
    // ARC retries a 401 or 403 here 5 times, 1 s to 17 s apart: a new
    // registration token can take a moment to be accepted.
    for (let retry = 1; ; retry++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `RemoteAuth ${data.token}`,
          'User-Agent': 'backmesh',
        },
        body: JSON.stringify({
          url: `https://github.com/${org}`,
          runner_event: 'register',
        }),
        signal,
      });
      if (response.ok) {
        const admin = adminConnectionSchema.parse(await response.json());
        this.admin = { ...admin, expiresAt: jwtExpiry(admin.token) };
        return admin;
      }
      if (![401, 403].includes(response.status) || retry > 5) {
        throw await actionsError('POST', url, response);
      }
      await response.body?.cancel();
      await sleep(Math.min(500 * 2 ** retry, 20_000), signal);
    }
  }
}

// Where a body is expected, any other success (202, 204) is an error, not an
// empty result.
async function parseBody<T>(
  method: string,
  url: URL,
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ActionsServiceError(
      `${method} ${redact(url)} answered ${response.status} without a body`,
      'other',
      response.status,
      response.headers.get('activityid') ?? undefined,
    );
  }
  return schema.parse(await response.json());
}

// The admin token's expiry, read without verifying it: the service does.
function jwtExpiry(token: string): number {
  const payload = Buffer.from(token.split('.')[1] ?? '', 'base64url');
  return jwtClaimsSchema.parse(JSON.parse(payload.toString())).exp * 1_000;
}

function serviceUrl(base: string, path: string): URL {
  const url = new URL(`${base.replace(/\/+$/, '')}/${path}`);
  url.searchParams.set('api-version', API_VERSION);
  return url;
}
