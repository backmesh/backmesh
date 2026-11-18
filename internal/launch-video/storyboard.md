# Storyboard

The cut in `hyperframes/`, 20.0 s in five scenes, as the owner approved on
2026-11-18: each scene is a headline and one figure, with no sub-lines,
captions or footnotes. It follows the landing page at 9ac927b in its order and
C3 design; every line on screen is the page's own words or a number it
computes. Scenes crossfade over 0.4 s, with one quiet sound effect each.

| #   | Time        | Visual                                                                                                                                                                                              | On screen                                                                                                                                                                              |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0.0–4.5 s   | The hero: the headline left, the hero diagram right, without its `runs-on` diff. Queued job squares drop from the GitHub Actions line and land, each in a VM slot, in the AWS, GCP and Azure grids. | **Up to 2× faster, 5× cheaper builds.** Diagram labels: "GitHub Actions", "AWS", "GCP", "Azure".                                                                                       |
| 2   | 4.5–8.5 s   | Three bar pairs on one scale, under a two-swatch key; both bars of a pair grow at the same rate, so backmesh's stops first.                                                                         | **Builds against GitHub's ubuntu-latest.** Key: "backmesh-4", "GitHub-hosted". "Docker build" 71 s, 148 s; "Rust" 49 s, 70 s; "TypeScript" 35 s, 56 s.                                 |
| 3   | 8.5–12.5 s  | The cost chart's bars: GitHub's runs long; each cloud's (control plane hatched, spot VMs solid, range light) stops short.                                                                           | **150,000 minutes a month: $1,800 on GitHub, $191–$365 on backmesh.** "GitHub-hosted" $1,800; "backmesh on AWS" $210–$261; "backmesh on Azure" $191–$206; "backmesh on GCP" $299–$365. |
| 4   | 12.5–16.0 s | Two lanes aligned on the push: without a cue the VM boots after it; with a cue the same boot comes before it and the job starts at once.                                                            | **The boot happens before the push.** Lanes: "Without a cue", "With a cue"; segments "push", "VM boots", "job runs".                                                                   |
| 5   | 16.0–20.0 s | The page's dark band rises; the dark lockup, the closing headline, the agent prompt over its rule, then the address. Holds for the poster.                                                          | **One install. Your clouds. Your bill.** `set up https://backmesh.com/SKILL.md`. "backmesh.com"                                                                                        |

## Sources

| Scene | Section of `website/src/pages/index.astro` at 9ac927b (and the component that draws it)            |
| ----- | -------------------------------------------------------------------------------------------------- |
| 1     | Hero: `h1`; `HeroDiagram.astro` and `flow.ts` (geometry, labels and fill order; a faster schedule) |
| 2     | `#benchmarks`: `h2`; the `benchmarks` array's `workload` and `secs`                                |
| 3     | `#cost`: `h2` and the `Chart` rows; figures from `website/src/cost.ts` (`headline`, `totals`)      |
| 4     | `#cue`: `h2`; `CueLanes.astro`                                                                     |
| 5     | The closing `.band`: `h2#closing` and the prompt in `AgentPrompt.astro`                            |
