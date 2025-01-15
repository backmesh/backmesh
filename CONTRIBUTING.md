
# Contributing

Thanks for your interest in helping improve Backmesh! 🎉

If you are looking for Backmesh's documentation, go here instead: https://backmesh.com/docs

## Local development and testing

Expects a `.dev.vars` that gets ignored by git per https://developers.cloudflare.com/workers/testing/local-development/#local-only-environment-variables. It can be bootstrapped with variables in [`worker-configuration.d.ts`](./worker-configuration.d.ts)

Then install dependencies and run the worker locally with

```bash
npm run dev
```

To see the keys in the local KV run:

```bash
npx wrangler kv key list --namespace-id <BINDING_ID> --local
```

## Versioned Routes

- `/v1/proxy` uses the user's JWT authentication and should only call KV to stay performant
- `/v1/crud` called by the dashboard and uses Backmesh Firebase Auth JWT authentication

### HTTP methods

- `POST` for creations, fail if it already exists
- `PUT` for updates, fails if it does not already exist
- `DELETE`
- `GET`

## Versioned Data Model

Cloudflare KV is the main data store. Resources have unique alphanumeric names set by us. Collections do not end in template.

### API Proxy

`proxies/${backmeshUid}/[]`

- `proxies/${backmeshUid}/${proxyId}`

### API Proxy End User

`endusers/${backmeshUid}/${proxyId}/[]`

- `endusers/${backmeshUid}/${proxyId}/{uid}`
- can have cummulative summaries or indices down the line

### API Proxy per user request history

`reqs/${backmeshUid}/${proxyId}/{uid}/[]`

- `reqs/${backmeshUid}/${proxyId}/{uid}/{ts}|${model}|${tokens}|${timing}`

### API Proxy per user rate limit

`limits/${backmeshUid}/${proxyId}/[]`

- `limits/${backmeshUid}/${proxyId}/{uid}-${windowstart}`

### API Proxy private resourecs

`resources/${backmeshUid}/${proxyId}[]`

- `resources/${backmeshUid}/${proxyId}/${resource.id}`

### Plan

`plans/[]`

- `plans/${backmeshUid}`
