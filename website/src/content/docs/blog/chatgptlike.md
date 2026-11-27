---
title: Built a ChatGPT-like app with no backend/functions at ~1k LOC
description: A ChatGPT-like chat app in about 1,000 lines of Flutter, with Firebase Authentication and Firestore security rules and no server or cloud function of its own.
date: 2025-01-31
lastUpdated: 2026-11-27
authors: backmesh
tags:
  - Showcase
excerpt: A ChatGPT-like app in about 1,000 lines of Flutter, Firebase Authentication and Firestore, with no server or cloud function of its own.
head:
  - tag: title
    content: 'A ChatGPT-like Flutter app with no backend in ~1k lines | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"BlogPosting","headline":"Built a ChatGPT-like app with no backend/functions at ~1k LOC","datePublished":"2025-01-31","dateModified":"2026-11-27","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/chatgptlike/"}'
---

_We wrote this post in 2025, when backmesh was a backend for LLM APIs.
backmesh now [runs GitHub Actions runners](/) in your own cloud._

I built a ChatGPT-like app using Flutter, Firebase Authentication and
Firestore. It is about 1,000 lines of code with no backend of its own: no
server and no cloud function. It runs on the web, and since it is built with
Flutter, it could also run on mobile or desktop.

![The app: a chat list on the left and a conversation on the right](https://github.com/backmesh/flutter-chatgpt/blob/main/demo.gif?raw=true)

How it fits together:

- Firebase Authentication signs users in with email.
- Firestore keeps each user's chats and messages, and its security rules let
  only the signed-in user read or write their own.
- The app called Google's Gemini API through the backmesh LLM proxy, which
  kept the Gemini key out of the app. That proxy is gone, so the
  [live demo](https://flutter-chatgpt.pages.dev) no longer gets replies.

The source code is at
[backmesh/flutter-chatgpt](https://github.com/backmesh/flutter-chatgpt).
