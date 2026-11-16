// Writes src/anycloud/contract.generated.ts: an oRPC contract for the anycloud
// operations backmesh calls, from the OpenAPI document at anycloud's
// `v<version>` tag. The client doesn't validate, so it carries types only.
// It also pins the release binaries' SHA-256 digests, from the release's
// `checksums.txt`, which `src/anycloud/binary.ts` checks a download against.
//
//   node scripts/generate-anycloud-contract.mjs <anycloud-checkout> <version>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { format, resolveConfig } from 'prettier';

const OPERATIONS = [
  ...['listSecrets', 'saveSecret', 'deleteSecret'],
  // The cache.
  ...['mintStorageTokens', 'listBuckets', 'createBucket', 'deleteBucket'],
  ...['listBucketObjects', 'deleteBucketObject'],
  ...['createNodePool', 'getQuotaStatus'],
  ...['listNodePools', 'listWorkloads', 'getWorkloadCostReport'],
  ...['submitWorkload', 'getWorkloadStatus', 'terminateWorkload'],
  'listDeployments',
];
const OUT = 'src/anycloud/contract.generated.ts';

const [checkout, version] = process.argv.slice(2);
if (!checkout || !version) {
  throw new Error('usage: generate-anycloud-contract <checkout> <version>');
}
const git = (...args) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
const commit = git('rev-parse', `v${version}^{commit}`).trim();
const doc = JSON.parse(
  git('show', `${commit}:src/shared/api-contract/openapi.generated.json`),
);
// The release before it: with its own, the clients this anycloud's API
// takes (its client window, `src/api/services/api-version.ts`).
const { previousVersion } = JSON.parse(git('show', `${commit}:package.json`));
if (!previousVersion) throw new Error('package.json has no previousVersion');

// `#/components/schemas/X` or `#/components/parameters/X`.
const resolve = (value) =>
  value.$ref
    ? value.$ref
        .split('/')
        .slice(1)
        .reduce((node, key) => node[key], doc)
    : value;

// Only the JSON Schema keywords these operations use; anything else fails, so
// a new keyword is handled on purpose. The constraints are the server's to
// check.
const KNOWN = new Set([
  ...['type', 'properties', 'required', 'additionalProperties', 'enum'],
  ...['anyOf', 'propertyNames', 'pattern', 'items', 'description'],
  ...['minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength'],
  ...['minItems', 'maxItems'],
  // A default the server fills and a string format it checks.
  ...['default', 'format'],
]);
function ts(ref) {
  const schema = resolve(ref);
  const unknown = Object.keys(schema).filter((key) => !KNOWN.has(key));
  if (unknown.length) throw new Error(`unsupported: ${unknown.join(', ')}`);
  // `{}` admits any JSON value.
  if (Object.keys(schema).length === 0) return 'unknown';
  if (schema.anyOf) return schema.anyOf.map((item) => ts(item)).join(' | ');
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type;
    case 'integer':
    case 'number':
      return 'number';
    case 'array':
      return `Array<${ts(schema.items)}>`;
    case 'object': {
      if (!schema.properties) {
        const { additionalProperties: values } = schema;
        return `Record<string, ${typeof values === 'object' ? ts(values) : 'unknown'}>`;
      }
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(
        ([name, value]) =>
          `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${ts(value)}`,
      );
      return `{ ${fields.join('; ')} }`;
    }
    default:
      throw new Error(`unsupported type: ${schema.type}`);
  }
}

function procedure(path, method, operation) {
  const [status, response] = Object.entries(operation.responses).find(
    ([code]) => code.startsWith('2'),
  );
  const parameters = (operation.parameters ?? []).map(resolve);
  // Path parameters are `params`, query parameters `query`; the client sets
  // the version header itself.
  const fields = (where) =>
    parameters
      .filter((parameter) => parameter.in === where)
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${ts(p.schema)}`)
      .join('; ');
  const body = operation.requestBody?.content['application/json'].schema;
  const input = [
    fields('path') && `params: { ${fields('path')} }`,
    fields('query') && `query: { ${fields('query')} }`,
    body && `body: ${ts(body)}`,
  ].filter(Boolean);
  const output = response.content?.['application/json'].schema;
  const route = {
    method: method.toUpperCase(),
    path,
    inputStructure: 'detailed',
    successStatus: Number(status),
  };
  return (
    `oc.route(${JSON.stringify(route)})` +
    (input.length ? `.input(type<{ ${input.join('; ')} }>())` : '') +
    (output ? `.output(type<${ts(output)}>())` : '')
  );
}

const procedures = Object.fromEntries(
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => OPERATIONS.includes(operation.operationId))
      .map(([method, operation]) => [
        operation.operationId,
        procedure(path, method, operation),
      ]),
  ),
);
const missing = OPERATIONS.filter((id) => !procedures[id]);
if (missing.length) throw new Error(`not in the document: ${missing}`);

// `<sha256>  anycloud-<platform>.tar.gz` lines.
const sums = await fetch(
  `https://github.com/anycloud-sh/releases/releases/download/v${version}/checksums.txt`,
).then((res) => {
  if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`);
  return res.text();
});
const digests = Object.fromEntries(
  [
    ...sums.matchAll(/^([0-9a-f]{64}) {2}anycloud-([a-z0-9-]+)\.tar\.gz$/gm),
  ].map(([, sha, platform]) => [platform, sha]),
);
if (Object.keys(digests).length !== 4) {
  throw new Error(`checksums.txt has ${Object.keys(digests).length} binaries`);
}

const source = `// Generated by scripts/generate-anycloud-contract.mjs from anycloud v${version}
// (${commit}). Do not edit; regenerate.
import { oc, type } from '@orpc/contract';

export const ANYCLOUD_VERSION = ${JSON.stringify(version)};

// The release before it, whose clients its API still takes.
export const ANYCLOUD_PREVIOUS_VERSION = ${JSON.stringify(previousVersion)};

export const ANYCLOUD_SHA256: Record<string, string> = ${JSON.stringify(digests)};

export const anycloudContract = {
${OPERATIONS.map((id) => `  ${id}: ${procedures[id]},`).join('\n')}
};
`;
writeFileSync(
  OUT,
  await format(source, { ...(await resolveConfig(OUT)), filepath: OUT }),
);
