# Storyboard

The cut in `hyperframes/`, 34.5 s, rebuilt on 2026-11-17 from the landing
page in its C3 design. Scenes follow `website/src/pages/index.astro` in its
order; every line on screen is the page's own words or a number it computes.
Scenes crossfade over 0.4 s; the navbar lockup stays top left until the end
card's dark band rises over the last scene.

| #   | Time        | Visual                                                                                                                                                         | On screen                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0.0–8.4 s   | The hero: words left, the hero diagram right. Queued job squares drop through the `runs-on` diff and land, each in a VM slot, in the AWS, GCP and Azure grids. | **Self-hosted GitHub Actions runners for up to 10× less.** "Each job runs on its own spot VM in your AWS, GCP or Azure account." "Your cloud bills you, so your cloud credits apply." "Core features free, no credit card." Diagram: `- runs-on: ubuntu-latest`, `+ runs-on: backmesh-4 # 4 vCPU spot VM`.                                                     |
| 2   | 8.0–11.2 s  | The trust strip, its three items in turn under a hairline.                                                                                                     | "No cloud keys stored: A role from your cloud CLI connects each cloud." "Your code never reaches us: Code, secrets, caches and logs stay between GitHub and your runners." "One small event per job: It never names the repo, workflow, job or branch."                                                                                                        |
| 3   | 10.8–16.6 s | The cost chart: GitHub's bar runs the whole axis; each cloud's bar (control plane hatched, spot VMs solid, range light) stops short.                           | **150,000 minutes a month: $1,800 on GitHub, $191–$365 on backmesh.** "4-vCPU Linux jobs; the range spans AWS, Azure and GCP and the VM types a job may get." Bars: $1,800; AWS $210–$261; Azure $191–$206; GCP $299–$365. Caption: "GitHub's list price against spot prices on 2026-11-13, without disks, VM boots or runners no job takes, so it's a floor." |
| 4   | 16.2–19.6 s | The two plans under an ink rule.                                                                                                                               | **Pricing.** "backmesh's core features are free; you pay your clouds for the VMs." Free, $0: Unlimited jobs, Cache included, No credit card required. Premium, Let's talk: Slack monitoring, Logs, Runtime history.                                                                                                                                            |
| 5   | 19.2–23.1 s | The matrix, then one lane per cloud; each lane's test job lands in turn.                                                                                       | **Pick the cloud per workflow.** "Each label runs in one cloud. Out of spot capacity, the next VM type launches, never the next cloud." `runs-on: backmesh-${{ matrix.cloud }}-4`; `backmesh-aws-4`, `backmesh-gcp-4`, `backmesh-azure-4`.                                                                                                                     |
| 6   | 22.7–26.6 s | The job log, line by line, with memory, CPU and disk highlighted.                                                                                              | **Every job log ends with what it used.** The real capture (README.md, "Job log"). "From backmesh's own CI: a verify job on backmesh-4, AWS, Nov 10 2026."                                                                                                                                                                                                     |
| 7   | 26.2–30.4 s | Two lanes aligned on the push: without a cue the VM boots after it; with a cue the same boot comes before it and the job starts at once.                       | **The boot happens before the push.** "Your coding agent cues backmesh as its checks start, so runners boot while it finishes and the job starts on one that's already up." Lanes: Without a cue, With a cue.                                                                                                                                                  |
| 8   | 29.8–34.5 s | The dark band rises; the dark lockup, the closing headline, the agent prompt over its rule. Holds 2 s for the poster.                                          | **One install. Your clouds. Your bill.** "# Paste into Claude Code, Codex, or another coding agent" / `set up https://backmesh.com/SKILL.md`. "Core features free, no credit card." backmesh.com                                                                                                                                                               |

## Sources

| Scene | Section of `website/src/pages/index.astro` (and the component that draws it)                                |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| 1     | Hero: `h1`, `.sub`, `.free`; `HeroDiagram.astro` and `flow.ts` (geometry and fill order, a faster schedule) |
| 2     | Trust strip: `TrustStrip.astro`                                                                             |
| 3     | `#cost`: `h2`, `.lead`, the `Chart` rows and legend, `.caption`; figures from `website/src/cost.ts`         |
| 4     | `#pricing`: `h2`, `.lead`, `.plans`                                                                         |
| 5     | Features, first article: `h2`, its paragraph's first two sentences; `CloudLanes.astro`                      |
| 6     | Features, second article: `h2`; the capture is backmesh's own CI log, not the page's illustrative one       |
| 7     | `#cue`: `h2`, its paragraph; `CueLanes.astro`                                                               |
| 8     | The closing `.band`: `h2#closing`, `AgentPrompt.astro`; "Core features free, no credit card." from the hero |

Left out for length: the cost chart's per-row boot notes and control-plane
note, the `backmesh-od-*` sentence, the "One status for every cloud" and
"One GitHub App" features (the status capture's numbers are illustrative),
and the FAQ.
