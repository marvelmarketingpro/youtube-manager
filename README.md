# Marvel Marketing Pro YouTube Manager

A browser-based manager for the Marvel Marketing Pro YouTube channel, hosted on GitHub Pages.

- **Dashboard** – subscribers, views, watch time, average view duration, likes and comments for the last 7, 28 or 90 days, a daily views chart, top videos and latest uploads.
- **Videos** – every upload with status and stats; edit title, description, tags and visibility, or delete.
- **Upload** – drag-and-drop upload with title, description, tags, category, visibility, scheduling, thumbnail and playlist.
- **Content Files** – scripts, description templates, thumbnails and other working files, stored in the browser.
- **Settings** – Google connection and upload defaults.

There is no server. The page talks directly to the YouTube Data API v3 and the YouTube Analytics API using a Google sign-in token that lives only in the browser tab. No secret keys are stored in this repository.

## Deploy on GitHub Pages

1. Push these files to a repository under `marvelmarketingpro` (for example `youtube-manager`).
2. In the repository, open **Settings → Pages**, set **Source** to "Deploy from a branch", choose `main` and `/ (root)`, and save.
3. The app goes live at `https://marvelmarketingpro.github.io/youtube-manager/`.

## One-time Google setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
3. Configure the **OAuth consent screen** (External) and add the channel owner's Google account as a test user.
4. Create an **OAuth client ID** of type **Web application** with `https://marvelmarketingpro.github.io` as an Authorized JavaScript origin.
5. Open the app, go to **Settings**, paste the Client ID, save, and sign in.

## Things to know

- Uploads from a Google Cloud project that has not passed YouTube's API compliance audit are locked to private by YouTube and cannot be made public afterwards, even in YouTube Studio. Until the project passes the audit, upload videos that need to go public directly in YouTube Studio; this tool can still edit them and show their stats.
- The YouTube API has a daily quota, and uploads are the most expensive call. The quota resets at midnight Pacific time.
- While the OAuth consent screen is in "Testing", only listed test users can sign in.
- Content Files live in the browser's local storage on one computer. They are not synced or backed up.
- Anyone can open the page URL, but nobody can see or change the channel without signing in to the Google account that owns it.
