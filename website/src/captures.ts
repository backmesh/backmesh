// The landing page's captures, as preformatted HTML: <span class="p">
// marks a prompt and "hi" the line to read. Kept in template literals so
// formatting never reflows them, at most 8 lines of 40 characters so they
// fit a phone. The lines are the CLI's and the runner's own text, abridged;
// the numbers are illustrative.
export const status = `<span class="p">$ </span>backmesh status
Runners: each job runs in its own VM
  backmesh-aws-ubuntu-2404-4vcpu: 6 assigned, 6 running
<span class="hi">    24 h: 42 jobs; queued to started
      p50 21 s, p95 1.6 min</span>
Cost since 2026-11-01: $41.80`;

export const summary = `backmesh: resources over 312 s,
sampled every 5 s
  Memory  <span class="hi">peak 9.8 GiB of 15.5 GiB</span>,
          0 OOM kills
  CPU     average 2.41 cores,
          peak 3.91 of 3.98
  Disk    work directory peak 3.4 GiB`;
