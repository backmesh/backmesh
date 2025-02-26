<p align="center">
  <img src="https://backmesh.com/img/logo.png" width="80"/>
</p>

<h1 align="center">Backmesh, Open Source BaaS for AI apps</h1>

Backmesh is an open source Backend as a Service (BaaS) for AI apps. It lets you securely call LLM APIs directly from your mobile or web app using **any LLM SDK** without exposing private API keys. The only changes in your app are to replace:
1. The LLM API URL with the Backmesh URL.
2. The LLM private key with the authenticated user's JWT.

```js title="openai.ts"
import OpenAI from "openai";
import supabase from "supabase-js";

const BACKMESH_URL =
 "https://edge.backmesh.com/v1/proxy/gbBbHCDBxqb8zwMk6dCio63jhOP2/wjlwRswvSXp4FBXwYLZ1/v1";

const jwt = supabase.auth.session().access_token;
const client = new OpenAI({
  httpAgent: new HttpsProxyAgent(BACKMESH_URL),
  dangerouslyAllowBrowser: true, // no longer dangerous
  apiKey: jwt,
});
```

## 🔒 How is the LLM API protected

- *JWT Authentication:* Requests are verified with [JWTs](https://firebase.google.com/docs/auth/admin/verify-id-tokens) from the app's authentication provider so only your users have access to the LLM API via Backmesh.
- *Rate limits per user:* Configurable per-user rate limits to prevent abuse (e.g. no more than 5 OpenAI API calls per user per hour).
- *Resource access control:* Sensitive API resources like [Files](https://platform.openai.com/docs/api-reference/files) and [Threads](https://platform.openai.com/docs/api-reference/threads) are protected so only the users that create them can continue to access them.

For more details, see the [security documentation](https://backmesh.com/docs/security).

## ⚡️ Try out Backmesh

Get started with Backmesh using our [dashboard](https://app.backmesh.com) or if you would like to self host make sure to check out the self hosting [guide](https://backmesh.com/docs/selfhost).

## 🚀 Contribute

To contribute, visit [Contributing.md](./CONTRIBUTING.md)