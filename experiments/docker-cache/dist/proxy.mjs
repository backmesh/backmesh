// experiments/docker-cache/proxy.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import {
  access as access2,
  mkdir,
  readdir,
  readFile as readFile2,
  rm,
  stat,
  writeFile as writeFile2
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join as join2 } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep2 } from "node:timers/promises";
import { pipeline } from "node:stream/promises";

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

// experiments/docker-cache/proxy.ts
var [port = "4231", statsFile = "docker-cache-proxy.json"] = process.argv.slice(2), staging = dirname(statsFile), DIR = "docker/", MANIFEST_WAIT_MS = 30000, LOOKUP_MS = 20000, stats = {
  started: Date.now(),
  cloud: "",
  tokenWaitMs: 0,
  reads: 0,
  hits: 0,
  misses: 0,
  bytesRead: 0,
  writes: 0,
  bytesWritten: 0,
  dropped: 0,
  incomplete: 0,
  errors: [],
  tokens: []
}, log = (o) => console.log(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...o })), exists = (p) => access2(p).then(() => !0, () => !1);
async function current(waitMs = 0) {
  let start = Date.now();
  for (;; ) {
    let f;
    for (let p of tokenPaths(process.env))
      if (!f && await exists(p))
        f = await read(p).catch(() => {
          return;
        });
    if (f?.state !== "pending" || Date.now() - start >= waitMs)
      return stats.tokenWaitMs += Date.now() - start, f?.state === "ready" ? f : void 0;
    await sleep2(500);
  }
}
function noteToken(file) {
  let id = createHash2("sha256").update(JSON.stringify(file.tokens.map((t) => t.credentials))).digest("hex").slice(0, 12), t = stats.tokens.at(-1);
  if (t?.id !== id)
    t = { at: Date.now(), id, expiresAt: file.expiresAt, ok: 0 }, stats.tokens.push(t), stats.cloud = file.cloud, log({ msg: "token", id, expiresAt: new Date(file.expiresAt) });
  return t;
}
var used, tokens = async () => {
  if (used = await current(), !used)
    throw Error("no token yet");
  return used;
}, local = process.env.DOCKER_CACHE_LOCAL_STORE, store = local ? {
  async list(prefix) {
    await tokens();
    let dir = join2(local, prefix);
    if (!await exists(dir))
      return [];
    return (await readdir(dir)).map((f) => `${prefix}${f}`);
  },
  async get(k) {
    if (await tokens(), !await exists(join2(local, k)))
      throw Error(`GET ${k}: 404 `);
    return new Response(await readFile2(join2(local, k)));
  },
  async put(k, body) {
    await tokens(), await mkdir(dirname(join2(local, k)), { recursive: !0 }), await writeFile2(join2(local, k), Buffer.from(await body.arrayBuffer()));
  }
} : openStore(tokens), status = (e) => Number(/: (\d{3}) /.exec(String(e.message))?.[1] ?? 0), key = (ref) => ref.replace(":", "-"), refs = (file, own = !1) => file ? [
  ...new Set((own ? [file.prefixes.own] : [file.prefixes.own, file.prefixes.base, file.prefixes.default]).filter((p) => !!p))
] : [];
async function find(at, name) {
  for (let ref of at)
    try {
      let res = await store.get(`${ref}${DIR}${name}`);
      return noteToken(used).ok++, res;
    } catch (e) {
      if (status(e) !== 404 && status(e) !== 403)
        throw e;
      noteToken(used).ok++;
    }
  return;
}
var within = (ms, p) => Promise.race([p, sleep2(ms).then(() => {
  return;
})]);
async function findManifest(at, name) {
  for (let ref of at) {
    let res = await find([ref], name);
    if (!res)
      continue;
    let body = Buffer.from(await res.arrayBuffer()), m = JSON.parse(body.toString()), blobs = new Set(await store.list(`${ref}${DIR}blobs/`)), missing = [m.config, ...m.layers ?? []].filter((d) => !d || !blobs.has(`${ref}${DIR}blobs/${key(d.digest)}`)).length;
    if (!missing)
      return { body, type: m.mediaType };
    stats.incomplete++, log({ msg: "incomplete manifest", ref, missing });
  }
  return;
}
async function save(file, name, body) {
  if (!file?.prefixes.own)
    return void stats.dropped++;
  await store.put(`${file.prefixes.own}${DIR}${name}`, body), noteToken(used).ok++, stats.writes++, stats.bytesWritten += body.size;
}
var uploads = /* @__PURE__ */ new Map, BLOB = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/, UPLOAD = /^\/v2\/(.+)\/blobs\/uploads\/([^/]*)$/, MANIFEST = /^\/v2\/(.+)\/manifests\/([^/]+)$/;
createServer(async (req, res) => {
  let url = new URL(req.url, "http://x"), path = url.pathname, file = await current(), m;
  try {
    if (path === "/v2/" || path === "/v2")
      return res.writeHead(200, { "docker-distribution-api-version": "registry/2.0" }), res.end();
    if ((m = BLOB.exec(path)) && (req.method === "GET" || req.method === "HEAD")) {
      stats.reads++;
      let found = await within(LOOKUP_MS, find(refs(file, req.method === "HEAD"), `blobs/${key(m[2])}`));
      if (!found)
        return stats.misses++, res.writeHead(404), res.end();
      stats.hits++;
      let size = found.headers.get("content-length");
      if (res.writeHead(200, {
        "docker-content-digest": m[2],
        "content-type": "application/octet-stream",
        ...size && { "content-length": size }
      }), req.method === "HEAD")
        return await found.body?.cancel(), res.end();
      return stats.bytesRead += Number(size ?? 0), await pipeline(Readable.fromWeb(found.body), res);
    }
    if (m = UPLOAD.exec(path)) {
      let name = m[1], id = m[2];
      if (req.method === "POST" && !id)
        id = randomUUID(), uploads.set(id, join2(staging, `upload-${id}`)), await writeFile2(uploads.get(id), "");
      let staged = uploads.get(id);
      if (!staged)
        return res.writeHead(404), res.end();
      await pipeline(req, createWriteStream(staged, { flags: "a" }));
      let digest = url.searchParams.get("digest");
      if (req.method === "PUT" || req.method === "POST" && digest) {
        uploads.delete(id);
        let hash = createHash2("sha256");
        if (await pipeline(createReadStream(staged), hash), `sha256:${hash.digest("hex")}` !== digest)
          return await rm(staged, { force: !0 }), res.writeHead(400), res.end();
        return await save(file, `blobs/${key(digest)}`, await openAsBlob(staged)), await rm(staged, { force: !0 }), res.writeHead(201, {
          location: `/v2/${name}/blobs/${digest}`,
          "docker-content-digest": digest
        }), res.end();
      }
      let { size } = await stat(staged);
      return res.writeHead(202, {
        location: `/v2/${name}/blobs/uploads/${id}`,
        "docker-upload-uuid": id,
        range: `0-${Math.max(size - 1, 0)}`
      }), res.end();
    }
    if (m = MANIFEST.exec(path)) {
      let ref = m[2];
      if (req.method === "PUT") {
        let chunks = [];
        for await (let c of req)
          chunks.push(c);
        let body = Buffer.concat(chunks), digest = `sha256:${createHash2("sha256").update(body).digest("hex")}`;
        for (let at of /* @__PURE__ */ new Set([ref, digest]))
          await save(file, `manifests/${key(at)}`, new Blob([body]));
        return res.writeHead(201, {
          location: `/v2/${m[1]}/manifests/${digest}`,
          "docker-content-digest": digest
        }), res.end();
      }
      if (req.method === "GET" || req.method === "HEAD") {
        stats.reads++;
        let ready = file ?? await current(MANIFEST_WAIT_MS), found = await within(LOOKUP_MS, findManifest(refs(ready), `manifests/${key(ref)}`));
        if (!found)
          return stats.misses++, res.writeHead(404), res.end();
        stats.hits++;
        let { body } = found;
        stats.bytesRead += body.length;
        let type = found.type ?? "application/vnd.oci.image.index.v1+json";
        return res.writeHead(200, {
          "content-type": type,
          "content-length": body.length,
          "docker-content-digest": `sha256:${createHash2("sha256").update(body).digest("hex")}`
        }), res.end(req.method === "HEAD" ? void 0 : body);
      }
    }
    res.writeHead(405), res.end();
  } catch (e) {
    let msg = `${req.method} ${path}: ${e.message}`;
    if (stats.errors.length < 50)
      stats.errors.push(msg);
    if (log({ msg: "error", error: msg }), req.method === "GET" || req.method === "HEAD")
      stats.misses++;
    if (!res.headersSent)
      res.writeHead(req.method === "HEAD" || req.method === "GET" ? 404 : 500);
    res.end();
  }
}).listen(Number(port), "127.0.0.1", () => log({ msg: "listening", port }));
for (let signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await writeFile2(statsFile, `${JSON.stringify(stats, null, 2)}
`), process.exit(0);
  });
