# 🎟️ Ticket P&L Tracker

A private dashboard for ticket resale: your PL orders + Discord sale alerts in one place, saved forever in Supabase.

- **Overview** – profit, revenue, ROI, win rate for any month or year; profit-by-month chart; profit by artist; biggest wins/losses
- **Artists** – bought vs sold, profit, ROI, unsold inventory per artist (rename/merge artists)
- **Shows** – one row per artist per show date
- **Inventory** – every PL order: sold / left / unsold cost
- **Sales** – every sale, searchable, with a CSV download
- **Import** – drop in the PL CSV and paste Discord sales; only new data is added

Try it with no setup: open the site and click **Try it without saving (demo)**.

## One-time setup (about 10 minutes)

### 1. Supabase (stores your data)
1. Create a free project at supabase.com.
2. **SQL Editor → New query** → paste all of `schema.sql` → **Run**.
3. **Authentication → Users → Add user → Create new user**: your email + a password, tick **Auto Confirm User**.
4. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up" (so only you can log in).
5. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

### 2. GitHub Pages (hosts the website)
1. Create a new GitHub repository and upload every file in this folder.
2. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
3. After a minute your site is at `https://<your-username>.github.io/<repo-name>/`.

### 3. First visit
Open the site, paste the Project URL + anon key, sign in. (Optional: put both values in `config.js` so you never type them again – they are safe to publish.)

## Every time you want to update
1. PL Orders sheet → **File → Download → CSV**.
2. Discord (in Chrome, at discord.com) → click the **Sales Grabber** bookmark → scroll up past your last import → **Copy all**.
3. Site → **Import** → drop the CSV, paste the sales → **Add to my database**.

Duplicates are skipped automatically, changed orders are updated, nothing is ever deleted unless you click Remove on a sale.

## Privacy
Your data is only readable after signing in, enforced by Supabase row-level security. The website code is public (GitHub Pages), your data is not.

## Files
| File | What it is |
|---|---|
| `index.html` | the page and styles |
| `app.js` | screens, import, Supabase saving |
| `core.js` | parsing Discord text, matching sales to orders, all the math |
| `grabber.js` / `grabber-source.js` | the Sales Grabber bookmarklet (minified / readable) |
| `config.js` | optional Supabase URL + anon key |
| `schema.sql` | database tables + security rules |
