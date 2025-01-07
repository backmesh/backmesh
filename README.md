<p align="center">
  <img src="https://backmesh.com/img/logo.png" width="80"/>
</p>

<h1 align="center">Backmesh, Firebase for LLM APIs</h1>

Backmesh is throughly tested Typescript proxy backend hosted on Cloudflare Workers that lets you securely call LLM APIs from your mobile or web app using any LLM SDK. Supply the Backmesh URL and the authenticated user's JWT to the LLM SDK instead of the LLM API url and private key. Backmesh will authenticate the request and use your LLM private API key to proxy to the LLM APIs with configurable rate limits per user to prevent abuse (e.g. no more than 5 OpenAI API calls per hour per user). For more details, see the [security documentation](https://backmesh.com/docs/security).

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