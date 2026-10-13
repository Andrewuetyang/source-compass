---
name: source-compass
description: Locate local source repositories and npm packages across configured code directories, including monorepos and Git worktrees. Use when a task needs another local package's source, its repository path, or a correction to the local source mapping.
---

# SourceCompass

The npm package, primary CLI command, and skill name are `source-compass`. Use the bundled launcher below.

Use the bundled CLI to find source code before searching unrelated directories. Node.js 22+ and Git must be available. Replace `<skill-folder>` below with the absolute path of this skill's folder from the skill catalog; quote paths and user input as separate shell arguments.

```bash
node "<skill-folder>/scripts/source-compass.mjs" status --json
node "<skill-folder>/scripts/source-compass.mjs" resolve "@scope/package" --json
```

The launcher includes the runtime after installation; no global CLI or npm install is needed. State defaults to `~/.workspace-resolver/state.json`. `WORKSPACE_RESOLVER_HOME` or `--store <directory>` can select another index; use the same store for every command in the task.

If the CLI reports `NOT_INITIALIZED`, use code directories already specified by the user to initialize it:

```bash
node "<skill-folder>/scripts/source-compass.mjs" init "/absolute/code-directory" --json
```

If no code root is known, ask for it instead of scanning the entire home directory. Repeated `init` adds roots and preserves manual mappings. Scanning only reads source repositories and manifests; it writes the resolver's index.

For source lookup, inspect `data.status` even when the process exits nonzero:

- `resolved` (exit 0): use `data.candidates[0].path`; `repository.path` identifies its containing Git working tree. Read its project instructions, then follow **Choose the editing branch** before changing its source.
- `ambiguous` (exit 3): compare candidate paths and repository metadata with the current task. Obtain the intended candidate when context is insufficient. Do not pick the first candidate or create an override just to silence ambiguity.
- `not_found` (exit 2): try `search "fragment" --json` or a repository remote URL. If the index may be stale, run `scan --json` once and retry. An unindexed dependency may simply not have local source; report that instead of cloning it automatically.
- `stale` (exit 4): the selected directory is missing. A manual mapping still takes priority; refresh the scan, then correct or remove the mapping when the user's intent establishes the replacement.

Results include `scannedAt` and scan `issues`. Entries beneath unreadable directories can be retained from the previous snapshot; verify the relevant files before relying on such entries. Metadata describes the last scan, not the current branch or current manifest contents.

## Choose the editing branch

For a task that will modify the located source, establish the working tree and starting branch before editing. A resolved path or the index's `repository.branch` does not select a branch strategy. Read-only source inspection can proceed without this choice.

Inspect live Git state in the selected source directory, including when a manual mapping has no indexed repository metadata:

```bash
git -C "/absolute/source" rev-parse --show-toplevel
git --no-optional-locks -C "/absolute/source" status --branch --untracked-files=normal --ignore-submodules=none
git -C "/absolute/source" remote
```

Use the resulting repository root for subsequent Git commands. Check the actual branch or detached/unborn HEAD, uncommitted changes, conflicts, and any in-progress merge or rebase. If Git inspection fails, report that fact rather than trusting the scan's branch. For a source directory outside Git, say branch selection does not apply; do not initialize a repository automatically.

Respect a branch strategy already established by the user for this task or by applicable project instructions. A prior instruction to continue on a specific branch or create a branch from a specific base remains valid; do not ask again unless the live state conflicts with it. An ordinary request to fix a dependency, an existing feature branch, or a clean working tree alone does not establish that choice.

If the strategy is unspecified, give the user the concrete source path, live branch, and summary of local changes. Ask whether to:

- Continue editing on the current branch.
- Fetch the chosen remote base and create a new task branch from it.

Make the second option concrete with a proposed remote, base, and branch name when the context establishes them. A locally known default branch can be inspected with `git -C "/absolute/repository" symbolic-ref --quiet refs/remotes/<remote>/HEAD`; this is a local hint, not proof of the remote's current default. Do not assume the base is `master` or that the remote is `origin`. If the remote or base cannot be established, include that missing choice in the same question. Wait for the answer before editing files, switching branches, fetching, or creating a branch.

After the user chooses the current branch, continue there and preserve existing unrelated changes. If those changes overlap the intended edit or the repository has conflicts or an in-progress merge/rebase, resolve how to proceed with the user before making conflicting changes.

After the user chooses a new branch, verify its remote, base, and unused branch name. With a clean working tree and no conflicting Git operation, fetch the specified base, then create the branch from the fetched remote-tracking ref. For example, **only after the user selected `origin/main` and `codex/fix-shared`**:

```bash
git -C "/absolute/repository" fetch origin refs/heads/main:refs/remotes/origin/main
git -C "/absolute/repository" switch --no-track -c codex/fix-shared refs/remotes/origin/main
```

Recheck live branch and status just before preparing the branch, and verify the resulting branch and working tree before editing. Stop on a failed fetch, an existing branch name, a changed branch, or an unexpected dirty tree; do not force the operation. With local changes, an unborn HEAD, or another Git operation, explain the obstacle and obtain a concrete plan for preserving that work. Do not automatically stash, reset, clean, merge, rebase, or use forced branch switching. A new worktree is an alternative only when the user's instructions authorize its creation.

The choice applies to the task, not permanently to the source mapping. Do not write the chosen branch into a `map` override or infer a future task's branch strategy from this task.

When the user requests a persistent source correction, record it through the CLI:

```bash
node "<skill-folder>/scripts/source-compass.mjs" map set "@scope/package" "/absolute/source" --note "Reason for this mapping" --json
node "<skill-folder>/scripts/source-compass.mjs" map unset "@scope/package" --json
```

Mappings override exact names and survive scans. They can also name source directories without a package.json. Use `map list`, `list packages`, `list repos`, `roots list`, and `history` with `--json` for inspection. Errors use `{ "ok": false, "error": { "code", "message" } }`; successful commands use `{ "ok": true, "data": ... }`. Non-resolved queries still return `ok: true` with their status.

This version discovers existing local source. Clone, worktree creation, remote GitLab discovery, dependency installation, and release operations are outside its commands.
