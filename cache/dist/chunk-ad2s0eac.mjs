// src/cache/format.ts
import { createHash } from "node:crypto";
var SECRET_KEY = "BACKMESH_CACHE", secretName = (runner) => `_bm-cache-${runner}`;
var sha = (s) => createHash("sha256").update(s).digest("hex");
var entryVersion = (paths) => sha([...paths, "backmesh-pieces-1"].join("|")).slice(0, 32), esc = (key) => [...Buffer.from(key)].map((b) => /[\w-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""), unesc = (seg) => Buffer.from(seg.match(/~[0-9A-F]{2}|./g).map((p) => p.length === 3 ? parseInt(p.slice(1), 16) : p.charCodeAt(0))).toString(), AUTO_PREFIX = "bm-auto-", AUTO_RECORD = `${AUTO_PREFIX}job-`, MAX_ESCAPED_KEY = 700;

// src/cache/pieces.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
var MAX_PIECE = 4831838208, MIN_PIECE = 8388608, PACKED = /\.(gz|tgz|zst|xz|bz2|lz4|br|7z|zip|jar|war|whl|nupkg|apk|deb|rpm|png|jpe?g|gif|webp|mp[34]|webm|woff2?|pack)$/i;
function planPieces(members) {
  let files = members.filter((m) => !m.dir), total = files.reduce((sum, m) => sum + m.size, 0), count = Math.max(1, Math.min(Math.max(32, Math.ceil(total / MAX_PIECE)), Math.ceil(total / MIN_PIECE), files.length)), packed = files.filter((m) => PACKED.test(m.name)), packedBytes = packed.reduce((sum, m) => sum + m.size, 0), raw = packed.length && packed.length < files.length ? Math.min(count - 1, Math.max(1, Math.round(count * packedBytes / (total || 1)))) : 0, piece = (zstd) => ({
    zstd,
    members: [],
    bytes: 0
  }), groups = [
    ...Array.from({ length: count - raw }, () => piece(!0)),
    ...Array.from({ length: raw }, () => piece(!1))
  ];
  for (let m of [...files].sort((a, b) => b.size - a.size)) {
    let zstd = !raw || !PACKED.test(m.name), g = groups.filter((x) => x.zstd === zstd).reduce((a, b) => b.bytes < a.bytes ? b : a);
    g.members.push(m.name), g.bytes += m.size;
  }
  let pieces = groups.filter((g, i) => i === 0 || g.members.length);
  return pieces[0].members.unshift(...members.filter((m) => m.dir).map((m) => m.name)), pieces.map((p, i) => ({
    ...p,
    name: `p${String(i).padStart(2, "0")}.tar${p.zstd ? ".zst" : ""}`
  }));
}
var FAIL = "BMFAIL";
function sh(script, args, stdin) {
  let child = spawn("sh", ["-c", script, "sh", ...args], {
    stdio: [stdin, "ignore", "pipe"]
  }), err = "", failed = !1;
  child.stderr.on("data", (d) => {
    err += d.toString(), failed ||= err.includes(FAIL), err = err.slice(-800);
  });
  let done = new Promise((ok, fail) => {
    child.on("error", fail), child.on("close", (code) => code === 0 && !failed ? ok() : fail(Error(`${args[0]}: ${err.trim()}`)));
  });
  return { child, done };
}
async function buildPiece(piece, cwd, dir) {
  let list = join(dir, `${piece.name}.list`), out = join(dir, piece.name);
  await writeFile(list, piece.members.map((m) => `${m}\x00`).join(""));
  let tar = 'tar -c -P --no-recursion --null --verbatim-files-from -C "$2" -T "$3" -f -', zstd = piece.zstd ? "zstd -1 -q -c -T1" : "cat";
  await sh(`{ ${tar} || echo ${FAIL} >&2; } | { ${zstd} || echo ${FAIL} >&2; } >"$1"`, [out, cwd, list], "ignore").done;
}
var zstdCli;
async function restorePiece(store, prefix, piece, workspace, absolute = !0) {
  zstdCli ??= spawnSync("zstd", ["--version"]).status === 0;
  let body = Readable.fromWeb((await store.get(`${prefix}${piece.name}`)).body), decode = piece.zstd && zstdCli ? "zstd -d -q -c" : "cat", { child, done } = sh(`{ ${decode} || echo ${FAIL} >&2; } | { tar -x ${absolute ? "-P " : ""}-C "$1" -f - || echo ${FAIL} >&2; cat >/dev/null; }`, [workspace], "pipe"), stages = piece.zstd && !zstdCli ? [body, createZstdDecompress(), child.stdin] : [body, child.stdin], failed = (await Promise.allSettled([
    done,
    pipeline(stages)
  ])).find((r) => r.status === "rejected");
  if (failed)
    throw failed.reason;
}
async function makeParents(workspace, members) {
  let dirs = [...new Set(members.map((m) => dirname(resolve(workspace, m))))];
  await Promise.all(dirs.map((d) => mkdir(d, { recursive: !0 })));
}

// src/cache/snapshot.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openAsBlob } from "node:fs";
import {
  lstat,
  mkdir as mkdir2,
  readdir,
  readFile as readFile2,
  rm,
  writeFile as writeFile3
} from "node:fs/promises";
import { dirname as dirname2, join as join3, relative, resolve as resolve2 } from "node:path";

// src/cache/store.ts
import { createHash as createHash2, createHmac } from "node:crypto";
import { access, readFile, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
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

// src/cache/store.ts
var TOKEN_COPY = ".backmesh-cache", NO_TOKEN_MARK = ".backmesh-cache-off";
function tokenPaths(env) {
  let { RUNNER_NAME: name, RUNNER_TEMP: temp } = env;
  return [
    ...name ? [`/run/anycloud-secrets/${secretName(name)}/${SECRET_KEY}`] : [],
    ...temp ? [join2(temp, TOKEN_COPY)] : [],
    `/__w/_temp/${TOKEN_COPY}`
  ];
}
var exists = (p) => access(p).then(() => !0, () => !1);
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return await sleep(200), JSON.parse(await readFile(path, "utf8"));
  }
}
async function openCache(env = process.env, waitMs = 20000) {
  let mark = env.RUNNER_TEMP && join2(env.RUNNER_TEMP, NO_TOKEN_MARK);
  if (mark && await exists(mark))
    return { state: "off", reason: "no token yet" };
  let path;
  for (let p of tokenPaths(env))
    if (!path && await exists(p))
      path = p;
  if (!path)
    return { state: "off", reason: "no token file" };
  let deadline = Date.now() + waitMs, file = await read(path);
  while (file.state === "pending" && Date.now() < deadline)
    await sleep(1000), file = await read(path);
  if (file.state === "pending") {
    if (mark)
      await writeFile2(mark, "").catch(() => {
        return;
      });
    return { state: "off", reason: "no token yet" };
  }
  if (file.state === "off")
    return file;
  return { state: "ready", file, tokens: async () => {
    let now = await read(path);
    return now.state === "ready" ? now : file;
  } };
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
${createHash2("sha256").update(canonical).digest("hex")}`, signature = createHmac("sha256", key).update(toSign).digest("hex");
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
async function entries(store, ref, wanted, version) {
  return (await store.list(`${ref}e/${esc(wanted)}`)).map((k) => k.slice(ref.length).split("/")).filter((p) => p.length === 5 && p[2] === version && p[4] === "manifest.json").map((p) => ({
    key: unesc(p[1]),
    id: p[3],
    prefix: `${ref}e/${p[1]}/${version}/${p[3]}/`
  })).filter((e) => e.key.startsWith(wanted)).sort((a, b) => a.id < b.id ? 1 : -1);
}
async function findEntry(store, prefixes, version, key, restoreKeys) {
  let seen = /* @__PURE__ */ new Set;
  for (let ref of ["own", "base", "default"]) {
    let at = prefixes[ref];
    if (!at || seen.has(at))
      continue;
    seen.add(at);
    for (let [i, wanted] of [key, ...restoreKeys].entries()) {
      let found = await entries(store, at, wanted, version), pick = i === 0 && found.find((e) => e.key === key) || found[0];
      if (pick)
        return { ref, key: pick.key, prefix: pick.prefix };
    }
  }
  return;
}
var hasEntry = async (store, own, version, key) => (await entries(store, own, key, version)).some((e) => e.key === key), readManifest = async (store, prefix) => await (await store.get(`${prefix}manifest.json`)).json();

// src/cache/snapshot.ts
var PLANS_DIR = "_backmesh-cache", newUploadId = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`, workDir = (workspace) => resolve2(workspace, "../..");
async function snapshot(paths, dir) {
  let under = (p, q) => p === q || p.startsWith(`${q}/`), plans = dirname2(dir), roots = [...new Set(paths)].filter((p, _, all) => !all.some((q) => q !== p && under(p, q)) && !under(p, plans) && !under(plans, p)), copied = 0;
  for (let path of roots) {
    let to = join3(dir, "root", path);
    if (await mkdir2(dirname2(to), { recursive: !0 }), spawnSync2("cp", ["-al", "--", path, to]).status === 0)
      continue;
    await rm(to, { recursive: !0, force: !0 });
    let cp = spawnSync2("cp", ["-a", "--reflink=auto", "--", path, to], {
      encoding: "utf8"
    });
    if (cp.status !== 0)
      throw Error(`cp ${path}: ${cp.stderr.trim()}`);
    copied++;
  }
  return { roots, copied, at: Date.now() };
}
async function membersOf(cwd, roots, skip = (_name) => !1) {
  let members = [], walk = async (name) => {
    if (skip(name))
      return;
    let info = await lstat(join3(cwd, name)).catch(() => {
      return;
    });
    if (info?.isDirectory()) {
      let children = await readdir(join3(cwd, name));
      if (!children.length)
        members.push({ name, size: 0, dir: !0 });
      for (let child of children)
        await walk(join3(name, child));
    } else if (info?.isFile() || info?.isSymbolicLink())
      members.push({ name, size: info.isFile() ? info.size : 0 });
  };
  for (let root of roots)
    await walk(root);
  return members;
}
async function changedSince(cwd, files, at) {
  for (let m of files) {
    let info = await lstat(join3(cwd, m.name)).catch(() => {
      return;
    });
    if (!info || info.mtimeMs > at)
      return m.name;
  }
  return;
}
async function putEntry(store, prefix, key, cwd, members, at, out) {
  let files = members.filter((m) => !m.dir), changed = async () => {
    let name = await changedSince(cwd, files, at);
    return name && {
      result: "changed",
      detail: ` file=${JSON.stringify(name)}`
    };
  }, before = await changed();
  if (before)
    return before;
  let pieces = planPieces(members);
  if (pieces.some((p) => p.bytes > MAX_PIECE))
    return { result: "too-large", detail: "" };
  await mkdir2(out, { recursive: !0 }), await mkdir2(cwd, { recursive: !0 }), await Promise.all(pieces.map(async (p) => {
    await buildPiece(p, cwd, out), await store.put(`${prefix}${p.name}`, await openAsBlob(join3(out, p.name)));
  }));
  let after = await changed();
  if (after)
    return after;
  let bytes = files.reduce((sum, m) => sum + m.size, 0), manifest = {
    v: 1,
    key,
    bytes,
    pieces: pieces.map(({ bytes: _, ...p }) => p)
  };
  return await store.put(`${prefix}manifest.json`, new Blob([JSON.stringify(manifest)])), { result: "saved", detail: ` bytes=${bytes} pieces=${pieces.length}` };
}
var writePlan = (dir, plan) => writeFile3(join3(dir, "plan.json"), JSON.stringify(plan));
async function runnerStore() {
  let opened = await openCache(process.env, 0);
  return opened.state === "ready" ? openStore(opened.tokens) : opened.reason;
}
async function upload(planPath, storeOf = runnerStore) {
  let started = Date.now(), line = (result, detail = "") => {
    let seconds = ((Date.now() - started) / 1000).toFixed(1);
    return console.log(`backmesh-cache-upload result=${result} seconds=${seconds}${detail}`), result;
  };
  try {
    let dir = dirname2(planPath), plan = JSON.parse(await readFile2(planPath, "utf8")), store = await storeOf();
    if (typeof store === "string")
      return line("off", ` reason=${JSON.stringify(store)}`);
    let cwd = join3(dir, "root", plan.workspace), roots = plan.roots.map((r) => relative(plan.workspace, r)), members = await membersOf(cwd, roots), prefix = `${plan.own}e/${esc(plan.key)}/${plan.version}/${plan.uploadId}/`, { result, detail } = await putEntry(store, prefix, plan.key, cwd, members, plan.at, join3(dir, "pieces"));
    return line(result, detail);
  } catch (error) {
    return line("failed", ` error=${JSON.stringify(String(error)).slice(0, 300)}`);
  }
}

export { entryVersion, esc, AUTO_PREFIX, MAX_ESCAPED_KEY, restorePiece, makeParents, openCache, openStore, findEntry, hasEntry, readManifest, PLANS_DIR, newUploadId, workDir, snapshot, writePlan, upload };
