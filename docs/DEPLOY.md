# Put OmniChannel online (open it in Chrome, no terminal)

You'll get a link like `https://omnichannel-xxxx.onrender.com` that opens in Chrome on any computer or phone. About 20 minutes, mostly waiting for the first build. No terminal needed.

## 1. Put the code on GitHub (with GitHub Desktop)

1. Unzip `omnichannel.zip`.
2. Install **GitHub Desktop** (desktop.github.com) and sign in with your GitHub account.
3. **File → Add local repository…** → choose the unzipped `omnichannel` folder. It says "This directory does not appear to be a Git repository" → click **create a repository** → **Create repository**.
4. Click **Publish repository**. Keeping it **Private** is fine.

## 2. Deploy on Render

1. Go to **render.com** → **Get Started** → sign up with **GitHub**.
2. Click **New +** → **Blueprint**.
3. Connect your GitHub if asked, then pick the `omnichannel` repository.
4. Render reads `render.yaml` and shows: one web service (`omnichannel`) and one database (`omnichannel-db`). It asks for a few values:
   - **DEMO_PASSWORD**: optional. Type a password if you want demo products and orders loaded (log in as `demo@omnichannel.dev` with that password). Leave empty for a clean start.
   - **SHOPIFY_…, EBAY_…**: leave empty for now. You can add them later.
5. Click **Apply** / **Deploy Blueprint**. The first build takes about 5–10 minutes. Watch it under the service's **Logs**. It's ready when you see `API listening` and `Ready`.

## 3. Open it

Click the service's URL at the top of its Render page (`https://omnichannel-….onrender.com`).
- If you set DEMO_PASSWORD: sign in as `demo@omnichannel.dev`.
- Otherwise click **Create a workspace**. **The first account becomes the owner, and sign-up then closes.** Add teammates under **Settings → Team & roles**.

Bookmark it. It works in Chrome on your laptop and phone.

## Things to know about the free plan

| | Free plan | What to do |
|---|---|---|
| Sleeping | The site sleeps after 15 min with no visitors; the next visit takes ~1 minute to wake | Fine for trying it. For real selling, change the service to **Starter** (always on). |
| Database | **Free Postgres expires after 30 days** | Upgrade the database to a paid plan before then, or you lose the data |
| Speed | Small CPU; pages may feel slow | Starter plan is noticeably faster |
| Real marketplaces | Webhooks arriving while it sleeps wake it up; marketplaces retry, and scheduled polling catches anything missed once awake | Use Starter once you connect real stores |

Prices change, so check render.com/pricing.

## Updating later

Change files → in GitHub Desktop click **Commit** then **Push origin** → Render redeploys automatically. Your data stays in the database.

## Connecting real Shopify / eBay later

In Render: service → **Environment** → add `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (or the eBay keys) → **Save, rebuild and deploy**.

In your Shopify app settings, set the redirect URL to:
```
https://<your-render-url>/api/marketplaces/oauth/shopify/callback
```
Details: `docs/MARKETPLACES.md`.

**Important:** never change `ENCRYPTION_KEY` after the first deploy. It protects the stored marketplace tokens.
