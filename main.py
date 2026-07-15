import asyncio
import json
import ssl
import time
import urllib.request
from typing import Any, Dict, Optional

import decky_plugin
from settings import SettingsManager


REVIEWS_ENDPOINT = (
    "https://store.steampowered.com/appreviews/{appid}"
    "?json=1&language=all&review_type=all&purchase_type=all&num_per_page=0"
)
USER_AGENT = "SteamDeckPlugin/1.0"
CACHE_TTL_SECONDS = 60 * 60 * 6  # 6 hours


SCORE_LABELS = [
    (0.95, "Overwhelmingly Positive"),
    (0.85, "Very Positive"),
    (0.80, "Mostly Positive"),
    (0.70, "Mixed"),
    (0.40, "Mostly Negative"),
    (0.20, "Very Negative"),
    (0.00, "Overwhelmingly Negative"),
]


def _compute_label(positive: int, total: int) -> str:
    if total == 0:
        return "No Reviews"
    ratio = positive / total
    for threshold, label in SCORE_LABELS:
        if ratio >= threshold:
            return label
    return "Overwhelmingly Negative"


class SteamReviewsClient:
    def __init__(self) -> None:
        self._ssl_context = ssl.create_default_context()
        self._cache: Dict[str, Dict[str, Any]] = {}

    def lookup(self, appid: int) -> Dict[str, Any]:
        key = str(appid)
        now = time.time()
        cached = self._cache.get(key)
        if cached and now - cached["timestamp"] < CACHE_TTL_SECONDS:
            return cached["data"]

        data = self._fetch_reviews(appid)
        if data.get("found"):
            self._cache[key] = {"timestamp": now, "data": data}
        return data

    def _fetch_reviews(self, appid: int) -> Dict[str, Any]:
        if not appid:
            return {"found": False, "error": "Missing appid"}

        url = REVIEWS_ENDPOINT.format(appid=appid)
        payload = self._request_json(url)

        if payload.get("success") != 1:
            return {"found": False, "error": "Steam API returned failure"}

        query_summary = payload.get("query_summary", {})
        total_positive = query_summary.get("total_positive", 0)
        total_reviews = query_summary.get("total_reviews", 0)
        total_negative = query_summary.get("total_negative", 0)
        review_score_desc = query_summary.get("review_score_desc", "")

        # Compute percentage
        score_pct = (
            round((total_positive / total_reviews) * 100, 2)
            if total_reviews > 0
            else None
        )

        # Use Steam's own label if available, otherwise compute ours
        label = review_score_desc or _compute_label(total_positive, total_reviews)

        # Recent reviews (last 30 days filter)
        recent_url = (
            REVIEWS_ENDPOINT.format(appid=appid)
            .replace("language=all", "language=all")
            + "&day_range=30"
        )
        recent_payload = self._request_json(recent_url)
        recent_summary = recent_payload.get("query_summary", {}) if recent_payload.get("success") == 1 else {}
        recent_positive = recent_summary.get("total_positive", 0)
        recent_total = recent_summary.get("total_reviews", 0)
        recent_score_desc = recent_summary.get("review_score_desc", "")
        recent_label = recent_score_desc or _compute_label(recent_positive, recent_total)

        store_url = f"https://store.steampowered.com/app/{appid}/#app_reviews_hash"

        return {
            "found": True,
            "appid": appid,
            # All-time
            "all_reviews_label": label,
            "all_reviews_positive": total_positive,
            "all_reviews_total": total_reviews,
            "all_reviews_negative": total_negative,
            "all_reviews_score_pct": score_pct,
            # Recent
            "recent_reviews_label": recent_label,
            "recent_reviews_positive": recent_positive,
            "recent_reviews_total": recent_total,
            # Links
            "store_url": store_url,
        }

    def _request_json(self, url: str) -> Dict[str, Any]:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, context=self._ssl_context, timeout=15) as res:
            payload = res.read()
            return json.loads(payload)


class Plugin:
    def __init__(self) -> None:
        self.settings: Optional[SettingsManager] = None
        self._steam_reviews = SteamReviewsClient()

    async def _main(self) -> None:
        self.settings = SettingsManager(
            name="config", settings_directory=decky_plugin.DECKY_PLUGIN_SETTINGS_DIR
        )

    async def _unload(self) -> None:
        pass

    async def set_setting(self, key: str, value: Any) -> None:
        if not self.settings:
            return
        self.settings.setSetting(key, value)

    async def get_setting(self, key: str, default: Any = None) -> Any:
        if not self.settings:
            return default
        return self.settings.getSetting(key, default)

    async def get_steam_reviews(self, appid: int) -> Dict[str, Any]:
        """
        Fetch Steam review summary for a given appid.

        Returns:
            {
                found: bool,
                appid: int,
                all_reviews_label: str,       e.g. "Overwhelmingly Positive"
                all_reviews_positive: int,
                all_reviews_total: int,
                all_reviews_negative: int,
                all_reviews_score_pct: float, e.g. 94.4
                recent_reviews_label: str,    e.g. "Very Positive"
                recent_reviews_positive: int,
                recent_reviews_total: int,
                store_url: str,
            }
        """
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None, self._steam_reviews.lookup, appid
            )
            return result
        except Exception as err:
            decky_plugin.logger.error(f"Steam reviews lookup failed: {err}")
            return {"found": False, "error": "Lookup failed"}
