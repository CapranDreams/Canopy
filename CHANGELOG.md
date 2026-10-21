# Changelog

## Unreleased
- **Submodules under their parent, on demand:** submodules declared in a repository's `.gitmodules` now appear under it without `canopy.scanNested`. A repository with submodules starts collapsed; expanding it reads the submodules' status for the first time (until then they cost no Git processes or file watchers) and is remembered. Submodules stay nested when the view is grouped by status instead of being listed flat. Each submodule row shows the branch or commit it is on and has the usual buttons; Pull, Push and Sync are hidden while a repository is on a detached commit. Submodules are acted on from their own row and are not part of Fetch All, totals or profiles.
- **Glob filters:** a bare word or glob in the filter (and in smart folders and Go to Repository) now matches the repository name, its branch, any CANOPY folder it is in, or its folder path plus name, so `Platform/*` lists everything filed under Platform. Globs support `*`, `?`, `[abc]`, `[!abc]` and `{a,b}`. `folder:` (alias `in:`) matches any folder level or a path such as `Platform/Backend`; `repo:` spells out the bare-word match. Submodules count as being in their parent's folder.
- **Tree redraws only what changed:** a repository's change (a spinner, new counts, a pipeline result) redraws its row, plus the folders above it when its counts changed, instead of the whole tree; the whole tree is redrawn only when a repository moves (filter, status group, sort order, smart folder). Tooltips are built when you hover a row, badges refresh per row, and redraws are batched harder while fetches run. Per-repository facts are computed once per change instead of on every sort comparison and folder count.
- **Commit graph draws only the rows in view:** scrolling, selecting a commit or a new graph redraws about 50 rows, whatever the history length, and the panel no longer re-sends the whole graph with every update.
- **Background git yields to you:** every background git process (status reads, discovery, background fetches) runs at below-normal CPU priority; your own commands run at normal priority.
- **Fewer git processes on first load:** an ordinary repository's `.git` folder is found without running git, and the remaining lookups are combined (three processes per repository instead of five; measured 272 for 90 repositories).
- **A tip, asked once:** when VS Code's own Git auto-opens 15 or more of the workspace's repositories (and you have not set `git.autoRepositoryDetection` yourself), CANOPY offers to set it to `openEditors` for this workspace, so VS Code's Git follows only the repositories of open files. Measured with 90 repositories: startup 12.4 s → 5.3 s, and 650 → 20 git processes for 20 file saves. Nothing changes unless you click.
- New **CANOPY: Show Git Activity** command: git processes started by CANOPY in the last 10 minutes and since start, by command, with their total time.
- Experimental `canopy.useBuiltinGit` (off): read status from VS Code's own Git for repositories it already has open. Measured with 90 repositories it saved only CANOPY's small share of git processes and VS Code's Git sometimes reported saved files late, so it stays off by default.
- `npm run bench`: a benchmark that counts every git process CANOPY and VS Code's Git start for N repositories under different settings.

## 1.1.0
Performance: CANOPY now stays quiet until you ask, and never makes you wait behind its own background work.
- Background fetching is off by default, as with VS Code's own `git.autofetch`. Turn it on with `canopy.autoFetch.intervalMinutes`; background fetches then run two at a time at low CPU priority and never open a sign-in window.
- Fallback status polling (`canopy.refreshIntervalSeconds`) is off by default. File watching and saves keep status current; regaining window focus re-reads status only if the last full refresh is more than 30 minutes old. Use **Refresh** or **Fetch All** when you want everything up to date.
- **Fetch All** runs 12 repositories at once (`canopy.fetchAllConcurrency`, `0` for all at once) in its own pool, so status reads and your own commands never queue behind fetches. The refresh after a push, pull, commit or any other command now runs immediately instead of waiting for fetches to finish.
- Dropped connections ("Connection closed by remote host", "remote end hung up", HTTP 5xx and similar) are retried automatically, up to twice with backoff, without any warning. Only fetches that still fail are reported, in a single message.
- One sign-in per host: the first fetch to each host runs alone, and the others wait until it has signed in and then reuse the stored credential. If that sign-in fails, the host's other repositories are skipped for that Fetch All instead of each asking again, and the warning names the host once.
- A fetch no longer sets off follow-up work: one redraw per repository instead of three, no second status read triggered by the fetch's own `.git` writes, and no GitLab/GitHub API calls unless the branch, commit or ahead/behind counts changed.
- A status refresh normally runs one Git process instead of three (the last commit time is re-read only when HEAD moves, and remotes only when the repository config changes).
- `.git` watchers cover only the files and `refs/` folders CANOPY needs, not the whole `.git` folder.
- The details panel does no Git work while it is hidden, and reuses branches, stashes and line counts when only a spinner or pipeline status changed.
- GitLab and GitHub status no longer polls on a timer by default (`canopy.gitlab.refreshMinutes` / `canopy.github.refreshMinutes` are now `0`; set a number of minutes to opt back in). Pipeline and merge/pull request status refreshes after **Fetch**, on **Refresh**, after a push (again 5 seconds later, once the new pipeline exists) and on a branch switch or publish. Whether the pipeline belongs to the checked-out commit updates locally after a commit or pull, without a server call.
- The details panel updates in place: only the parts that changed are redrawn, so a status update no longer resets the commit graph's scroll position, hover, open menus or the commit message you are typing (cursor and undo history included).

Also new:
- The **Filter** picker has a "Sort by" section (Attention, Recent activity, Most changes, Alphabetical, Manual), so filters and sort order are set in one place. **Sort By…** offers the same list, including the new **Most changes** order.

## 1.0.0
First stable release.
- One busy indicator everywhere: while any git action runs on a repository (pull, push, sync, fetch, publish, commit, stash, branch switch, merge, rebase, cherry-pick, revert, reset, clean, tags, remotes, worktrees, submodule updates), its row in the sidebar and the Sync button in the details panel both spin and name what is happening ("Pulling…", "Stashing…"). They read the same state, so if one spins the other does, whichever way the action was started. Sync keeps a steady "Syncing…" through its pull and push. Instant staging commands do not flicker a spinner.
- The Marketplace "Preview" badge is gone, and the package now links to its GitHub repository, issues and README.
- Everything since 0.3.0: GitHub alongside GitLab, the Stats and Profiles tabs, file lists and line counts in the commit graph, the Prune menu, nested submodules with their own icon, one-click branch switching from the sidebar, priority badges and Fetch/Pull/Push/Sync buttons on repository rows.

## 0.4.1
- Repository rows in the sidebar now show progress: while a pull, push, sync, fetch, publish or submodule update is running, the row's icon spins and its text starts with what it is doing ("Pulling…", "Pushing…", "Fetching…", "Updating submodules…"). This works whichever way the operation was started: the row buttons, the details panel, the command palette or a folder action.

## 0.4.0
- Submodules: a repository that is a Git submodule of another tracked repository now appears nested under its parent in the Repositories view instead of as a separate entry. Submodules have their own icon in a teal color (change it with workbench.colorCustomizations: canopy.submoduleForeground), keep their own branch, badge and buttons, and show a yellow ≠ badge when checked out at a different commit than the parent records. Grouping by status keeps the list flat (with the same icon). A parent stays visible under filters when one of its submodules matches, and the details panel's breadcrumb says which repository a submodule belongs to.
- New Switch Branch button (branch icon) first among a repository's hover buttons: opens the branch picker for that repository or submodule. Also available as the CANOPY: Switch Branch… command.
- Folder actions (such as Fetch) now include the submodules nested under the repositories in the folder.

## 0.3.11
- Repository rows in the sidebar get inline Fetch, Pull, Push and Sync icon buttons (shown on hover, before Open Details) for every repository that has a remote. Pull and Push are hidden while a branch is unpublished; use Sync or Publish Branch there.

## 0.3.10
- The Sync and Publish Branch buttons in the details toolbar now spin, read "Syncing…" / "Publishing…" and stay disabled until the command finishes, so you can see it is working (and can't start it twice).

## 0.3.9
- Fixed Discard on an untracked file reporting "pathspec ... did not match any file(s) known to git" even though the file was stashed and removed. Git exits with an error after a successful safety stash in that case; CANOPY now checks that the stash was created and treats the discard as done.

## 0.3.8
- Profiles is now a tab in the details panel next to Graph and Stats (it still opens as its own editor tab from the Profiles commands; both show the same profile being edited).
- Pull menu: Pull (Including Submodules) pulls and then initializes and updates every submodule, recursively. It works the same whether or not the repository was cloned with --recursive.
- Push menu: Force Push… (plain --force, with a stronger warning) next to Force Push (With Lease)….
- Stash menu: View Stashes… lists stashes; pick one to see its files with lines added and deleted (click a file for its diff, untracked files included) and to apply, pop or drop it.
- Fixed a raw NUL character in the line-count parser source that made tools treat parse.ts as a binary file.

## 0.3.7
- New Stats tab in the details panel (next to Graph): lines of code, commits per week or month, lines of code over time, authors with commits, lines added and deleted and lines owned today (git blame, counted in the background), languages, a weekday-by-hour activity heatmap and the most changed files, for 3 months, 1 year or all time. Folder totals combine every repository in the same CANOPY folder.
- New settings canopy.stats.exclude (lockfiles and generated files left out of line counts) and canopy.stats.maxCommits.

## 0.3.6
- Changes list (left panel) shows lines added and deleted next to each file: staged files against HEAD, unstaged files against the index (new untracked files count every line as added; binary files show no counts).

## 0.3.5
- CI and the publish workflow now run on Node 24 (was 20). The test command's `**` glob needs Node 21 or newer, so tests failed on Node 20.

## 0.3.4
- New Prune menu in the details toolbar: prune remote branches deleted on the server, delete local branches gone on the remote or already merged (force-delete asks again for squash-merged ones), one-step Clean Up, and prune stale worktrees. The repository right-click Branch menu gets the same branch actions.
- Commit graph file lists show lines added (green +n) and deleted (red −n) next to each file, for commits and for uncommitted changes (new untracked files count every line as added; binary files show no counts).
- Repositories view: each repository shows one badge for its most urgent state, and its name takes the same color: failed pipeline (red ✕), commits to push (blue ↑), commits to pull (green ↓), uncommitted changes (yellow ●). Change the colors with workbench.colorCustomizations: canopy.pipelineFailedForeground, canopy.aheadForeground, canopy.behindForeground, canopy.changesForeground.
- Diffs opened from the details panel reuse one editor group beside it instead of splitting a new group per file, and each opens as a preview tab that the next one replaces. New setting canopy.diff.placement: reuseGroup (default) or column2.

## 0.3.2
- Branch menu colors now match the graph: local branches purple, remote branches blue (canopy.branchColors.local / .remote defaults swapped).
- Commit graph: click any commit, or the uncommitted changes row, to list its changed files inline beneath it; click a file to open its diff (merges diff against their first parent, renames diff against the old path). Commit actions moved to right-click.

## 0.3.1
- Branch menu in the repository details lists every local branch (blue) and remote branch (purple), newest first; click one to check it out.
- Profiles page colors branch names: special names such as main in purple, others in fuchsia.
- New settings canopy.branchColors.specialNames, .special, .other, .local and .remote.

## 0.3.0
- GitHub support alongside GitLab: Actions checks and pull request status (draft, conflicts, approvals), Create Pull Request, re-run failed jobs, clone or build a profile from a GitHub organization. Signs in with VS Code's GitHub account (GitHub Enterprise via github-enterprise.uri), with a personal access token fallback.
- Repo actions are now shared GitLab / GitHub commands; is:pr works as an alias for is:mr.
- canopy.maxConcurrentGit now defaults to 6.

## 0.2.3
- canopy.scanDepth now goes up to 10, and -1 scans with no depth limit (capped at 50,000 folders).

## 0.2.2
- New Marketplace page: user-facing README with screenshots, gallery banner, preview flag.
- Untracked folders in the Changes list now show their name (for example docs/).
- Demo workspace and screenshot scripts for contributors.

## 0.2.1
- Profiles: .canopy-profile.json files anywhere in the workspace now appear in Saved profiles; Save asks where to store a new profile and saves back to where a profile came from; Save as File.
- Profiles page: actions and switch options moved to the top, Select all / Select none, "main" branch shown in purple and other branches in green.

## 0.2.0
- GitLab integration for gitlab.com and self-hosted servers: guided token setup, pipeline and merge request status, create merge requests, retry pipelines, clone or build a profile from a GitLab group.
- Get Started walkthrough.
- Publisher MyriadArtificia; Entra ID publishing workflow.

## 0.1.0
- First release: multi-repo sidebar with virtual folders, smart folders, attention sorting, status grouping, filters and edit mode.
- Details panel with every Git operation, changes list with diffs beside, and a commit graph.
- Clone/switch profiles with export, share links and a reviewed apply plan.
