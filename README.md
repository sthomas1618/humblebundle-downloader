# Humble Bundle Downloader

**Download all of your content from your Humble Bundle Library!**

The first time this runs it may take a while because it will download everything.
After that it will only download the content that has been updated or is missing.

## Features

- support for Humble Trove _(`--trove` flag)_
- downloads new and updated content from your Humble Bundle Library on each run _(only check for updates if using `--update`)_
- cli command for easy use (downloading will also work on a headless system)
- works for SSO and 2FA accounts
- optional progress bar for each item downloaded _(`--progress` flag)_
- optional filter by file types using an include _or_ exclude list _(`--include/--exclude` flag)_
- optional filter by platform types like video, ebook, etc... _(`--platform` flag)_
- audit an existing library to rebuild the cache _(`hbd audit`)_

## Instructions

### 1. Getting cookies

First thing to do is get your account cookies.
This can be done by getting a browser extension that lets you see or export your cookies.

- **Method 1 (recommended)**
    - Get the value of the cookie called `_simpleauth_sess` and pass that value using `-s 'COOKIE_VALUE'`
    - Note: The quotes in the cookie value are part of the value, you might need to wrap the entire value
      (including double quotes) in single quotes. Some suggestions for common issues can be found in [issue #50](https://github.com/xtream1101/humblebundle-downloader/issues/50)

- **Method 2**
    - Export the cookies in the Netscape format using an extension.
      If your exported cookie file is not working, it may be a formatting issue.
      This can be fixed by running the command `curl -b cookies.orig.txt --cookie-jar cookies.txt http://bogus`

### 2. Downloading your library

Use the following command to download your Humble Bundle Library:
`hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress`

This directory structure will be used:
`Downloaded Library/Purchase Name/Item Name/downloaded_file.ext`

### 3. Auditing an existing library

If you already have a library downloaded but the cache file is missing or stale,
you can rebuild it without downloading anything:
`hbd audit --cookie-file cookies.txt --library-path "Downloaded Library"`
_To skip remote metadata lookups, add `--offline`_

This scans your existing files, compares them against your Humble Bundle
purchases, and updates `.cache.json` so future downloads only fetch missing or
updated content.

## Notes

- Inside your library folder a file named `.cache.json` is saved and keeps track of the files that have been downloaded.
  This way running the download command again pointing to the same directory will only download new or updated files.
- The `.cache.json` file lives at the root of your library directory and stores a JSON object keyed by download identifiers.
  Humble Trove entries use `trove:<web_name>` keys, while bundle/library downloads use `<order_id>:<filename>` keys.
  Trove entries store `uploaded_at` and `md5`, and standard downloads store `url_last_modified` (from the HTTP
  Last-Modified header or set to the current time if missing). Example:

  ```json
  {
    "trove:into_the_breach": {
      "uploaded_at": "2018-02-27T00:00:00Z",
      "md5": "4d186321c1a7f0f354b297e8914ab240"
    },
    "ABCDEF123456:game.exe": {
      "url_last_modified": "2024-01-15T12:34:56Z"
    }
  }
  ```
- Use `--help` with all `hbd` commands to see available options
- Find supported platforms for the `--platform` flag by visiting your Humble Bundle Library
  and look under the **Platform** dropdown
- Download select bundles by using the `-k` or `--keys` flag.
  Find these keys by going to your _Purchases_ section,
  click on a products and there should be a `downloads?key=XXXX` in the url.
