# Runner-group routing

Whether per-repository runner groups route jobs by repository while each
holds a scale set of the same name, on the test org `backmesh-dryrun`: can a
second scale set with the same name be created, does each session get only its
repository's jobs, and which set gets the jobs of a repository both groups
allow. `run.ts` explains each step. It starts no runner, and cleanup deletes
the groups and scale sets and cancels the runs.

Setup, once: private repositories `backmesh-dryrun/route-a` and
`backmesh-dryrun/route-b`, each with this as `.github/workflows/route.yml` on
`main`:

```yaml
name: route
on:
  workflow_dispatch:
    inputs:
      label:
        required: true
permissions: {}
jobs:
  route:
    runs-on: ${{ inputs.label }}
    steps:
      - run: echo "$GITHUB_REPOSITORY"
```

```sh
gh workflow run spike.yml --repo backmesh/backmesh --ref main \
  -f experiment=runner-group-routing -f source_sha=<full SHA>
```

The job log prints a device code. An owner of `backmesh-dryrun` enters it,
then revokes the backmesh App's authorization at
https://github.com/settings/apps/authorizations once the run is done.
`report.json` in the evidence artifact has the plan, each step's answer,
every job message per session, and per run the sessions sent JobAssigned
(GitHub assigns a job to one set without a JobAvailable first) and any offered
a JobAvailable. `summary` counts these per phase and repository.

## How to read

- A failure before the scale sets, such as a 4xx creating a group with
  selected repositories, is a plan or permission limit: the `failed` event
  has GitHub's answer.
- `duplicateName.created: true` means GitHub took the second scale set of the
  same name in another group. Otherwise the event has GitHub's refusal.
- Routing by repository holds if, in `one-repo-each`, every route-a job is
  `assigned a` and every route-b job `assigned b`. A job assigned to the
  other group's set, or offered to both, refutes it.
- `route-a-in-both` shows what happens to a repository both groups allow:
  route-a's jobs assigned to one set (which), offered to both, or to
  neither. route-b's jobs are the control and should stay `assigned b`.

Delete this directory, and the two repositories, once the findings are
recorded.
