// experiments/sccache/proxy.ts
import { createHash as createHash2 } from "node:crypto";
import { access as access2, writeFile as writeFile2 } from "node:fs/promises";
import { createServer } from "node:http";

// src/cache/store.ts
import { createHash, createHmac } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// src/github/retry.ts
import { setTimeout as delay } from "node:timers/promises";
var WAIT_MIN_MS = 1000, WAIT_MAX_MS = 30000, RETRY_AFTER_MAX_MS = 60000, sleepFor = (ms, signal) => delay(ms, void 0, { signal });
function retryingFetch(inner, options = {}) {
  let {
    max = 4,
    attemptTimeoutMs = 300000,
    sleep = sleepFor,
    random = Math.random,
    log
  } = options;
  return async (input, init) => {
    let callerSignal = init?.signal ?? void 0;
    for (let attempt = 0;; attempt++) {
      let signals = [AbortSignal.timeout(attemptTimeoutMs)];
      if (callerSignal)
        signals.push(callerSignal);
      let response, error;
      try {
        response = await inner(input, {
          ...init,
          signal: AbortSignal.any(signals)
        });
      } catch (caught) {
        if (callerSignal?.aborted)
          throw caught;
        error = caught;
      }
      if (response && !isTransient(response.status))
        return response;
      if (attempt >= max) {
        if (response)
          return response;
        throw error;
      }
      let wait = backoff(attempt, response, random);
      log?.({
        msg: "retrying request",
        url: redact(input),
        status: response?.status,
        error: error instanceof Error ? error.message : void 0,
        attempt: attempt + 1,
        waitMs: wait
      }), await response?.body?.cancel(), await sleep(wait, callerSignal);
    }
  };
}
function isTransient(status) {
  return status === 429 || status >= 500 && status !== 501;
}
function backoff(attempt, response, random) {
  if (response?.status === 429 || response?.status === 503) {
    let retryAfter = response.headers.get("retry-after")?.trim();
    if (retryAfter && /^\d+$/.test(retryAfter))
      return Math.min(Number(retryAfter) * 1000, RETRY_AFTER_MAX_MS);
  }
  let base = WAIT_MIN_MS * 2 ** attempt;
  if (base >= WAIT_MAX_MS)
    return WAIT_MAX_MS;
  return Math.min(base + Math.floor(random() * (base / 2 + 1)), WAIT_MAX_MS);
}
function redact(input) {
  let url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.origin}${url.pathname}`;
}

// src/cache/format.ts
var SECRET_KEY = "BACKMESH_CACHE", secretName = (runner) => `_bm-cache-${runner}`;
var AUTO_PREFIX = "bm-auto-", AUTO_RECORD = `${AUTO_PREFIX}job-`;

// src/cache/store.ts
var TOKEN_COPY = ".backmesh-cache";
function tokenPaths(env) {
  let { RUNNER_NAME: name, RUNNER_TEMP: temp } = env;
  return [
    ...name ? [`/run/anycloud-secrets/${secretName(name)}/${SECRET_KEY}`] : [],
    ...temp ? [join(temp, TOKEN_COPY)] : [],
    `/__w/_temp/${TOKEN_COPY}`
  ];
}
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return await sleep(200), JSON.parse(await readFile(path, "utf8"));
  }
}
var enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), hmac = (key, data) => createHmac("sha256", key).update(data).digest();
function signS3(method, url, headers, creds, region, now, payload = "UNSIGNED-PAYLOAD") {
  let date = now.toISOString().replace(/[-:]|\.\d{3}/g, ""), all = {
    ...headers,
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": date,
    ...creds.sessionToken && { "x-amz-security-token": creds.sessionToken }
  }, names = Object.keys(all).sort(), query = [...url.searchParams].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"), canonical = [
    method,
    url.pathname,
    query,
    names.map((n) => `${n}:${all[n].trim()}
`).join(""),
    names.join(";"),
    payload
  ].join(`
`), scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`, key = hmac(`AWS4${creds.secretAccessKey}`, date.slice(0, 8));
  for (let part of [region, "s3", "aws4_request"])
    key = hmac(key, part);
  let toSign = `AWS4-HMAC-SHA256
${date}
${scope}
${createHash("sha256").update(canonical).digest("hex")}`, signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  };
}
var tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => m[1]);
function openStore(tokens, fetch = globalThis.fetch, signal) {
  let quick = retryingFetch(fetch, { max: 3, attemptTimeoutMs: 30000 }), slow = retryingFetch(fetch, { max: 3, attemptTimeoutMs: 1800000 });
  async function send(method, key, init = {}, query = {}) {
    let file = await tokens(), token = file.tokens.find((t) => t.prefixes.some((p) => key.startsWith(p)));
    if (!token)
      throw Error(`no token covers ${key}`);
    let c = token.credentials, path = Object.keys(query).length ? "" : `/${key}`, base = {
      aws: `https://${file.bucket}.s3.${file.region}.amazonaws.com`,
      gcp: `https://storage.googleapis.com/${file.bucket}`,
      azure: `${file.accountUrl?.replace(/\/$/, "")}/${file.bucket}`
    }[file.cloud], url = new URL(`${base}${path}${"sasToken" in c ? `?${c.sasToken}` : ""}`);
    for (let [k, v] of Object.entries(query))
      if (v)
        url.searchParams.set(k, v);
    let headers = { ...init.headers };
    if ("sessionToken" in c)
      headers = signS3(method, url, headers, c, file.region, /* @__PURE__ */ new Date);
    if ("accessToken" in c)
      headers.authorization = `Bearer ${c.accessToken}`;
    if ("sasToken" in c)
      headers["x-ms-version"] = "2021-08-06";
    let res = await (!path || key.endsWith("/manifest.json") ? quick : slow)(url, {
      ...init,
      method,
      headers,
      signal
    });
    if (!res.ok)
      throw Error(`${method} ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { res, azure: file.cloud === "azure" };
  }
  return {
    async list(prefix) {
      let keys = [];
      for (let next, first = !0;first || next; first = !1) {
        let azure = (await tokens()).cloud === "azure", xml = await (await send("GET", prefix, {}, azure ? { restype: "container", comp: "list", prefix, marker: next } : { "list-type": "2", prefix, "continuation-token": next })).res.text();
        keys.push(...tag(xml, azure ? "Name" : "Key")), next = tag(xml, azure ? "NextMarker" : "NextContinuationToken")[0];
      }
      return keys;
    },
    async get(key) {
      return (await send("GET", key)).res;
    },
    async put(key, body) {
      let headers = {
        "content-length": String(body.size),
        "x-ms-blob-type": "BlockBlob"
      };
      await (await send("PUT", key, { body, headers })).res.body?.cancel();
    }
  };
}

// experiments/sccache/proxy.ts
var [port = "4226", statsFile = "sccache-proxy.json"] = process.argv.slice(2), DIR = "sccache/", stats = {
  started: Date.now(),
  cloud: "",
  gets: 0,
  hits: 0,
  misses: 0,
  bytesRead: 0,
  puts: 0,
  bytesWritten: 0,
  dropped: 0,
  errors: [],
  tokens: []
}, log = (o) => console.log(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...o })), exists = (p) => access2(p).then(() => !0, () => !1);
async function current() {
  for (let p of tokenPaths(process.env))
    if (await exists(p)) {
      let f = await read(p).catch(() => {
        return;
      });
      return f?.state === "ready" ? f : void 0;
    }
  return;
}
function noteToken(file) {
  let id = createHash2("sha256").update(JSON.stringify(file.tokens.map((t) => t.credentials))).digest("hex").slice(0, 12), t = stats.tokens.at(-1);
  if (t?.id !== id)
    t = { at: Date.now(), id, expiresAt: file.expiresAt, ok: 0 }, stats.tokens.push(t), stats.cloud = file.cloud, log({ msg: "token", id, expiresAt: new Date(file.expiresAt) });
  return t;
}
var written = /* @__PURE__ */ new Map, used, store = openStore(async () => {
  if (used = await current(), !used)
    throw Error("no token yet");
  return used;
}), status = (e) => Number(/: (\d{3}) /.exec(String(e.message))?.[1] ?? 0);
async function body(req) {
  let chunks = [];
  for await (let c of req)
    chunks.push(c);
  return new Blob(chunks);
}
createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "").replace(/\.\./g, ""), file = await current();
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (stats.gets++, file)
        for (let at of new Set([file.prefixes.own, file.prefixes.base, file.prefixes.default].filter(Boolean)))
          try {
            let r = await store.get(`${at}${DIR}${path}`), data = Buffer.from(await r.arrayBuffer());
            return noteToken(used).ok++, stats.hits++, stats.bytesRead += data.length, res.writeHead(200, { "content-length": data.length }), res.end(req.method === "HEAD" ? void 0 : data);
          } catch (e) {
            if (status(e) !== 404 && status(e) !== 403)
              throw e;
            noteToken(used).ok++;
          }
      return stats.misses++, res.writeHead(404), res.end();
    }
    if (req.method === "PUT") {
      let data = await body(req);
      if (written.set(path, data.size), !file?.prefixes.own)
        return stats.dropped++, res.writeHead(201), res.end();
      return await store.put(`${file.prefixes.own}${DIR}${path}`, data), noteToken(used).ok++, stats.puts++, stats.bytesWritten += data.size, res.writeHead(201), res.end();
    }
    if (req.method === "MKCOL")
      return res.writeHead(201), res.end();
    if (req.method === "PROPFIND") {
      let dir = !path || path.endsWith("/"), size = written.get(path);
      if (!dir && size === void 0)
        return res.writeHead(404), res.end();
      let prop = dir ? "<D:resourcetype><D:collection/></D:resourcetype>" : `<D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength>`;
      return res.writeHead(207, { "content-type": "application/xml" }), res.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/${path}</D:href><D:propstat><D:prop>${prop}<D:getlastmodified>${(/* @__PURE__ */ new Date()).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
    }
    res.writeHead(405), res.end();
  } catch (e) {
    let msg = `${req.method} ${path}: ${e.message}`;
    if (stats.errors.length < 50)
      stats.errors.push(msg);
    if (log({ msg: "error", error: msg }), req.method === "PUT")
      stats.dropped++;
    else
      stats.misses++;
    res.writeHead(req.method === "PUT" ? 201 : 404), res.end();
  }
}).listen(Number(port), "127.0.0.1", () => log({ msg: "listening", port }));
for (let signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await writeFile2(statsFile, `${JSON.stringify(stats, null, 2)}
`), process.exit(0);
  });
