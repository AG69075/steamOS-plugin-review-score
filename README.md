# decky-steam-reviews
[Decky Loader](https://decky.xyz/) plugin for Steam Deck that displays the Steam review score (e.g. "Very Positive", "Mixed") directly on each game's page in the library.

![description](images/plugin_steam_review.png)

## Features
- Fetches the all-time score and the recent score (last 30 days) via the public Steam API
- Computes a readable label ("Overwhelmingly Positive", "Mixed", ...) even when Steam doesn't provide one
- In-memory cache (6h) to limit network calls
- Direct link to the game's reviews page on the Steam store
## Installation
1. Copy this folder into `/home/deck/homebrew/plugins/decky-steam-reviews`
2. Install dependencies and build the frontend:
   ```bash
   pnpm install
   pnpm run build
   ```
3. Restart Decky:
   ```bash
   sudo systemctl restart plugin_loader
   ```
## Project structure
| File | Role |
|---|---|
| `main.py` | Python backend — Steam API calls, caching, label computation |
| `plugin.json` | Plugin metadata (name, tags, description) |
| `package.json` | Dependencies and build scripts (frontend to be added) |
> The frontend (React/TS, `src/` folder) is not yet present in the repo as of this writing.
## API used
```
https://store.steampowered.com/appreviews/<app_id>?json=1&language=all&review_type=all&purchase_type=all
```
Fields used: `query_summary.total_positive`, `total_reviews`, `total_negative`, `review_score_desc`.
## `get_steam_reviews(appid)` method
Returns an object:
```json
{
  "found": true,
  "appid": 730,
  "all_reviews_label": "Very Positive",
  "all_reviews_positive": 0,
  "all_reviews_total": 0,
  "all_reviews_negative": 0,
  "all_reviews_score_pct": 94.4,
  "recent_reviews_label": "Mixed",
  "recent_reviews_positive": 0,
  "recent_reviews_total": 0,
  "store_url": "https://store.steampowered.com/app/730/#app_reviews_hash"
}
```
## License
GPL-2.0-or-later
