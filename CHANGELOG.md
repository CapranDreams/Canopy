# Changelog

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
