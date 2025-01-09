<p align="center">
  <img src="https://backmesh.com/img/logo.png" width="80"/>
</p>

<h1 align="center">Backmesh, Firebase for LLM APIs</h1>

Backmesh is a thoroughly tested, TypeScript-powered proxy backend hosted on **Cloudflare Workers**, designed to simplify and secure LLM API integrations.

With Backmesh, you can securely call LLM APIs directly from your mobile or web app using **any LLM SDK** without exposing private API keys. Replace the LLM API URL and private key in your SDK with the Backmesh URL and the authenticated user’s JWT respectively.

## 🔒 How is the LLM API protected

- *Authenticated Proxy:* Requests are verified with JWTs from the app's authentication provider so only your users have access to the LLM API via the Backmesh proxy.
- *Rate limits per user:* Configurable per-user rate limits to prevent abuse (e.g. no more than 5 OpenAI API calls per user per hour).
- *Resource access control:* Sensitive API resources like [Files](https://platform.openai.com/docs/api-reference/files) and [Threads](https://platform.openai.com/docs/api-reference/threads) are protected so only the users that create them can continue to access them.

For more details, see the [security documentation](https://backmesh.com/docs/security).

```dart
// Auth Provider: Firebase
// App Type: Flutter Dart
// Private Key API: OpenAI

import 'package:firebase_auth/firebase_auth.dart';
import 'package:dart_openai/dart_openai.dart';


OpenAI.baseUrl =
 "https://edge.backmesh.com/appid/proxyname";
// set api secret key to jwt
OpenAI.apiKey = await FirebaseAuth.instance.currentUser
 .getIdToken();
await OpenAI.instance.chat(...)
```


## ⚡️ Try out Backmesh

Get started with Backmesh using our documentation. Visit [backmesh.com/docs](https://backmesh.com/docs)

## 🚀 Contribute

To contribute, visit [Contributing.md](./CONTRIBUTING.md)