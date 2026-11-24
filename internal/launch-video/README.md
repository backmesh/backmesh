# Launch video

Source for the backmesh launch video, built with
[HyperFrames](https://hyperframes.heygen.com/) HTML compositions.

`hyperframes/` is the cut (20.0 s, five scenes). `index.html` holds the
scene schedule, the crossfades and the sound-effect cues;
`compositions/frames/` holds one sub-composition per scene. `storyboard.md`
lists the scenes, their on-screen copy and where on the landing page each
claim comes from.

The compositions are the source of truth for on-screen copy and timing; edit
them directly. They follow the landing page (`website/src/pages/index.astro`)
in its order and in its design, "C3": one column, white and ink with one
cerulean (`website/src/styles/tokens.css`), Schibsted Grotesk and Fragment
Mono, the hybrid-A lockup (the wordmark and a cursor of three stacked squares,
`website/public/brand/lockup-dark.svg`, on the end card) and the monochrome
cloud logos (`website/src/assets/clouds/`). Each scene is a headline and one
figure, with no sub-lines or captions. The scenes sit on the light ground; the
end card is the page's one dark closing band.

The repository holds text only. Fonts, GSAP and the sound effects are fetched
into the cut's git-ignored `assets/` folder; the brand files are copied there
from `website/`.

## Render

Prerequisites: Node 22 or later, FFmpeg on `PATH`, and the HyperFrames
headless browser (`npx hyperframes@0.8.134 browser ensure`).

```bash
cd internal/launch-video
npm run fetch-assets
npm run render
```

`fetch-assets` downloads every file in `assets.txt` and fails on any SHA-256
mismatch. The render writes `renders/launch.mp4`; pass another output path as
an argument: `npm run render -- renders/out.mp4`. To edit the cut, run
`npx hyperframes@0.8.134 preview` inside `hyperframes/`, and
`npx hyperframes@0.8.134 check` before rendering.

`npm run encode -- launch-2026-11-v5` writes `renders/web/launch-2026-11-v5/`:
AV1 and H.264 at 1080p and 720p, a poster from the last second, and
`SHA256SUMS`. Pass another input as a second argument. FFmpeg needs
`libaom-av1`, `libopus` and `libx264`.

## Publish the cut

Not approved yet: the maintainers approve the final cut and the site placement
first. The media host is the `backmesh-media` R2 bucket behind
`media.backmesh.com`, created by
[`experiments/r2-media-host`](../../experiments/r2-media-host/README.md). It
creates no objects; uploading a cut is a later, reviewed step, one immutable
folder per version.

## Copy and evidence

Every line on screen is the landing page's own words, or a number it
computes; `storyboard.md` maps each one to its section.

- **Benchmarks.** Scene 2's seconds are the page's `benchmarks` array
  (2026-11-18, medians of 5 rounds each, `backmesh-4` on AWS against
  `ubuntu-latest`); `website/src/content/docs/benchmarks.mdx` has the method
  and the runs. The hero's "Up to 2× faster, 5× cheaper builds" is the
  page's headline over them.
- **Cost.** "$1,800 on GitHub, $191–$365 on backmesh" and the per-cloud bars
  are `website/src/cost.ts` (`headline`, `totals`), rounded as the page rounds
  them, with its catalog date, 2026-11-13.

## Assets

| Asset                               | Source                                                                                                  | Licence                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Schibsted Grotesk (variable), latin | `@fontsource-variable/schibsted-grotesk@5.3.0` (npm, via jsDelivr), the version `website/` pins         | SIL OFL 1.1                                                            |
| Fragment Mono 400, latin            | `@fontsource/fragment-mono@5.3.0` (npm, via jsDelivr), the version `website/` pins                      | SIL OFL 1.1                                                            |
| GSAP 3.14.2                         | `gsap` npm package (via jsDelivr)                                                                       | [GSAP Standard License](https://gsap.com/standard-license) (no charge) |
| Impact and interface sounds         | `latent-spaces/brag@cb89b9f`, `skills/brag/assets/sfx/`, credited there to [Kenney](https://kenney.nl/) | CC0 (Kenney); the brag repository is MIT                               |
| Lockup, cloud logos                 | `website/public/brand/lockup-dark.svg`, `website/src/assets/clouds/` in this repository                 | backmesh; the cloud marks are their owners' trademarks                 |

## Music

The cut has no music. It carries only the CC0 sound effects above, quietly,
one per scene. To add a bed, place a track you hold a licence for as an
`<audio>` element in `hyperframes/index.html` with `data-volume` and a GSAP volume fade, and record its source and licence
here.
