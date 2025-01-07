# Backmesh, Firebase for LLM APIs

Backmesh is Typescript backend hosted on Cloudflare Workers that lets you securely call LLM APIs from your mobile or web app without spinning up a new backend. Simply call Backmesh directly instead of the LLM API with the user's JWT from the app's authentication provider e.g. Supabase or Firebase Authentication. Backmesh will act as a proxy to the LLM APIs and apply configurable rate limits per user to prevent abuse (e.g. no more than 5 OpenAI API calls per hour per user). For more details, see the [security documentation](https://backmesh.com/docs/security).

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

## Get started

Backmesh can be deployed to your own Cloudflare account. Check out the pricing and [usage limits](https://developers.cloudflare.com/workers/platform/limits/) for the different Cloudflare worker plans or use our [hosted SaaS](https://app.backmesh.com) with [pricing plans](https://backmesh.com/pricing/) starting at $8 per month.

## Contribute

To contribute, visit [Contributing.md](./CONTRIBUTING.md)