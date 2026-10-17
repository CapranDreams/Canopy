# Find your repositories

CANOPY scans:

- every **workspace folder**, a few levels deep (`canopy.scanDepth`)
- the extra folders in **`canopy.scanRoots`**, for example `~/src`
- any repository you add with **Add Repository…**

Repositories appear in the **CANOPY** view in the activity bar. Each row shows the repository name, its branch, and badges:

| Badge | Meaning |
|---|---|
| `↓3` | 3 commits to pull |
| `●2` | 2 changed files |
| `↑1` | 1 commit to push |
| `⚠` | conflicts, or a merge or rebase in progress |
| `✓ ✗ ◷` | pipeline or checks passed, failed or running |
| `!42` / `#42` | open GitLab merge request / GitHub pull request |
