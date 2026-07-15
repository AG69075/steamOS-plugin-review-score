# decky-steam-reviews

Plugin [Decky Loader](https://decky.xyz/) pour Steam Deck qui affiche le score d'évaluation Steam (ex: "Very Positive", "Mixed") directement sur la fiche de chaque jeu dans la bibliothèque.

## Fonctionnalités

- Récupère le score global (all-time) et le score récent (30 derniers jours) via l'API publique Steam
- Calcule un label lisible ("Overwhelmingly Positive", "Mixed", ...) même si Steam ne le fournit pas
- Cache en mémoire (6h) pour limiter les appels réseau
- Lien direct vers la page reviews du jeu sur le store Steam

## Installation

1. Copier ce dossier dans `/home/deck/homebrew/plugins/decky-steam-reviews`
2. Installer les dépendances et builder le frontend :
   ```bash
   pnpm install
   pnpm run build
   ```
3. Redémarrer Decky :
   ```bash
   sudo systemctl restart plugin_loader
   ```

## Structure du projet

| Fichier | Rôle |
|---|---|
| `main.py` | Backend Python — appel API Steam, cache, calcul du label |
| `plugin.json` | Métadonnées du plugin (nom, tags, description) |
| `package.json` | Dépendances et scripts de build (frontend à ajouter) |

> Le frontend (React/TS, dossier `src/`) n'est pas encore présent dans le repo à date.

## API utilisée

```
https://store.steampowered.com/appreviews/<app_id>?json=1&language=all&review_type=all&purchase_type=all
```

Champs exploités : `query_summary.total_positive`, `total_reviews`, `total_negative`, `review_score_desc`.

## Méthode `get_steam_reviews(appid)`

Retourne un objet :

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

## Licence

GPL-2.0-or-later
