# Releasing

A release is a tag `X.Y.Z` on `main`. The version comes from the tag: no file has to be edited to change it, and the
`version` in `package.json` stays `0.0.0`. The action installs gekko by the version its user asks for, so a gekko
release has to exist before a release of the action that mentions it.

## One-time setup

Nothing but repository settings, the action has no secrets and no environment:

- Tags matching `*.*.*` can only be created by release managers and cannot be changed or deleted (repository ruleset).
- Releases are immutable (Settings → General → Releases).
- Actions are limited to the ones GitHub creates (`actions/checkout`), pinned to a full commit SHA.

## Release

1. Release gekko first, if the new version of the action depends on it (see the `RELEASE.md` of
   `jakala-germany/gekko`).

2. Make sure `main` is green.

3. Update `CHANGELOG.md`:
    1. Change `Snapshot` to the version that is released, e.g. `[1.2.0]`.
    2. Point its link at the release: `[1.2.0]: https://github.com/jakala-germany/setup-gekko-cli-action/compare/1.1.0...1.2.0`.
    3. Add a new `Snapshot` section on the top, with the link `[Snapshot]: https://github.com/jakala-germany/setup-gekko-cli-action/compare/1.2.0...HEAD`.
       The workflow takes the release notes from the section of the version.
    4. Change the version in the usage example of `README.md`.

4. Commit and push to `main`: `git commit -am "Prepare release X.Y.Z" && git push`.

5. Wait for CI on that commit, then tag exactly that commit and push only the tag:
   `git tag -am "Release X.Y.Z" X.Y.Z && git push origin X.Y.Z`

6. The workflow `Release` runs the tests and the workflow lint again, checks that the tag is on `main` and that the
   changelog has a section for it, and then creates the GitHub release with the notes of that section.

7. Check the result: the release exists and is marked as latest. Users pin the action by the commit of the tag:
   `git rev-parse X.Y.Z^{commit}`, written as `uses: jakala-germany/setup-gekko-cli-action@<sha> # X.Y.Z`.
   Update the pin in the test repositories and in the workflow templates of `jakala-germany/gekko`.

## When something fails

- Before the release is published (tests, guard, changelog): the tag cannot be moved. Delete it with the bypass of the
  ruleset (`git push --delete origin X.Y.Z`, `git tag -d X.Y.Z`), fix the problem on `main` and tag again.
- After the release is published: that version exists for good. Fix the problem and release the next patch version.
- A dry run checks everything without publishing: run the `Release` workflow manually (Actions → Release → Run
  workflow) with a version like `0.0.0-dryrun`. It also reads the notes of the newest version of the changelog.
