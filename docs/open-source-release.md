# Prepare a source release

Use `sample-eddie` as the publication repository name. The source export is
separate from an installed environment or a container image.

## Export the reviewed source

```bash
python3 scripts/export_public_source.py --check
python3 scripts/export_public_source.py --output build/publication/sample-eddie
```

The allowlist in `release/public-source.json` includes application code, all
first-party tests, deployment scripts/templates, dependency locks, selected user
documentation and reviewed static assets. It excludes development notes, browser
recordings, scan exports, generated configuration, dependencies and build output.
The export writes a file-hash manifest outside the candidate directory.

The check rejects symlinks, unexpected binaries, recognizable environment
identifiers, internal links and private-key material. These checks complement
security scanners and visual review; they do not prove the absence of all
sensitive content or vulnerabilities.

## Keep organization-specific checks private

Put organization-specific rules in the untracked `internal/publication-policy.json`.
The exporter loads it when present and excludes it from the source bundle:

```json
{
  "format": 1,
  "blockedHostnames": ["intranet.example.invalid"],
  "blockedText": ["/private-review-draft/"]
}
```

Replace these examples with your organization's rules. Use `--policy /path/to/private-policy.json`
to check an exported tree with an external policy. A missing explicit policy fails;
without a configured policy, the output states that organization-host checks did not run.
Email, account, credential and artifact checks still run. The standard public contact in
`CODE_OF_CONDUCT.md` is permitted; use placeholders for personal contacts.

## Start with new Git history

An export contains **no `.git` directory**. Initialize it as a new repository and
make one initial commit. Do not copy development Git objects, tags or remotes;
deleting files in a later commit does not remove them from earlier commits.
A fresh source archive is also suitable for review tools that accept uploads.

Review the candidate commit and archive, not a developer checkout with different
uncommitted files. Record the commit, source-tree digest, artifact hashes, tool
versions, scan times and scope with the private review evidence.

## Validate and publish

Build and test the exported tree. Run source/secret checks, JavaScript dependency
scanning, Python dependency scanning, infrastructure checks and the applicable
review-platform scans against that same revision. Scan built containers separately
and preserve their immutable image digests. A source-only scan cannot establish
container safety or deployment correctness.

Keep scan exports private and provide them to reviewers. Label older reports as
historical evidence; do not present a local scanner as a replacement for a scan
that the review process specifically requires.

Publish the fresh repository only after the required security and open-source
release approvals, using the approved organization. This export process neither
publishes the code nor grants those approvals. Keep the [LICENSE](../LICENSE),
[NOTICE](../NOTICE), [security guidance](../SECURITY.md),
[contribution guide](../CONTRIBUTING.md) and [Code of Conduct](../CODE_OF_CONDUCT.md)
with the source. Preserve third-party licenses/notices in distributed builds.
