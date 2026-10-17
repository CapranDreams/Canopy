# Changelog

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
