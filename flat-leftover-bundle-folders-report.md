# Flat Leftover Bundle Folders Report

Generated after running a dry run with the current local `--flat` fixes:

```text
bun src/cli/index.ts organize --config C:\Users\sthom\Dropbox\Media\.hbd\config.json --flat --report-path .hbd-flat-leftovers-current-dry-run.json
```

Dry-run summary:

- Already correct: 6996
- Would move: 195
- Would remove duplicates: 0
- Missing metadata candidates: 579
- Conflicts: 7

Filesystem scan summary, excluding the valid flat fallback publisher folder named `humble`:

- Bundle-style top-level folders found: 157
- Folders still containing files: 76
- Empty bundle-style directory trees: 81
- Files still inside bundle-style folders: 892
- File statuses from the organize report:
  - `unmatched-local-file`: 885
  - `conflict`: 7

Extension mix for files still inside bundle-style folders:

| Extension | Count | Notes                                                                                              |
| --------- | ----: | -------------------------------------------------------------------------------------------------- |
| `.cbz`    |   415 | Mostly duplicate or alias-era comic files not planned after flat dedupe skips another bundle copy. |
| `.epub`   |   172 | Same pattern as `.cbz`, plus format-priority/duplicate interactions.                               |
| `.zip`    |   120 | Current configured libraries exclude zip, so videos/supplements stay behind.                       |
| `.pdf`    |   102 | Mostly duplicate or alias-era files.                                                               |
| `.mobi`   |    70 | Mostly duplicate or alias-era files.                                                               |
| `.prc`    |    12 | Current configured libraries exclude prc.                                                          |
| `.cbr`    |     1 | Current configured libraries exclude cbr.                                                          |

## Why Folders Remain

### 1. Empty bundle directory trees were not pruned deeply enough

Many bundle folders have no files but still contain empty product subdirectories. These are safe cleanup candidates once we confirm they contain no files.

Examples:

| Library | Folder                                                                  | Files | Empty dirs |
| ------- | ----------------------------------------------------------------------- | ----: | ---------: |
| comics  | `Humble Comics Bundle - Witchblade and Darkness 2025`                   |     0 |        181 |
| manga   | `Humble Manga Bundle - Terrifying Tales by Kodansha`                    |     0 |        137 |
| manga   | `Humble Manga Bundle - Award Winning Manga by Kodansha Comics`          |     0 |        119 |
| manga   | `Humble Manga Bundle - Hiro Mashimas Fairy Tail  More by Kodansha`      |     0 |        107 |
| comics  | `Humble Comics Bundle - Transformers 2019 by IDW`                       |     0 |         84 |
| comics  | `Humble Comics Bundle - Judge Dredd - Perps Punks  Partners by 2000 AD` |     0 |         71 |
| comics  | `Humble Comics Bundle - Mike Mignolas B.P.R.D. by Dark Horse ENCORE`    |     0 |         69 |
| comics  | `Humble Comics Bundle - Dynamites 15th Anniversary Party`               |     0 |         65 |

Reason: `organize --flat` prunes from each moved/removed file upward, but it only prunes the direct ancestor chain of that action. Old product folders that were emptied by previous runs, skipped duplicate candidates, or interrupted runs can remain as empty directory trees.

### 2. Excluded extensions are intentionally not selected

The current config includes only `cbz`, `pdf`, `epub`, and `mobi` for books/comics/manga. That leaves supplemental/video/archive formats behind.

Examples:

| Library | Folder                                                                         | Example leftover file                                                                          | Reason                             |
| ------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| books   | `Humble Book Bundle - Become a Game Developer`                                 | `Beginner and Advanced Lighting in Unity\beginnerandadvancedlightinginunity_video.zip`         | `.zip` excluded by library config. |
| books   | `Humble Book Bundle - Game Development by Packt`                               | `Basics of Coding with Unreal Engine 4\basicsofcodingwithunrealengine4_video.zip`              | `.zip` excluded by library config. |
| books   | `Humble Book Bundle - Java by Packt`                                           | `Architecting Modern Java EE Applications\architectingmodernjavaeeapplications_supplement.zip` | `.zip` excluded by library config. |
| books   | `Humble Book Bundle - Break into the Game Industry by CRC Press`               | `3D Game Environments - Create Professional 3D Game Worlds\3dgameenvironments.prc`             | `.prc` excluded by library config. |
| comics  | `Humble Comics Bundle - Creator Spotlight on Jonathan Hickman by Image Comics` | `East of West - The World\eastofwest_theworld.cbr`                                             | `.cbr` excluded by library config. |

Reason: these files are real local files, but `organize` only plans files that pass route/library selection. They show up as `unmatched-local-file` in the leftover scan.

### 3. Flat dedupe skips later duplicate bundle candidates too early

Several folders contain included extensions (`cbz`, `epub`, `pdf`, `mobi`) that still show as `unmatched-local-file`. This generally means a flat destination or another bundle copy already satisfied the normalized product/filename, so the duplicate candidate was skipped before we planned a cleanup action for the legacy source.

Examples:

| Library | Folder                                                                           | Files | Example leftover file                                             | Reason                                                                                |
| ------- | -------------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| comics  | `Humble Comics Bundle - Manara Moebius and the Metabaron by Humanoids`           |    65 | `Armies Vol. 1\armies_vol1.cbz`                                   | Duplicate/alias-era file not selected after flat dedupe reservation.                  |
| books   | `Humble Book Bundle - Creating Comics Manga  Animation by Quarto`                |    68 | `Anime Art Class\animeartclass.epub`                              | Local file remains after another candidate satisfied the flat product/filename group. |
| books   | `Humble Book Bundle - The Ultimate Writing Bundle by Adams Media`                |    52 | `1-Minute Writer\1minutewriter.epub`                              | Duplicate product appears across writing bundles.                                     |
| books   | `Humble Book Bundle - Write Like a Writer by Adams Media`                        |    52 | `1-Minute Writer\1minutewriter.epub`                              | Same duplicate group as above.                                                        |
| comics  | `Humble Comics Bundle - Dynamite 20th Anniversary 20000-Page Mega Bundle`        |    32 | `Army of Darkness Omnibus Vol. 1\armyofdarkness_omnibus_vol1.cbz` | Duplicate bundle copy not planned for removal.                                        |
| comics  | `Humble Comics Bundle - Dynamite 20th Anniversary 20000-Page Mega Bundle Encore` |    32 | `Army of Darkness Omnibus Vol. 1\armyofdarkness_omnibus_vol1.cbz` | Encore duplicate of the same products.                                                |
| manga   | `Humble Manga Bundle - Manga 2 Anime by Kodansha`                                |    14 | `Cells at Work Vol. 1\cellsatwork_vol1.cbz`                       | Duplicate manga product already represented in flat layout.                           |
| manga   | `Humble Manga Bundle - Fantasy by Kodansha Comics`                               |    13 | `To Your Eternity Vol. 1\toyoureternity_vol1.cbz`                 | Duplicate manga product already represented in flat layout.                           |

Reason: the current planner uses `plannedFlatFiles` to avoid repeated duplicate actions, which is good for avoiding duplicate moves but bad for cleanup. Once a flat product/filename is reserved, later legacy sources can be skipped without getting a `would-remove-duplicate` action.

### 4. Duplicate cleanup only trusts `Humble ...` folders

The latest duplicate-removal guard only treats a duplicate source as safely removable when the top-level folder starts with `Humble `. But previous cleanup/organize passes produced legacy bundle folders that are exact metadata matches without necessarily fitting a single `Humble ...` naming pattern, and some are non-Humble bundle titles.

Examples:

| Library | Folder                                        | Reason                                                          |
| ------- | --------------------------------------------- | --------------------------------------------------------------- |
| comics  | `Elfquest - The Dark Horse Collection Encore` | Exact metadata bundle title, but does not start with `Humble `. |
| books   | `The NaNoWriMo Writing Bundle`                | Exact metadata bundle title, but does not start with `Humble `. |
| books   | `Stand with Ukraine Bundle`                   | Exact metadata bundle title, but does not start with `Humble `. |
| comics  | `The Bleeding Heart of Heavy Metal Vol. 1`    | Exact metadata title, but not a Humble-prefixed folder.         |

Reason: we should identify legacy bundle folders by metadata match, not by `startsWith("Humble ")`.

### 5. Seven files are real size conflicts

These should not be auto-deleted without a policy because the flat destination exists but differs in file size.

| Library | Folder                                                                   | File                                                                       | Reason                                            |
| ------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------- |
| comics  | `Humble Book Bundle - Forbidden Books supporting Banned Books Week 2018` | `Saga Vol. 1\saga_vol1.cbz`                                                | Flat destination exists but differs in file size. |
| comics  | `Humble Book Bundle - Geek Gals`                                         | `Bitch Planet Vol. 1 - Extraordinary Machine\bitchplanet_vol1.cbz`         | Flat destination exists but differs in file size. |
| comics  | `Humble Comic Bundle - Image Comics in the 10s`                          | `Paper Girls Vol. 1\papergirls_vol1.cbz`                                   | Flat destination exists but differs in file size. |
| comics  | `Humble Comics Bundle - Image Expo 2018`                                 | `Bitch Planet Vol. 1 - Extraordinary Machine\bitchplanet_vol1.cbz`         | Flat destination exists but differs in file size. |
| comics  | `Humble Comics Bundle - Image Expo 2018`                                 | `Spawn Origins Collection Vol. 1\spawn_origins_vol1.cbz`                   | Flat destination exists but differs in file size. |
| comics  | `Humble Conquer COVID-19 Bundle`                                         | `Spawn Origins Collection Vol. 1\spawn_origins_vol1.cbz`                   | Flat destination exists but differs in file size. |
| comics  | `Humble Conquer COVID-19 Bundle`                                         | `The Boys Vol. 1 - The Name of the Game\theboys_vol1_thenameofthegame.cbz` | Flat destination exists but differs in file size. |

Reason: size mismatch is currently treated correctly as a conflict. We need a higher-level conflict policy before deleting either copy.

## Representative File-Bearing Folders

These are the largest file-bearing bundle-style folders left after flattening:

| Library | Folder                                                                           | Files | Primary reason                                 |
| ------- | -------------------------------------------------------------------------------- | ----: | ---------------------------------------------- |
| books   | `Humble Book Bundle - Creating Comics Manga  Animation by Quarto`                |    68 | Unmatched selected/local candidates.           |
| comics  | `Humble Comics Bundle - Manara Moebius and the Metabaron by Humanoids`           |    65 | Unmatched duplicate/alias-era files.           |
| books   | `Humble Book Bundle - The Ultimate Writing Bundle by Adams Media`                |    52 | Duplicate products across writing bundles.     |
| books   | `Humble Book Bundle - Write Like a Writer by Adams Media`                        |    52 | Duplicate products across writing bundles.     |
| books   | `Humble Book Bundle - Become a Game Developer`                                   |    33 | Excluded `.zip` supplements/videos.            |
| comics  | `Humble Comics Bundle - Dynamite 20th Anniversary 20000-Page Mega Bundle`        |    32 | Duplicate products across Dynamite bundles.    |
| comics  | `Humble Comics Bundle - Dynamite 20th Anniversary 20000-Page Mega Bundle Encore` |    32 | Encore duplicate products.                     |
| books   | `Humble Book Bundle - Game Development by Packt`                                 |    32 | Excluded `.zip` supplements/videos.            |
| comics  | `Humble Comics Bundle - Judge Dredd 2000 AD  more`                               |    31 | Duplicate/alias-era files.                     |
| comics  | `Humble Comic Bundle - The Incal to Twilight Man by Humanoids`                   |    29 | Duplicate/alias-era files.                     |
| comics  | `Humble Comics Bundle - Humanoids Megabundle Featuring The Incal`                |    26 | Duplicate/alias-era files.                     |
| books   | `Humble Book Bundle - Java by Packt`                                             |    24 | Excluded `.zip` supplements.                   |
| comics  | `Humble Comics Bundle - Start Here`                                              |    23 | Duplicate products across early comic bundles. |
| comics  | `Humble Comics Bundle - Fan Faves  New Hits by Dynamite`                         |    21 | Duplicate products across Dynamite bundles.    |
| comics  | `Humble Comics Bundle - Vampirella XOXO by Dynamite`                             |    20 | Duplicate/alias-era files.                     |
| comics  | `Humble Comic Bundle - Image Comics in the 10s`                                  |    19 | Duplicate files plus one size conflict.        |
| comics  | `Humble Comic Bundle - James Bond and Beyond by Dynamite`                        |    18 | Duplicate/alias-era files.                     |
| books   | `Humble Book Bundle - Program Your Own Games by Mercury`                         |    17 | Excluded `.zip` supplements.                   |
| manga   | `Humble Manga Bundle - Manga 2 Anime by Kodansha`                                |    14 | Duplicate manga products.                      |
| manga   | `Humble Manga Bundle - Fantasy by Kodansha Comics`                               |    13 | Duplicate manga products.                      |

## Holistic Fixes

### A. Add a first-class flat leftovers planner

Add a planner pass after normal flat planning that scans configured flat libraries for top-level folders matching metadata bundle titles. It should emit actions for:

- Empty legacy bundle directory trees: `would-remove-empty-folder`.
- Legacy files whose flat destination exists with the same size/hash: `would-remove-duplicate`.
- Legacy files whose flat destination exists but differs: `conflict`.
- Legacy files not represented by selected metadata due extension policy: `ignored-by-extension` or `unrouted-local-file`.

This gives us a stable report and action model instead of debugging from filesystem scans.

### B. Identify legacy bundle folders by metadata, not by name prefix

Replace `isHumbleBundleFolder(topLevel)` as the safety check for duplicate removal with a stronger predicate:

- exact `cleanName(bundleTitle)` match,
- existing `hasSimilarTitle` match when unambiguous,
- maybe cache `bundleLocation.bundlePath` ancestry from the flat index.

This handles `Elfquest - The Dark Horse Collection Encore`, `Stand with Ukraine Bundle`, and other non-Humble-prefixed bundle folders without hardcoding titles.

### C. Do not skip cleanup for later flat duplicates

Keep `plannedFlatFiles` for avoiding duplicate moves/downloads, but still inspect later duplicate candidates for legacy sources. If the flat destination already exists and the legacy source is in a metadata-matched bundle folder:

- same size/hash: remove duplicate,
- different size/hash: conflict,
- excluded extension: leave as ignored or route elsewhere.

This is probably the big one for the many `.cbz/.epub/.pdf/.mobi` leftovers.

### D. Add an explicit policy for supplemental formats

The `.zip`, `.prc`, and `.cbr` leftovers are not bugs in flat layout; they are policy gaps. Pick one:

- expand library `extInclude` to include selected supplemental extensions,
- add a `supplements` or `other` configured library,
- add `organize --flat --include-unselected-local` for local-only organization,
- or add a report-only status so users know these are intentionally ignored.

### E. Add conflict resolution modes, not silent deletion

For the seven size conflicts, add a follow-up mode such as:

- `--resolve-conflicts prefer-flat`
- `--resolve-conflicts prefer-largest`
- `--resolve-conflicts prefer-md5-match`
- `--conflict-dir <path>` to quarantine alternate copies

Default should remain conservative.

### F. Make empty-folder pruning library-wide after apply

After `organize --flat --apply`, run a safe cleanup pass inside each routed library:

- only under metadata-matched legacy bundle folders,
- only remove empty directories,
- stop at the configured library root,
- report removals.

This would clean the 81 empty bundle trees without needing a separate manual cleanup.
