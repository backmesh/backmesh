# App user token: runner groups

Whether `GET /orgs/{org}/actions/runner-groups` with the backmesh App's user
token (`ghu_`) succeeds for an org owner and is refused for a plain member,
with the App's existing permissions only: the Worker's authority check for
every sign-in once sign-in moves from the OAuth app to the App's device flow.
`run.ts` says what it does; it uses no secret and only reads.

Before dispatching, device flow is enabled on the App (App settings →
Optional features... → Enable Device Flow) and the App is installed on `ORG`.

```sh
gh workflow run spike.yml --repo backmesh/backmesh --ref main \
  -f experiment=app-user-runner-groups -f source_sha=<full SHA>
```

The job log prints two codes, one per role; an owner and a plain member of
`ORG` each open the link and enter theirs. `report.json` in the evidence
artifact records each request's status, GitHub's message and
`X-Accepted-GitHub-Permissions`. Each person revokes the token afterwards at
https://github.com/settings/apps/authorizations.

Delete this directory once the sign-in change ships.
