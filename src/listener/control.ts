import { createServer } from 'node:http';

import { DRAINING, type DrainStatus } from './drain.js';
import { RUNNER_CAP, type Scaler } from './scaler.js';
import type { TelemetryStatus } from './telemetry.js';
import type { ListenerStatus } from './status.js';

// What the listener has once the App is installed on the org.
export interface Installed {
  scaler: Pick<Scaler, 'status'>;
  // The installation token's Actions permission, once one is minted.
  actionsPermission(): string | undefined;
  telemetry(): TelemetryStatus;
  drain(progress: (runnerJobs: number) => void): Promise<DrainStatus>;
}

export interface ControlDeps {
  // The broker's failure since it last answered.
  broker(): ListenerStatus['broker'];
  // The App's installation missing at the broker, even after a token.
  notInstalled(): ListenerStatus['notInstalled'];
}

// What the listener's loopback server answers (`serve`). It's up before the
// App's installation and the runner group, so `status`, `upgrade` and
// `uninstall` all work on a listener that can't start.
export class ListenerControl {
  // Ends the installation wait and the sessions, for shutdown or the drain.
  readonly sessions = new AbortController();
  private installed: Installed | undefined;
  private draining: DrainStatus | undefined;
  private listening: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ControlDeps) {}

  // `start` waits for the installation, calls `ready`, then runs the count
  // loop until `signal` aborts. An abort during the wait isn't an error.
  listen(start: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const { signal } = this.sessions;
    this.listening = start(signal).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
    return this.listening;
  }

  ready(installed: Installed) {
    this.installed = installed;
  }

  get drainStarted(): boolean {
    return this.draining !== undefined;
  }

  status(): ListenerStatus {
    return {
      installed: this.installed !== undefined,
      actionsPermission: this.installed?.actionsPermission() ?? null,
      broker: this.deps.broker(),
      notInstalled: this.deps.notInstalled(),
      telemetry: this.installed?.telemetry(),
      ...(this.installed?.scaler.status() ?? {
        runners: 0,
        cap: RUNNER_CAP,
        scaleSets: [],
      }),
    };
  }

  // A POST starts the drain, or reruns a failed one, so a rerun of uninstall
  // retries; null before any POST.
  drain(post: boolean): DrainStatus | null {
    if (post && (!this.draining || this.draining.state === 'failed')) {
      this.draining = DRAINING;
      this.sessions.abort();
      void this.listening
        .then(() =>
          this.installed
            ? this.installed.drain(
                (runnerJobs) => (this.draining = { ...DRAINING, runnerJobs }),
              )
            : // Still waiting for the App: no runner Jobs to drain.
              { ...DRAINING, state: 'done' as const },
        )
        .then(
          (status) => (this.draining = status),
          (error: unknown) =>
            (this.draining = {
              ...DRAINING,
              state: 'failed',
              error: String(error),
            }),
        );
    }
    return this.draining ?? null;
  }
}

// The loopback server: `backmesh status` and `upgrade` read `/status`,
// `uninstall` posts and polls `/drain`, through `anycloud exec`. On port 8080
// in the Pod.
export function serve(control: ListenerControl, port = 8080) {
  return createServer((request, response) => {
    let body: unknown;
    if (request.url === '/status') body = control.status();
    else if (request.url === '/drain')
      body = control.drain(request.method === 'POST');
    response.writeHead(body === undefined ? 404 : 200, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify(body === undefined ? {} : body));
  }).listen(port, '127.0.0.1');
}
