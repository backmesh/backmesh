---
title: Quickly compare cost and results of different LLMs on the same prompt
description: LLMcomp sends one prompt to several LLMs and shows each one's answer, token counts, cost and latency side by side. Built on tokencost-js, a JavaScript port of AgentOps' tokencost.
date: 2025-03-03
lastUpdated: 2026-11-27
authors: backmesh
tags:
  - Showcase
excerpt: A small site that sends one prompt to several LLMs and shows each answer with its token counts, cost and latency, built on tokencost-js.
head:
  - tag: title
    content: 'LLMcomp: compare LLM cost and results on the same prompt | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"BlogPosting","headline":"Quickly compare cost and results of different LLMs on the same prompt","datePublished":"2025-03-03","dateModified":"2026-11-27","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/llmcomp/"}'
---

_We wrote this post in 2025, when backmesh was a backend for LLM APIs.
backmesh now [runs GitHub Actions runners](/) in your own cloud._

I often want a quick comparison of different LLMs to see the result, price and
latency of the same task or prompt.

So I put together LLMcomp, a small site that sends one prompt to a few popular
LLMs and shows, for each one, its answer, the prompt and completion token
counts, the cost and how long it took. It had Claude Sonnet, DeepSeek and
GPT-4o, the ones I compare most.

It estimates costs with
[tokencost-js](https://github.com/backmesh/tokencost), a JavaScript port of
AgentOps' [tokencost](https://github.com/AgentOps-AI/tokencost) that runs in
the browser. It counts tokens and prices them from a table of each model's
per-token prices. The site is about 400 lines, and its code is in the
repository's [`demo/`](https://github.com/backmesh/tokencost/tree/main/demo)
folder. llmcomp.backmesh.com went offline with the old product.
