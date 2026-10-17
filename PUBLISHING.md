# Publishing CANOPY

CANOPY is published as **`MyriadArtificia.canopy`**. Publishing uses Microsoft Entra ID instead of a personal access token: Azure DevOps retires global PATs on December 1, 2026.

There are three separate things, and only the first is named after you:

| Thing | Name | Where |
|---|---|---|
| Marketplace **publisher** | `MyriadArtificia` (can't be changed later) | marketplace.visualstudio.com/manage |
| Entra **managed identity** that publishes | e.g. `canopy-publisher` (any name) | Azure portal, in your own (free) Azure tenant |
| **GitHub repository** that holds the code and runs the workflow | e.g. `canopy` | github.com |

## One-time setup

### 1. Create the publisher
1. Go to <https://marketplace.visualstudio.com/manage> and sign in with your **personal** Microsoft account.
2. Select **Create publisher**. ID: `MyriadArtificia`. Name: anything, e.g. `Myriad Artificia`.

### 2. Create the publishing identity in Entra ID
You need an Azure tenant. Signing up for a free Azure account with the same Microsoft account creates one. The identity itself costs nothing.

1. In the Azure portal, create a **resource group**, e.g. `canopy-publishing`.
2. Create a **User Assigned Managed Identity** in it named `canopy-publisher`.
3. Note its **Client ID**, your **Tenant ID** and the **Subscription ID**.
4. On the identity, open **Federated credentials → Add credential → GitHub Actions deploying Azure resources**:
   - Organization: your GitHub user name. Repository: `canopy`
   - Entity: **Environment**, name `marketplace`
5. In the subscription (or resource group), give the identity the **Reader** role.

### 3. Connect GitHub to the identity
In the GitHub repository:
- **Settings → Environments → New environment** `marketplace` (optionally require your approval)
- **Settings → Secrets and variables → Actions**: add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`

### 4. Let the identity publish as MyriadArtificia
1. Run the **Publish** workflow manually (**Actions → Publish → Run workflow**) with **"Only print the identity's Marketplace ID"** checked. It prints the `id` returned by
   `az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798`
2. At marketplace.visualstudio.com/manage → **MyriadArtificia → Members → Add**, paste that ID and give it the **Contributor** role.

## Each release
1. Bump `version` in `package.json` and add a line to `CHANGELOG.md`.
2. Commit, then tag: `git tag v0.2.0 && git push --tags`.
3. The **Publish** workflow runs the tests and then `vsce publish --azure-credential`.

### Publishing from your own computer instead
Install the Azure CLI, sign in with the account that owns the publisher (`az login --allow-no-subscriptions`), then run `npx vsce publish --azure-credential`. This uses your own Entra sign-in in place of the managed identity. If the Marketplace rejects it, use the workflow above.

### Without the Marketplace
`npm run package` builds `canopy-<version>.vsix`. Anyone can install it with `code --install-extension canopy-<version>.vsix`, or attach it to a GitHub release.
