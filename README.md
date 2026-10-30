# setup-gekko-cli-action

GitHub Action that installs the [gekko](https://github.com/jakala-germany/gekko) CLI and its system runner from a gekko release, checks their SHA-256 and removes everything again when the job is done. It does for gekko what [`sersoft-gmbh/setup-gh-cli-action`](https://github.com/sersoft-gmbh/setup-gh-cli-action) does for the GitHub CLI.

It is a JavaScript action without dependencies and without a build step (`src/` is what runs), so the `post` step can clean up; a composite action cannot do that.

## Usage

```yaml
steps:
  - name: 'Setup gekko'
    uses: jakala-germany/setup-gekko-cli-action@1.1.0
    with:
      version: 1.1.0

  - name: 'Run tests'
    run: gekko run --tags smoke
```

`gekko` is on the `PATH` for all following steps of the job, and the system runner is found through `GEKKO_RUNNER_APK`, so `gekko.yaml` does not need a `runnerApk` and nothing has to be copied into the repository.

For iOS simulators on a macOS runner add `ios: true`. That also installs the iOS system runner and agent framework and exports `GEKKO_IOS_RUNNER_DIR` and `GEKKO_IOS_AGENT`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `version` | `latest` | gekko release, with or without a leading `v` (`1.0.0`, `v1.0.0`), or `latest` |
| `token` | `${{ github.token }}` | Token that can read the releases of the gekko repository (see below) |
| `repository` | `jakala-germany/gekko` | Repository that publishes the gekko releases |
| `ios` | `false` | Also install the iOS runner and agent (macOS only) |
| `cli-sha256` | | Optional hard pin: SHA-256 of the gekko binary of this version |
| `system-runner-sha256` | | Optional hard pin: SHA-256 of `gekko-system-runner.apk` |
| `ios-runner-sha256` | | Optional hard pin: SHA-256 of `gekko-ios-runner.zip` (with `ios: true`) |
| `ios-agent-sha256` | | Optional hard pin: SHA-256 of `gekko-ios-agent.zip` (with `ios: true`) |

## Outputs

| Output | Description |
|---|---|
| `version` | The installed gekko release, without a leading `v` |
| `path` | Absolute path of the installed `gekko` binary |

## What it exports

| Variable | Value |
|---|---|
| `PATH` | gains the directory of the `gekko` binary |
| `GEKKO_RUNNER_APK` | the Android system runner |
| `GEKKO_IOS_RUNNER_DIR` | the iOS system runner directory (`ios: true`) |
| `GEKKO_IOS_AGENT` | `GekkoAgent.framework` (`ios: true`) |

These variables take precedence over the paths in `gekko.yaml`.

## Verifying the files

Nothing has to be configured: the action compares every downloaded file with the `sha256` digest that GitHub reports for the release asset, and the step fails before anything is installed or exported when a file differs. When a release reports no digest for an asset, the step fails as well and names the input that pins it, so no file is ever installed unchecked.

That catches a corrupted or truncated download, but not an asset that someone replaced on the release (GitHub computes the digest of the new file). For a hard pin set the hash of the file you trust next to the version; a pin replaces the digest of the release:

```yaml
with:
  version: 1.1.0
  cli-sha256: <sha256 of gekko-macos-arm64 or gekko-linux-x64>
  system-runner-sha256: <sha256 of gekko-system-runner.apk>
```

The hashes of a release are in its release notes and in its `SHA256SUMS` asset, or compute them from the files you trust: `shasum -a 256 gekko-macos-arm64`. The CLI hash differs per platform, so a workflow that runs on macOS and Linux needs one per binary (set `cli-sha256` per matrix entry). The accepted forms are the bare hex string or `sha256:<hex>`, upper or lower case.

## Private repositories

The gekko repository and this action are public, so nothing has to be configured: the default `github.token` reads the releases. Only when the gekko releases come from a private repository (a fork, or before gekko is public) two settings are needed:

- **Token:** `github.token` of another repository cannot read the releases of a private repository, so pass a token that can (for example a personal access token from a secret store) as `token`.
- **Access:** in the settings of the private repositories, under *Actions → General → Access*, allow access from repositories of the organization. That applies to the repository with the release assets and to this action, so that workflows of other repositories can use it.

## Clean up

The `post` step deletes the install directory (`$RUNNER_TEMP/setup-gekko-<run id>`) when the job ends, also when the job failed, so a self-hosted runner is left as it was found. The directory is created fresh by every run of the action; the post step only deletes a directory with that name pattern.

This removes the files on the runner. Apps and port forwards that gekko put on a device are removed with `gekko uninstall` or `gekko run --uninstall`.

## Supported runners

| Runner | CLI asset |
|---|---|
| macOS arm64 | `gekko-macos-arm64` |
| Linux x64 | `gekko-linux-x64` |

Anything else fails with a clear message before any request is made. The action runs on `node24`.

## Development

```sh
node --test test/*.test.js
```

The tests start a local fake of the GitHub release API (`GITHUB_API_URL`), so they need neither network nor a token. There is nothing to install and nothing to build.

Releases are tags without a `v` (`1.0.0`), the same convention as gekko; [RELEASE.md](RELEASE.md) describes how to release.

## License

Apache-2.0, see [LICENSE](LICENSE).
