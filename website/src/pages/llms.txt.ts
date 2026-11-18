// /llms.txt (llmstxt.org): what backmesh is and its docs, for AI assistants.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SUMMARY } from '../about';
import { MINUTES, headline } from '../cost';
import { sidebar } from '../sidebar.mjs';

const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

export const GET: APIRoute = async ({ site }) => {
  const docs = new Map((await getCollection('docs')).map((d) => [d.id, d]));
  const link = (path: string) => new URL(path, site).href;
  const sections = sidebar.map(({ label, items }) =>
    [
      `## ${label}`,
      '',
      ...items.map((id) => {
        const { title, description } = docs.get(id)!.data;
        return `- [${title}](${link(`/${id}/`)}): ${description}`;
      }),
    ].join('\n'),
  );
  const posts = [...docs.values()]
    .filter((d) => d.id.startsWith('blog/'))
    .sort((a, b) => +(b.data.date ?? 0) - +(a.data.date ?? 0))
    .map(
      (d) => `- [${d.data.title}](${link(`/${d.id}/`)}): ${d.data.description}`,
    );
  const text = `# backmesh

> ${SUMMARY}

- Linux x86-64 jobs in private repositories only: no macOS, Windows, Arm or GPU runners.
- A job's \`runs-on\` label, such as \`backmesh-4\`, picks its size and cloud. Spot is the default; \`backmesh-od-*\` labels run on demand.
- Builds: in our benchmarks (https://github.com/backmesh/backmesh/tree/main/benchmarks/builds), a 4-vCPU \`backmesh-4\` spot VM ran Docker, Rust and TypeScript builds 1.4 to 2.1× faster than GitHub's 2-vCPU \`ubuntu-latest\`, at 2.9 to 5.6× less per build, before backmesh's control plane.
- Compute: ${MINUTES.toLocaleString('en-US')} minutes a month of 4-vCPU Linux jobs cost ${money(headline.github)} on GitHub-hosted runners and ${money(headline.low)}–${money(headline.high)} on backmesh at spot prices, control plane included, before disks, VM boots and runners started ahead of jobs.
- Pricing: free and open source (Apache-2.0; the cache action is MIT), with unlimited jobs and the cache included; your clouds bill you for the VMs. Premium adds Slack monitoring, logs and runtime history; talk to us at luis@backmesh.com.

## Agents

- [SKILL.md](${link('/SKILL.md')}): how a coding agent installs backmesh, moves jobs onto its runners and cues each push.

${sections.join('\n\n')}

## Blog

${posts.join('\n')}

## Optional

- [llms-full.txt](${link('/llms-full.txt')}): every docs page above in one file.
- [Landing page](${link('/')}): costs, pricing and the short FAQ.
`;
  return new Response(text, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
