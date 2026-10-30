# Changelog

## [Snapshot]

[Snapshot]: https://github.com/jakala-germany/setup-gekko-cli-action/compare/1.1.0...HEAD

**New**

- Upcoming additions go here

**Changed**

- Upcoming changes go here

## [1.1.0]

[1.1.0]: https://github.com/jakala-germany/setup-gekko-cli-action/compare/1.0.0...1.1.0

**Changed**

- Released together with gekko 1.1.0; no functional change

## [1.0.0]

[1.0.0]: https://github.com/jakala-germany/setup-gekko-cli-action/releases/tag/1.0.0

**New**

- Installs the gekko CLI (`gekko-macos-arm64` or `gekko-linux-x64`) and the Android system runner from a release of `jakala-germany/gekko`, puts `gekko` on the PATH and exports `GEKKO_RUNNER_APK`
- Input `ios` also installs the iOS simulator runner and agent and exports `GEKKO_IOS_RUNNER_DIR` and `GEKKO_IOS_AGENT`
- Every download is verified against the sha256 digest that GitHub reports for the release asset; a mismatch, or a release that reports no digest, fails the step before anything is installed
- Optional inputs `cli-sha256`, `system-runner-sha256`, `ios-runner-sha256` and `ios-agent-sha256` hard-pin a file and replace the release digest
- Downloads work for private repositories (`token` input)
- The post step removes everything that was installed
