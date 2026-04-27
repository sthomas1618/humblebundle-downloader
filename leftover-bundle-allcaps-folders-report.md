# Leftover Bundle And ALL CAPS Folder Report

Generated from `C:\Users\sthom\Dropbox\Media\.hbd\config.json`,
`C:\Users\sthom\Dropbox\Media\.hbd\metadata.json`, and the clean final dry run
`C:\Users\sthom\Projects\humblebundle-downloader\.hbd-flat-conflict-default-final-check-2.json`.

The final `organize --flat` dry run reports:

| Metric                     | Count |
| -------------------------- | ----: |
| Already correct            |  7191 |
| Would move                 |     0 |
| Would move supplements     |     0 |
| Would remove duplicates    |     0 |
| Would remove empty folders |     0 |
| Would resolve conflicts    |     0 |
| Missing                    |   561 |
| Conflicts                  |     0 |

That means the remaining folders below are not ordinary unresolved organize
actions. They are either valid flat publisher folders, old single-level folders
that do not match the current legacy `Bundle/Product/file` source shape, or
files that cannot be mapped safely from current metadata.

## Scan Rule

I scanned the top level of the three configured flat libraries:

- `C:\Users\sthom\Dropbox\Media\Comics\comics`
- `C:\Users\sthom\Dropbox\Media\Books`
- `C:\Users\sthom\Dropbox\Media\Comics\Manga`

Included folders were top-level names containing `Bundle` or matching an ALL
CAPS-style name. The scan found 24 candidate folders.

## Summary

| Category                                                            | Folders | Meaning                                                                                                             |
| ------------------------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------- |
| Valid flat publisher folders                                        |       4 | Already treated as `Publisher/Series/files`; scary only because publisher names are uppercase.                      |
| Single-level legacy/topic folders                                   |      16 | Files are directly under the top folder, so current flat leftovers logic does not know the product folder boundary. |
| Bundle-shaped folders with product subfolders but no emitted action |       2 | Metadata matches exist, but the current planner did not recognize them as actionable leftovers.                     |
| No current metadata match                                           |       2 | Files do not match current metadata filename/stem well enough to move safely.                                       |

## Folder Findings

| Library | Folder                                                                         | Files | Dirs | Metadata match | Report actions | Why it remains                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------ | ----: | ---: | -------------: | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comics  | `2000 AD`                                                                      |    74 |   57 |             74 |             74 | Valid flat publisher folder. Organize already considers files here correct.                                                                                                                                                                                         |
| Comics  | `BOOM`                                                                         |    87 |   57 |             87 |             87 | Valid flat publisher folder. This is the canonical family folder for BOOM/BOOM! Studios content.                                                                                                                                                                    |
| Comics  | `DYNAMITE 20TH ANNIVERSARY 20,000-PAGE MEGA BUNDLE`                            |    89 |    0 |             88 |             24 | Single-level legacy folder. Most files match metadata, but they are directly under the bundle folder rather than `Bundle/Product/file`. One file has no current metadata match: `projectsuperpowers_vol1_cbz_1403295425.zip`.                                       |
| Comics  | `Humble Comics Bundle - Dynamite Character Crossover Comics by Dynamite`       |     1 |    1 |              1 |              0 | Bundle-shaped, but no action was emitted. The remaining file is `Swords of Sorrow - The Complete Saga/swordsofsorrow_thecompletesaga.pdf`; metadata has duplicate appearances across Dynamite bundles, likely already satisfied elsewhere in selected format logic. |
| Comics  | `Humble Comics Bundle - Indie Comics United - A Super Bundle of Awesome Stuff` |     4 |    3 |              4 |              0 | Bundle-shaped, but no action was emitted. Remaining files are older PDF variants also present across Dynamite/Project Superpowers metadata.                                                                                                                         |
| Comics  | `IDW`                                                                          |   314 |  124 |            314 |            310 | Valid flat publisher folder. Most files are already correct. Four local alternate-format files had no report action: `godzilla_halfcenturywar.cbz`, `lockeandkey_vol1.cbz`, `lockeandkey_vol1_welcometolovecraft.pdf`, `lockeandkey_vol6.cbz`.                      |
| Comics  | `TALES OF HORROR`                                                              |     2 |    0 |              2 |              0 | Single-level legacy/topic folder. Files match metadata (`fromhell.cbz`, `lockeandkey_vol1.cbz`) but the folder has no product subfolders.                                                                                                                           |
| Comics  | `THE INCAL TO TWILIGHT MAN BY HUMANOIDS`                                       |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. `thetwilightman_rodserlingandthebirthoftelevision.cbz` matches by stem, but metadata primarily names other formats.                                                                                                               |
| Comics  | `UDON`                                                                         |    23 |   15 |             23 |             23 | Valid flat publisher folder. Organize already considers files here correct.                                                                                                                                                                                         |
| Books   | `1633`                                                                         |     1 |    0 |              0 |              0 | No current metadata match for `1633.lit`. Also `.lit` is outside the configured book include list.                                                                                                                                                                  |
| Books   | `ASP NET`                                                                      |    11 |    0 |              0 |              0 | No current metadata matches for sampled files such as `ADO.NET 4 Step by Step.pdf` and `ASP.NET 4.0 in Practice By Daniele Bochicchio.pdf`. Likely non-Humble/manual library material or metadata no longer present.                                                |
| Books   | `BECOME A GAME DEVELOPER`                                                      |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. File matches metadata by stem, but the folder is not `Publisher/Series`.                                                                                                                                                          |
| Books   | `BREAK INTO THE GAME INDUSTRY`                                                 |     4 |    0 |              3 |              0 | Single-level legacy/topic folder. Three `.prc` files match metadata by stem; `honoringthecode.pdf` did not match current metadata.                                                                                                                                  |
| Books   | `CREATING COMICS, MANGA, & ANIMATION`                                          |     2 |    0 |              2 |              0 | Single-level legacy/topic folder. Files match Quarto/humble metadata by stem, but no product subfolders exist.                                                                                                                                                      |
| Books   | `CREATING COMICS, MANGA, & ANIMATION BY QUARTO`                                |     3 |    0 |              3 |              0 | Single-level legacy/topic folder. Duplicates/alternates overlap the previous folder and Quarto metadata.                                                                                                                                                            |
| Books   | `DEVOPS BY O'REILLY`                                                           |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. `designingdistributedsystems.mobi` matches metadata by stem.                                                                                                                                                                      |
| Books   | `FRONT END WEB DEVELOPMENT BY PACKT`                                           |     4 |    0 |              4 |              0 | Single-level legacy/topic folder. Files match Packt products by stem.                                                                                                                                                                                               |
| Books   | `GAME DEVELOPMENT BY PACKT`                                                    |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. `godotenginegamedevelopmentprojects.mobi` matches Packt metadata by stem.                                                                                                                                                         |
| Books   | `GAME STUDIES BY MIT PRESS`                                                    |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. `.prc` file matches MIT Press metadata by stem.                                                                                                                                                                                   |
| Books   | `GET THE VOTE OUT! SUPPORTING THE ACLU`                                        |     2 |    0 |              2 |              0 | Single-level legacy/topic folder. One CBZ is cross-routed comic content, one MOBI matches by stem.                                                                                                                                                                  |
| Books   | `HOW TO START DRAWING WITH WALTER FOSTER`                                      |     2 |    0 |              2 |              0 | Single-level legacy/topic folder. Files overlap the Quarto drawing bundle products.                                                                                                                                                                                 |
| Books   | `PROGRAMMING COOKBOOKS BY O'REILLY`                                            |     1 |    0 |              1 |              0 | Single-level legacy/topic folder. `sqlcookbook.mobi` matches O'Reilly metadata by stem.                                                                                                                                                                             |
| Books   | `STAND WITH UKRAINE BUNDLE (Books)`                                            |     2 |    0 |              2 |              0 | Single-level bundle folder. Metadata matches exactly, but files are directly under the bundle folder.                                                                                                                                                               |
| Books   | `The NaNoWriMo Writing Bundle`                                                 |     1 |    0 |              1 |              0 | Single-level bundle folder. Local filename has `(1)` suffix; after suffix normalization it matches `livingcolor_paintingwritingandthebonesofseeing.epub`.                                                                                                           |

## Why The Current Planner Misses Them

### 1. Valid ALL CAPS Publisher Folders Are Not Problems

`2000 AD`, `BOOM`, `IDW`, and `UDON` are publisher-level flat folders. Their
names happen to be uppercase or acronym-like, so a visual scan makes them look
like legacy folders. The final report marks almost all of their contents as
`already-correct`.

The only wrinkle is `IDW`: metadata contains publisher variants such as `IDW`
and `IDW Publishing`, plus older bundles without an inferred publisher. The
current alias logic has mostly collapsed those into `IDW`, which is good.

### 2. Single-Level Folders Lose Product Context

Most leftover folders are shaped like:

```text
Books/DEVOPS BY O'REILLY/designingdistributedsystems.mobi
```

The flat target wants:

```text
Books/O'Reilly/Designing Distributed Systems/designingdistributedsystems.mobi
```

Current `organize --flat` is strongest when the source is either already flat
or a legacy `Bundle/Product/file` tree. With a single-level folder, the folder
name may be a bundle title, topic, or publisher-ish title, but there is no
product folder boundary. The planner therefore does not emit moves unless a
specific metadata candidate path or leftover recognizer identifies the file.

### 3. Some Leftovers Are Alternate Formats

Several files match metadata only by filename stem, not exact filename:

- `.mobi` where metadata has `.epub`/`.pdf`
- `.prc` where metadata has `.pdf`
- `.cbz` where metadata has `.pdf`/`.epub`
- local filenames with suffixes such as `(1)`

We intentionally started preserving extra formats, but the current leftover
scanner still needs a stronger "single-file stem match" path for these old
flat-ish bundle folders.

### 4. Some Files Are Not In Current Metadata

These should not be moved automatically without a separate manual/import mode:

- `Books/1633/1633.lit`
- `Books/ASP NET/*`
- `Books/BREAK INTO THE GAME INDUSTRY/honoringthecode.pdf`
- `Comics/comics/DYNAMITE 20TH ANNIVERSARY 20,000-PAGE MEGA BUNDLE/projectsuperpowers_vol1_cbz_1403295425.zip`

They may be older Humble downloads, manually imported books, or files whose
current Humble metadata filename changed too much for a safe match.

## Proposed Holistic Fixes

1. Add a `planSingleLevelFlatLeftovers` pass.
   Detect top-level folders inside a flat library that are not valid publisher
   folders and contain files directly. Match each file to metadata by exact
   filename first, then normalized stem, then optional local suffix stripping
   like `(1)`.

2. Classify top-level folders before moving.
   Treat a folder as a valid publisher folder when most contained files are
   already `Publisher/Series/file` and metadata agrees on that publisher. Treat
   it as a legacy/topic folder when it has files directly under it and few/no
   child series folders.

3. Move supplementary and alternate formats from single-level folders.
   If the stem maps uniquely to a product, move the local format into
   `Publisher/Series/filename` even when that extension is not the selected
   preferred download format.

4. Add conservative ambiguity handling.
   If a filename maps to multiple products or multiple publishers, report it
   instead of moving unless one candidate is already represented by the folder
   name, md5, or an existing flat cache entry.

5. Add an "untracked/manual" report bucket.
   Files with no metadata match should be grouped separately so we can decide
   whether to import them into `humble`, leave them alone, or add a manual
   metadata mapping.

6. Improve the final report labels.
   Separate "valid uppercase publisher folder" from "legacy ALL CAPS folder" so
   folders like `2000 AD`, `IDW`, and `UDON` stop looking like failed cleanup.
