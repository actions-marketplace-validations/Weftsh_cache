# Weft Cache

Cache dependencies and build outputs on [Weft](https://weft.sh), from any
runner. A drop-in for `actions/cache`: the same inputs, the same keys, the
same archives, with the cache on Weft instead of GitHub, so a job on a
GitHub-hosted runner and a job on a Weft runner (`runs-on: weft`) read and
write one cache.

```yaml
- uses: weftsh/cache@v1
  with:
    path: |
      ~/.npm
      node_modules
    key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: npm-${{ runner.os }}-
    token: ${{ secrets.WEFT_TOKEN }}   # a Weft token with repo:cache
```

The step restores before the job's other steps and saves in its post step,
exactly as `actions/cache` does. `weftsh/cache/restore` and
`weftsh/cache/save` are the two halves on their own.

## How it differs from actions/cache

- **A token and a repository, not the runner's.** `actions/cache` talks to
  the cache service the runner was registered with, which on a GitHub-hosted
  runner is GitHub's and cannot be pointed elsewhere. This action carries a
  Weft token with `repo:cache` and names the repository in a header, so the
  cache is reachable from any runner. The token goes in an `Authorization`
  header, never in a URL; the URLs the server hands back carry no credential.
- **Shared with `runs-on: weft`.** A job on a Weft runner uses the cache
  Weft gives it, with `actions/cache` as it is. Its scope is the same, your
  Weft organization and the GitHub repository by full name, so what this
  action saves on `ubuntu-latest` is a hit there and the other way round.
- **Ten days' retention.** An entry lives for ten days from when it was
  saved (a restore does not extend it), against seven days from last use on
  GitHub, and there is no per-repository size cap: the cache is billed as
  storage on your Weft plan, alongside your mirrors. An organization at its
  storage cap saves nothing more, and says so as an info line.
- **Portable keys and archives.** The key rules, the version (the path
  patterns, the compression method and the platform, hashed) and the
  tar+zstd archive are `@actions/cache`'s own code, so an entry is the one
  `actions/cache` would have written. An entry saved with one action is
  found by the other with the same `path` and `key`.

Everything else is `actions/cache`: `restore-keys` prefix matching newest
first, `cache-hit` only on an exact match, no second save after an exact
hit, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`. See
[its README](https://github.com/actions/cache#readme) for the strategies.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `path` | | A list of files, directories, and wildcard patterns to cache and restore. Required. |
| `key` | | An explicit key for restoring and saving the cache. Required. At most 512 characters, no commas. |
| `restore-keys` | | An ordered multiline string listing the prefix-matched keys used for restoring a stale cache if no cache hit occurred for `key`. `cache-hit` is `false` then. |
| `token` | | A Weft token with `repo:cache`. Required. When empty (a fork's pull request has no secrets) the step warns, reports a miss and the job goes on. |
| `repository` | `${{ github.repository }}` | The GitHub repository the cache belongs to, as `owner/name`. |
| `api-url` | `https://api.weft.sh` | The Weft deployment. |
| `upload-chunk-size` | 64 MiB | Archives over 128 MiB are uploaded in blocks of this many bytes, at most 128 MiB. |
| `enableCrossOsArchive` | `false` | Let Windows runners save and restore caches shared with other platforms. |
| `fail-on-cache-miss` | `false` | Fail the workflow if no cache entry is found. |
| `lookup-only` | `false` | Check whether an entry exists without downloading it. |
| `save-always` | `false` | Deprecated, as in `actions/cache`: use a separate `weftsh/cache/save` step instead. |

## Outputs

| Output | Meaning |
|---|---|
| `cache-hit` | `true` when an exact match was found for `key`. `false` on a `restore-keys` match. Not set on a miss. |
| `cache-primary-key` | (restore only) the key the lookup was for. |
| `cache-matched-key` | (restore only) the key that was restored: `key`, or the `restore-keys` match. |

## What never fails the job

The cache is optional, as it is for `actions/cache`. Each of these is a
warning on the step and a miss (or an unsaved cache), and the job carries on:

- no token, or a token Weft does not know (`401`);
- a token that is not a `repo:cache` token, or one restricted to a single
  Weft repository (`403`);
- a `repository` that is not `owner/name` (checked before anything is sent);
- Weft unreachable, or answering a 5xx after three tries (an error line
  rather than a warning, as `actions/cache` reports its own service);
- an entry that already exists, is being written by another job, or an
  organization at its storage cap (an info line).

Only `fail-on-cache-miss: true` turns a miss into a failed step, and a key
`actions/cache` would refuse (a comma, over 512 characters, more than ten
keys in all) is refused here too.

## Limits

- **Archive size**: one entry up to what your plan's storage allows. Up to
  128 MiB goes up in one request; above that in blocks of
  `upload-chunk-size`, four at a time.
- **Retention**: ten days from the save.
- **Keys**: 512 characters, no commas, ten keys per lookup including
  `restore-keys`, the same as `actions/cache`.
- **Events**: any event tied to a ref, the same rule as `actions/cache`.
- **Platforms**: Linux, macOS and Windows runners, with `zstd` used when it
  is on the runner and gzip otherwise, the same choice `actions/cache`
  makes; caches are only shared between runners that make the same choice.

## Getting a token

In the Weft dashboard, under your organization's tokens, mint one with the
`repo:cache` scope and no repository restriction, and store it as a
repository or organization secret. The cache is scoped to your Weft
organization and the GitHub repository by name: a token of one organization
never sees another's entries, even for the same repository name.

## Developing

```sh
npm ci
npm test          # vitest against a Node http fake of Weft's cache routes
npm run build     # ncc bundles to dist/, which is committed
```

CI checks that `dist/` is what the sources build to, and runs a real save
and restore on `ubuntu-latest` and on `weft`, each restoring what the other
saved.

## License

MIT. Derived from [actions/cache](https://github.com/actions/cache) (MIT,
GitHub).
