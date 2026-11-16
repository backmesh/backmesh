import { describe, expect, it } from 'vitest';

import {
  deleteOrgRunner,
  deleteRunnerGroup,
  ensureRunnerGroup,
  isOurRunnerGroup,
  listOrgRunners,
  listRunnerGroups,
  runnerGroupName,
} from '../../../src/github/runner-group.js';
import { fakeGitHub, json, octokitFor } from './fake-github.js';

const GROUPS = 'https://api.github.com/orgs/acme/actions/runner-groups';
const RUNNERS = 'https://api.github.com/orgs/acme/actions/runners';

const group = (id: number, name: string, isPublic = false) => ({
  id,
  name,
  visibility: 'all',
  default: id === 1,
  allows_public_repositories: isPublic,
});

const listing = (...groups: ReturnType<typeof group>[]) =>
  json(200, { total_count: groups.length, runner_groups: groups });

describe('runner group', () => {
  it('creates the group with public repositories off', async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: listing(group(1, 'Default')),
      [`POST ${GROUPS}`]: json(201, group(3, 'backmesh')),
    });
    const created = await ensureRunnerGroup(
      octokitFor(github.fetch),
      'acme',
      'backmesh',
      false,
    );
    expect(created).toEqual({ id: 3, name: 'backmesh' });
    expect(github.calls.at(-1)?.body).toEqual({
      name: 'backmesh',
      visibility: 'all',
      allows_public_repositories: false,
    });
  });

  it('turns public repositories off on an existing group', async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: listing(group(3, 'backmesh', true)),
      [`PATCH ${GROUPS}/3`]: json(200, group(3, 'backmesh')),
    });
    await ensureRunnerGroup(
      octokitFor(github.fetch),
      'acme',
      'backmesh',
      false,
    );
    expect(github.calls.at(-1)?.body).toEqual({
      name: 'backmesh',
      allows_public_repositories: false,
    });
  });

  it('turns public repositories on with --public-repos, and leaves a matching group alone', async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: listing(group(3, 'backmesh')),
      [`PATCH ${GROUPS}/3`]: json(200, group(3, 'backmesh', true)),
    });
    const octokit = octokitFor(github.fetch);
    await ensureRunnerGroup(octokit, 'acme', 'backmesh', true);
    expect(github.calls.at(-1)?.body).toEqual({
      name: 'backmesh',
      allows_public_repositories: true,
    });
    const matching = fakeGitHub({
      [`GET ${GROUPS}`]: listing(group(3, 'backmesh', true)),
    });
    await ensureRunnerGroup(
      octokitFor(matching.fetch),
      'acme',
      'backmesh',
      true,
    );
    expect(matching.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('treats a missing group as deleted', async () => {
    const github = fakeGitHub({
      [`DELETE ${GROUPS}/3`]: json(404, { message: 'Not Found' }),
    });
    await expect(
      deleteRunnerGroup(octokitFor(github.fetch), 'acme', 3),
    ).resolves.toBeUndefined();
  });

  it("lists the org's groups", async () => {
    const github = fakeGitHub({
      [`GET ${GROUPS}`]: listing(group(1, 'Default'), group(3, 'backmesh')),
    });
    expect(await listRunnerGroups(octokitFor(github.fetch), 'acme')).toEqual([
      { id: 1, name: 'Default' },
      { id: 3, name: 'backmesh' },
    ]);
  });

  it('names each install its own group, stable for one Deployment', () => {
    const name = runnerGroupName('0a1b2', 'dep_1');
    expect(name).toMatch(/^backmesh-0a1b2-[a-z0-9]{6}$/);
    expect(runnerGroupName('0a1b2', 'dep_1')).toBe(name);
    // A reinstall's new Deployment never takes the deleted group's name.
    expect(runnerGroupName('0a1b2', 'dep_2')).not.toBe(name);
    expect(isOurRunnerGroup('0a1b2')(name)).toBe(true);
    expect(isOurRunnerGroup('zzzzz')(name)).toBe(false);
    expect(isOurRunnerGroup(undefined)(name)).toBe(true);
    for (const other of ['backmesh', 'Default', 'backmesh-0a1b2']) {
      expect(isOurRunnerGroup('0a1b2')(other)).toBe(false);
      expect(isOurRunnerGroup(undefined)(other)).toBe(false);
    }
  });

  it("lists the org's runners and treats a missing one as deleted", async () => {
    const github = fakeGitHub({
      [`GET ${RUNNERS}`]: json(200, {
        total_count: 1,
        runners: [{ id: 9, name: 'bmabc12-a4-00000000', status: 'offline' }],
      }),
      [`DELETE ${RUNNERS}/9`]: json(404, { message: 'Not Found' }),
    });
    const octokit = octokitFor(github.fetch);
    expect(await listOrgRunners(octokit, 'acme')).toEqual([
      { id: 9, name: 'bmabc12-a4-00000000' },
    ]);
    await expect(deleteOrgRunner(octokit, 'acme', 9)).resolves.toBeUndefined();
  });
});
