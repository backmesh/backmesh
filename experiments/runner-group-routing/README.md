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
every job message per session, the run links and a per-phase summary.

Delete this directory, and the two repositories, once the findings are
recorded.
