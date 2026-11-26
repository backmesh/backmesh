---
title: 3 common mistakes when integrating the OpenAI API with your web or mobile app
description: How a client-side app leaks its OpenAI API key or its users' data, through a key in frontend code, an unauthenticated proxy, or an authenticated proxy without per-user limits and permissions.
date: 2025-02-13
lastUpdated: 2026-11-26
authors: backmesh
tags:
  - Guides
excerpt: A key in frontend code, an unauthenticated proxy, and an authenticated proxy without per-user limits or permissions. What each one exposes, and the three safeguards a backend for the OpenAI API needs.
head:
  - tag: title
    content: '3 OpenAI API integration mistakes that leak your key or user data | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"BlogPosting","headline":"3 common mistakes when integrating the OpenAI API with your web or mobile app","datePublished":"2025-02-13","dateModified":"2026-11-26","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/openai-api-mistakes/"}'
---

_We wrote this post in 2025, when backmesh was a backend for LLM APIs.
backmesh now [runs GitHub Actions runners](/) in your own cloud._

A leaked OpenAI API key lets anyone run up your bill, and a web or mobile app
that calls OpenAI’s language models has to keep its key private. If you want to
keep complexity low and release features quickly, setting up a fully fledged
backend just to safeguard an API key can be time consuming. In this article, you’ll
learn how to avoid the most common security mistakes when integrating the
OpenAI API into a client-side app. Overlooking these pitfalls can leave the
door open to OpenAI API misuse, which can:

- Lead to unexpected or excessive charges on your OpenAI account
- Violate OpenAI’s Acceptable Use Policy and Terms of Service
- Potentially expose your project to spam or abusive behavior

## Mistake # 1: Storing the OpenAI Key in Frontend Code

Putting your API key directly in client-side code (using any type of web or
mobile framework) as shown in the sample frontend code below is tempting, but
also very risky.

```javascript title="client/openai.ts"
import OpenAI from 'openai';

const client = new OpenAI({
  dangerouslyAllowBrowser: true,
  apiKey: 'sk-proj-YOURSECRETKEY',
});

const completion = await client.chat.completions.create({...});
```

OpenAI now recommends the
[Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
for new apps; Chat Completions, used here, is still supported.

Anyone can inspect your code (even if it is minified or obfuscated somehow),
extract your key, and abuse it. Don't let
[this](https://community.openai.com/t/repeated-fraudulent-use-of-my-api-keys/510465/3)
happen to you. The OpenAI SDK requires the `dangerouslyAllowBrowser` flag to
try to prevent this problem and make sure you add a layer of protection that
keeps the secret key away from the end user’s browser or device.

## Mistake # 2: Using an Unauthenticated Proxy

Putting your OpenAI API key as a secret in a hosted server or cloud function
and calling that endpoint from your client is much better than exposing it
directly, but it is still unsafe. Let's take the following client-side
application code:

```javascript title="client/openai.ts"
const opair = await fetch(
  'https://functionroute.yourcloud.com/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({...}),
  },
);
```

Alongside the cloud function OpenAI API proxy it is calling:

```typescript title="cloud/function.ts"
import route from 'yourcloud';

route.all('/', async (req, res) => {
  const opair = await fetch(`https://api.openai.com/${req.path}`, {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_SECRET_KEY}`,
    },
    body: req.method === 'GET' ? undefined : req.body.clone(),
  });
  return res.send(opair);
});
```

Since this proxy is publicly accessible, an attacker could bypass your app and
access your OpenAI API even without your private key at
`https://functionroute.yourcloud.com/`.

## Mistake # 3: Using an Authenticated Proxy without Permissions

Putting your OpenAI API key as a secret in a hosted server or cloud function
and adding authentication so only your users can call the proxy endpoint is
quite common and still much better than the setups laid out thus far. However,
it is _still_ unsafe. Let's take the following frontend code:

```javascript title="client/openai.ts"
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(...);
const jwt = (await supabase.auth.getSession()).data.session?.access_token;

const opair = await fetch(
  'https://functionroute.yourcloud.com/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({...}),
  },
);
```

Alongside the cloud function OpenAI API authenticated proxy it is calling:

```typescript title="cloud/function.ts"
import route from 'yourcloud';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(...);

route.all('/', async (req, res) => {
  try {
    // 1. Get the token from the Authorization header
    const authHeader = req.headers['authorization'] || '';
    const jwt = authHeader.split(' ')[1]; // Bearer <token>

    if (!jwt) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // 2. Verify the token with Supabase
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(jwt);
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 3. The token is valid
    const opair = await fetch(`https://api.openai.com/${req.path}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_SECRET_KEY}`,
      },
      body: req.method === 'GET' ? undefined : req.body.clone(),
    });
    return res.send(opair);
  } catch (error) {
    console.error(error);
    return res.status(401).json({ error: 'Invalid token' });
  }
});
```

This backend integration for the OpenAI API looks fine at first glance and
provides some safety. However, there are two problems with it:

1. There are no limits to how many times a given user can call your OpenAI API
   proxy. Any user can call this API proxy up to the default account
   [rate limits](https://developers.openai.com/api/docs/guides/rate-limits) for
   the OpenAI API associated with your private API key by simply getting their
   JWT and calling the proxy at `https://functionroute.yourcloud.com/v1/`. The
   JWTs, or authentication tokens, typically expire within an hour. That means
   that someone can generate a token from your client-side code and (mis)use it
   until it expires. Then rinse and repeat.
2. OpenAI, and other LLM APIs, have endpoints that allow uploading
   [files](https://developers.openai.com/api/reference/resources/files) for
   augmented analysis and storing conversation state with chat history. This
   backend does not provide any permissions or access control over _which_
   users uploaded or created _which_ private resources in the OpenAI API. This
   means that any user with just their JWT can see all the files and
   conversations ever created with your OpenAI API key. This exposes the data
   and privacy of your end users. The following frontend code will call the
   OpenAI API
   [list files](https://developers.openai.com/api/reference/resources/files/methods/list)
   endpoint, which returns all the files ever uploaded regardless of the user
   that uploaded them:

```javascript title="vulnerability.ts"
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(...);
const jwt = (await supabase.auth.getSession()).data.session?.access_token;

const opair = await fetch('https://functionroute.yourcloud.com/v1/files', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
  },
});
```

## Building a safe integration

To prevent the vulnerabilities laid out thus far, implement the following
safeguards in your backend:

- Require valid credentials (for example token-based auth) so you know exactly
  who is calling your proxy.
- Track usage and set limits per user, such as a number of requests per minute,
  so no single user can run up your OpenAI bill.
- Enforce permissions on resources: only the user who created a file or a
  conversation can read or change it.
