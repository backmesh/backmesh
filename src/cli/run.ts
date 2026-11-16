import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander';

import {
  anycloudBinary,
  runAnycloud,
  streamAnycloud,
} from '../anycloud/binary.js';
import {
  activeApiUrl,
  anycloudApi,
  apiToken,
  tokenRefresh,
} from '../anycloud/client.js';
import { workerDeps } from './worker.js';
import { cue, type CueDeps } from './cue.js';
import { signInAgain } from './github-sign-in.js';
import { clusterIdOf, listenerName, readControlPool } from './installation.js';
import { signInScopes } from '../app/github.js';
import { readCompatibility } from '../release/compatibility.js';
import { install, type InstallDeps } from './install.js';
import { pickOrg } from './pick-org.js';
import { UsageError } from './errors.js';
import { rotateKey, type RotateKeyDeps } from './rotate-key.js';
import { formatStatus, readStatus, type StatusReport } from './status.js';
import { RUNNER_NAME } from '../listener/routes.js';
import { uninstall, type UninstallDeps } from './uninstall.js';
import { upgrade, type UpgradeDeps } from './upgrade.js';

// Exit code for a usage error.
const EXIT_USAGE = 2;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  // Whether stdin is a terminal; nothing prompts when it isn't.
  isTTY: boolean;
  // The real dependencies; tests replace them.
  installDeps?: (io: CliIo, json: boolean) => InstallDeps;
  upgradeDeps?: (io: CliIo, json: boolean) => UpgradeDeps;
  uninstallDeps?: (io: CliIo, json: boolean) => UninstallDeps;
  rotateKeyDeps?: (io: CliIo, json: boolean) => RotateKeyDeps;
  readStatus?: (io: CliIo, org?: string) => Promise<StatusReport>;
  // Streams a workload's log to this terminal; resolves with the exit code.
  streamLogs?: (args: string[]) => Promise<number>;
  // The control plane's listener names, for `logs` without `--org`.
  listeners?: (io: CliIo) => Promise<string[]>;
  cueDeps?: (io: CliIo) => CueDeps;
}

const execFileAsync = promisify(execFile);

// `bun build --define` replaces this name (scripts/build-binaries.sh).
declare const BACKMESH_VERSION: string | undefined;

function realUi(io: CliIo, json: boolean) {
  // With --json, stdout carries only the result.
  const print = (line: string) => (json ? io.stderr : io.stdout)(`${line}\n`);
  const ask = async (question: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const answer = await rl.question(`${question} `);
    rl.close();
    return answer.trim();
  };
  return {
    print,
    ...(io.isTTY && {
      ask,
      confirm: async (question: string) =>
        /^y(es)?$/i.test(await ask(`${question} [y/N]`)),
    }),
  };
}

// The user's own cloud CLI, run as them.
const cloudCommand = async (
  [file, ...args]: string[],
  env?: NodeJS.ProcessEnv,
) =>
  (
    await execFileAsync(file!, args, {
      timeout: 60_000,
      env: { ...process.env, ...env },
    })
  ).stdout;

function realInstallDeps(io: CliIo, json: boolean): InstallDeps {
  return {
    env: io.env,
    run: runAnycloud,
    runLong: anycloudBinary(0),
    command: cloudCommand,
    signInScopes,
    release: async () => readCompatibility(),
    ui: realUi(io, json),
    git: (args) => git(args, AbortSignal.timeout(10_000), io.env),
  };
}

function realUpgradeDeps(io: CliIo, json: boolean): UpgradeDeps {
  return {
    env: io.env,
    run: runAnycloud,
    runLong: anycloudBinary(0),
    release: async () => readCompatibility(),
    status: () => realStatus(io),
    ...realUi(io, json),
  };
}

function realRotateKeyDeps(io: CliIo, json: boolean): RotateKeyDeps {
  return {
    env: io.env,
    run: runAnycloud,
    runLong: anycloudBinary(0),
    signInScopes,
    print: realUi(io, json).print,
  };
}

// `git` for cue, off the terminal: it and an ssh it starts can't prompt (a
// prompt would wait out cue's budget, and an orphaned ssh would read the
// user's next keystrokes), and an abort ends its whole process group. Its
// output isn't capped, so a big repo's `ls-remote` fits.
export function git(
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never' },
    });
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
    if (signal.aborted) kill();
    else signal.addEventListener('abort', kill, { once: true });
  });
}

// A stale sign-in's refresh, through GitHub's device flow.
const reSignIn = (io: CliIo) =>
  signInAgain(workerDeps({ env: io.env }, (line) => io.stderr(`${line}\n`)));

function realCueDeps(io: CliIo): CueDeps {
  return {
    env: io.env,
    fetch: globalThis.fetch,
    git: (args, signal) => git(args, signal, io.env),
    signIn: reSignIn(io),
  };
}

function realUninstallDeps(io: CliIo, json: boolean): UninstallDeps {
  return {
    env: io.env,
    run: runAnycloud,
    runLong: anycloudBinary(0),
    ui: realUi(io, json),
  };
}

// `run` and `fetch` are the real binary and network unless a test passes fakes.
export async function realStatus(
  io: CliIo,
  org?: string,
  run = runAnycloud,
  fetch?: typeof globalThis.fetch,
) {
  const url = await activeApiUrl(run);
  clusterIdOf(url);
  return readStatus({
    api: anycloudApi(
      url,
      await apiToken(io.env, run),
      fetch,
      tokenRefresh(io.env, run, url, reSignIn(io)),
    ),
    apiUrl: url,
    run,
    fetch,
    org,
  });
}

// The installation's control plane must be the active one.
async function realLogs(args: string[]) {
  clusterIdOf(await activeApiUrl(runAnycloud));
  return streamAnycloud(args);
}

async function realListeners(io: CliIo) {
  const url = await activeApiUrl(runAnycloud);
  clusterIdOf(url);
  const token = await apiToken(io.env, runAnycloud);
  const api = anycloudApi(
    url,
    token,
    undefined,
    tokenRefresh(io.env, runAnycloud, url, reSignIn(io)),
  );
  return (await readControlPool(api)).listeners.map(({ name }) => name);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let json = argv.includes('--json');
  let exitCode = 0;
  const status = io.readStatus ?? realStatus;
  const print = (result: object, text: string) =>
    io.stdout(json ? `${JSON.stringify(result)}\n` : `${text}\n`);
  const fail = (code: string, message: string) => {
    if (json) print({ error: { code, message } }, message);
    else io.stderr(`${message}\n`);
  };

  // A release binary embeds its version; src/cli and dist/cli read it.
  const { version }: { version: string } =
    typeof BACKMESH_VERSION === 'string'
      ? { version: BACKMESH_VERSION }
      : JSON.parse(
          readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
        );
  const program = new Command('backmesh')
    .option('--json', 'print JSON')
    .option('--version', 'print the version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    })
    .action(() => {
      if (!program.opts().version) program.help({ error: true });
      print({ version }, version);
    });

  program
    .command('install')
    .description('Install backmesh in your clouds for one GitHub org')
    .option(
      '--org <org>',
      "the GitHub org; without it, this repo's remote's org or one you pick",
    )
    .option(
      '--control-plane <cloud:region>',
      "where backmesh's always-on VMs run, such as aws:us-east-1; without it, the signed-in cloud CLI's cloud in US East",
    )
    .option(
      '--runners <cloud>',
      "a cloud the runners use (repeatable), such as aws; a cloud only, since backmesh's runner regions are fixed. Without it, the control plane's cloud",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--plan',
      'print what install would create and its plan ID, and change nothing',
    )
    .option(
      '--plan-id <id>',
      'the plan --yes agrees to, from --plan, the same-owner check included',
    )
    .option('--yes', 'create the plan --plan-id names without asking')
    .option(
      '--cache-cap <GB>',
      "each repository's cache in each region, in GB (default 10)",
      (value: string) => {
        const gb = Number(value);
        if (!/^\d+(\.\d+)?$/.test(value) || !(gb > 0))
          throw new InvalidArgumentError('a positive number of GB, such as 25');
        return gb;
      },
    )
    // Hidden until RFC 0053.
    .addOption(new Option('--public-repos').hideHelp())
    .addOption(new Option('--no-public-repos').hideHelp())
    .option('--verbose', "show the cloud CLIs' own errors")
    .action(
      async (opts: {
        org?: string;
        cacheCap?: number;
        publicRepos?: boolean;
        controlPlane?: string;
        runners: string[];
        plan?: boolean;
        planId?: string;
        yes?: boolean;
        verbose?: boolean;
      }) => {
        const deps = {
          ...(io.installDeps ?? realInstallDeps)(io, json),
          verbose: opts.verbose,
        };
        const org = opts.org ?? (await pickOrg(argv, !!opts.plan, deps));
        const result = await install(
          {
            org,
            controlPlane: opts.controlPlane,
            runners: opts.runners,
            yes: opts.yes ?? false,
            plan: opts.plan,
            planId: opts.planId,
            cacheCapGb: opts.cacheCap,
            publicRepos: opts.publicRepos,
          },
          deps,
        );
        if ('planId' in result) {
          // Every placement flag, defaults filled in, so the plan it runs is
          // the one shown.
          const { controlPlane, runners } = result;
          const again = [
            `--org ${org}`,
            `--control-plane ${controlPlane.cloud}:${controlPlane.region}`,
            ...runners.map((r) => `--runners ${r.cloud}`),
            ...(opts.publicRepos === undefined
              ? []
              : [opts.publicRepos ? '--public-repos' : '--no-public-repos']),
          ].join(' ');
          print(
            result,
            `Plan ${result.planId}. To create it: backmesh install ${again} --yes --plan-id ${result.planId}`,
          );
          return;
        }
        // Step 9 ends with `status`; install has succeeded even if it fails.
        const report = await status(io).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        print(
          { ...result, status: report },
          'error' in report
            ? `\nInstalled, but \`backmesh status\` failed: ${report.error}`
            : `\n${formatStatus(report)}`,
        );
      },
    );

  program
    .command('status')
    .description(
      'Show the control plane, each org’s queue and cost, and the health checks',
    )
    .option('--org <org>', 'show only this org')
    .action(async (opts: { org?: string }) => {
      const report = await status(io, opts.org);
      print(report, formatStatus(report));
    });

  program
    .command('logs')
    .description("Show an org's listener's log, or a runner's")
    .argument('[runner]', 'a runner name, such as bm0a1b2-4x-k3j9x0qz')
    .option('--org <org>', "the org whose listener's log to show")
    .option('-f, --follow', 'keep printing new lines')
    .action(
      async (
        runner: string | undefined,
        opts: { org?: string; follow?: boolean },
      ) => {
        if (runner !== undefined && !RUNNER_NAME.test(runner)) {
          throw new UsageError(
            `${runner} isn't a runner name; they look like bm0a1b2-4x-k3j9x0qz.`,
          );
        }
        if (runner !== undefined && opts.org !== undefined) {
          throw new UsageError(
            "Pass --org <org> for that org's listener's log, or a runner's name, not both.",
          );
        }
        // Without either, the control plane's only listener.
        let name = runner ?? (opts.org && listenerName(opts.org));
        if (!name) {
          const names = await (io.listeners ?? realListeners)(io);
          if (names.length !== 1) {
            throw new UsageError(
              `Pass --org <org> for that org's listener's log; this control plane runs ${names.length} listeners.`,
            );
          }
          name = names[0]!;
        }
        exitCode = await (io.streamLogs ?? realLogs)([
          'logs',
          name,
          ...(opts.follow ? ['--follow'] : []),
        ]);
      },
    );

  program
    .command('cue')
    .description(
      "When you start your checks before a push, warn your org's listener, so its runners start early",
    )
    .option('--repo <owner/name>', "the repo, else origin's")
    .option('--branch <branch>', 'the branch, else the current one')
    .option(
      '--in <seconds>',
      'seconds until you expect to push, 30 to 600; under 30 sends nothing (required, but for --cancel or --sign-in alone)',
      // Digits only: '' or '1e2' isn't a lead, and `cue` refuses NaN.
      (value: string) => (/^\d+$/.test(value) ? Number(value) : Number.NaN),
    )
    .option('--cancel', "drop the branch's cue: you won't push soon")
    .option('--sign-in', 'sign in with GitHub first')
    .action(
      async (opts: {
        repo?: string;
        branch?: string;
        in?: number;
        cancel?: boolean;
        signIn?: boolean;
      }) => {
        const result = await cue(
          { ...opts, inS: opts.in, signIn: opts.signIn ?? false },
          (io.cueDeps ?? realCueDeps)(io),
        );
        print(result, result.message);
      },
    );

  program
    .command('upgrade')
    .description(
      "Move the control plane and the listener to this backmesh's release",
    )
    .option(
      '--runners <cloud>',
      'a cloud the runners keep (repeatable), such as aws; a cloud only. A cloud left out is removed. Without it, every cloud stays',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--plan',
      'print what upgrade would change and its plan ID, and change nothing',
    )
    .option('--plan-id <id>', 'the plan --yes agrees to, from --plan')
    .option('--yes', 'apply the plan --plan-id names without asking')
    .action(
      async (opts: {
        runners: string[];
        plan?: boolean;
        planId?: string;
        yes?: boolean;
      }) => {
        const result = await upgrade(
          (io.upgradeDeps ?? realUpgradeDeps)(io, json),
          {
            runners: opts.runners,
            plan: opts.plan,
            planId: opts.planId,
            yes: opts.yes ?? false,
          },
        );
        if ('planId' in result) {
          const again = opts.runners.map((r) => `--runners ${r}`).join(' ');
          print(
            result,
            `Plan ${result.planId}. To apply it: backmesh upgrade ${again ? `${again} ` : ''}--yes --plan-id ${result.planId}`,
          );
          return;
        }
        // upgrade ends with the `status` checks, whose warnings don't
        // change its exit: it did what was asked (errors.ts).
        print(result, `\n${formatStatus(result.status)}`);
      },
    );

  program
    .command('rotate-key')
    .description(
      "Replace an org's install key: mint a new one, confirm the listener runs on it, then revoke the old one",
    )
    .requiredOption('--org <org>', 'the GitHub org')
    .action(async (opts: { org: string }) => {
      const result = await rotateKey(
        (io.rotateKeyDeps ?? realRotateKeyDeps)(io, json),
        { org: opts.org },
      );
      print(
        result,
        `Rotated ${result.org}'s install key; the old one is revoked.`,
      );
    });

  program
    .command('uninstall')
    .description(
      'Delete the installation, its runners and its GitHub setup, or one org’s',
    )
    .option(
      '--org <org>',
      'remove only this org, keeping the control plane for its other orgs; needed when the control plane is gone',
    )
    .option('--yes', 'delete without asking')
    .option(
      '--delete-checkpoint-bucket',
      "delete the control plane's backups too (needs --confirm without a terminal)",
    )
    .option('--confirm <name-or-id>', "the installation's name or ID")
    .option(
      '--control-plane <cloud:region>',
      "when the control plane doesn't answer, its cloud and region, to delete it through your cloud CLI",
    )
    .action(
      async (opts: {
        org?: string;
        yes?: boolean;
        deleteCheckpointBucket?: boolean;
        confirm?: string;
        controlPlane?: string;
      }) => {
        const deps = (io.uninstallDeps ?? realUninstallDeps)(io, json);
        const result = await uninstall(
          {
            org: opts.org,
            yes: opts.yes ?? false,
            deleteCheckpointBucket: opts.deleteCheckpointBucket ?? false,
            confirm: opts.confirm,
            controlPlane: opts.controlPlane,
          },
          deps,
        );
        print(
          result,
          result.cloud === 'kept'
            ? `Uninstalled from ${result.orgs.map((o) => o.org).join(', ')}; the control plane stays.`
            : 'Uninstalled.',
        );
      },
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    json ||= program.opts().json === true;
    if (error instanceof CommanderError) {
      // --help exits 0. Commander has printed its own usage errors to
      // stderr, but not the JSON one.
      if (error.exitCode === 0) return 0;
      if (json) fail('usage', error.message);
      return EXIT_USAGE;
    }
    fail(error instanceof UsageError ? error.code : 'failed', describe(error));
    return error instanceof UsageError ? EXIT_USAGE : 1;
  }
}

// The error and each cause beneath it, so a wrapped API refusal says why. An
// API error adds its HTTP status, never its data, which can echo the request.
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines: string[] = [];
  for (let e: unknown = error; e instanceof Error && lines.length < 5;) {
    const status = (e as { status?: unknown }).status;
    lines.push(
      typeof status === 'number' ? `${e.message} (HTTP ${status})` : e.message,
    );
    e = e.cause;
  }
  return lines.join('\nCaused by: ');
}
