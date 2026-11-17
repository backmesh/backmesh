# Launch videos

Source for the two backmesh launch videos, built with
[HyperFrames](https://hyperframes.heygen.com/) HTML compositions, after
anycloud's `internal/launch-video/`:

- `hyperframes/` is the main cut (22.0 s, 44 beats at 120 BPM). `index.html`
  holds the scene schedule, the weave-wipe transitions, the beat-driven glow
  and the sound-effect cues. `compositions/frames/` holds one sub-composition
  per scene.
- `brag/` is the alternate cut (21.0 s), terminal-first, in one file.
  `share-copy.txt` is its post caption.

The compositions are the source of truth for on-screen copy and timing; edit
them directly. `storyboard.md` is the redo from the landing page, waiting for
the maintainers; the compositions don't follow it yet. They use the website's brand: the colours in
`website/src/styles/tokens.css`, Bricolage Grotesque, Inter and JetBrains Mono,
the Woven B (`website/public/brand/mark-dark.svg`) and the monochrome cloud
logos (`website/src/assets/clouds/`).

The repository holds text only. Fonts, GSAP and the sound effects are fetched
into each cut's git-ignored `assets/` folder; the brand files are copied there
from `website/`.

## Render

Prerequisites: Node 22 or later, FFmpeg on `PATH`, and the HyperFrames
headless browser (`npx hyperframes@0.8.134 browser ensure`).

```bash
cd internal/launch-video
npm run fetch-assets
npm run render:hyperframes
npm run render:brag
```

`fetch-assets` downloads every file in `assets.txt` and fails on any SHA-256
mismatch. Each render writes `renders/<cut>.mp4`; pass another output path as
an argument: `npm run render:brag -- out.mp4`. To edit a cut, run
`npx hyperframes@0.8.134 preview` inside its folder, and
`npx hyperframes@0.8.134 check` before rendering.

`npm run encode -- launch-2026-11-v1` writes `renders/web/launch-2026-11-v1/`:
AV1 and H.264 at 1080p and 720p, a poster from the last second, and
`SHA256SUMS`. Pass the input for another cut:
`npm run encode -- brag-2026-11-v1 renders/brag.mp4`. FFmpeg needs
`libaom-av1`, `libopus` and `libx264`.

## Publish a cut

Not approved yet: the maintainers approve the final cut, the music and the site
placement first. The media host is the `backmesh-media` R2 bucket behind
`media.backmesh.com`, created by
[`experiments/r2-media-host`](../../experiments/r2-media-host/README.md). It
creates no objects; uploading a cut is a later, reviewed step, one immutable
folder per version.

## Copy and evidence

- **Cue numbers.** "Median wait: 100.5 s → 17 s": median queue wait, 24 jobs
  each, on AWS, on backmesh's own CI, November 2026, as the footnote says.
- **Job log.** The resource summary in scene 5 and the brag cut is verbatim
  from backmesh's own CI:
  run 42915065644, job `verify`, in the archived private repository, on `backmesh-4` (AWS), commit `9894a6df8cf6225b695de4df540ace5757e5aaf4`,
  2026-11-10. Only its colour highlights are added.
- **Cue output.** `Cued backmesh/backmesh feat/launch-video.` is the CLI's
  success message (`src/cli/cue.ts`) for this pull request's branch.
- **Billing and credits.** "Your cloud bills you directly" and "Your cloud
  credits apply" follow the FAQ's cost section; "Core features are free" follows the
  site's about text (`website/src/about.ts`).

## Assets

| Asset                                                | Used by | Source                                                                                                  | Licence                                                                |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Bricolage Grotesque, Inter, JetBrains Mono, variable | both    | `@fontsource-variable/*@5.3.0` (npm, via jsDelivr), the versions `website/` pins                        | SIL OFL 1.1                                                            |
| GSAP 3.14.2                                          | both    | `gsap` npm package (via jsDelivr)                                                                       | [GSAP Standard License](https://gsap.com/standard-license) (no charge) |
| Impact and interface sounds                          | both    | `latent-spaces/brag@cb89b9f`, `skills/brag/assets/sfx/`, credited there to [Kenney](https://kenney.nl/) | CC0 (Kenney); the brag repository is MIT                               |
| Woven B, cloud logos                                 | both    | `website/public/brand/mark-dark.svg`, `website/src/assets/clouds/` in this repository                   | backmesh; the cloud marks are their owners' trademarks                 |

## Music

Neither cut has music. anycloud's track ("Happy Beats / Business Moves" by
ende.app) has no confirmed commercial licence, so it is not used. The cuts
carry only the CC0 sound effects above. To add a bed, place a track you hold a
licence for as an `<audio>` element in the cut's `index.html` (anycloud's
`hyperframes/index.html` shows the fades) and record its source and licence
here.
