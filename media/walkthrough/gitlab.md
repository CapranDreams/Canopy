# Connect GitLab or GitHub

CANOPY works out from each repository's remote whether it lives on GitLab or GitHub, so one workspace can mix both.

## GitLab (gitlab.com or self-hosted)

1. Run **CANOPY: Connect GitLab…** and pick your server. CANOPY suggests servers it finds in your remotes; you can also enter any URL.
2. Select **Open Token Page**. GitLab opens with a new personal access token named *CANOPY* and the **api** scope already filled in. Choose an expiry date and create the token.
   - Choose the **read_api** scope instead if you only want to see status.
3. Paste the token into VS Code. CANOPY checks it with the server and shows which account it belongs to.

## GitHub (github.com or GitHub Enterprise Server)

1. Run **CANOPY: Sign in to GitHub…**.
2. Approve CANOPY in the browser. This uses VS Code's own GitHub account sign-in, so there is no token to copy.

For GitHub Enterprise Server, set VS Code's `github-enterprise.uri` setting to your server first. If VS Code's GitHub sign-in isn't available in your editor, CANOPY offers a personal access token instead.

## Where your credentials go

GitLab tokens and GitHub sign-ins are stored in VS Code's **encrypted storage** on this computer. They are never written to settings or workspace files, and each is only sent to its own server. Run **Disconnect GitLab…** or **Stop Using GitHub Account…** to remove them.

If your server uses a company certificate authority, make sure your computer trusts it (VS Code setting `http.systemCertificates`).
