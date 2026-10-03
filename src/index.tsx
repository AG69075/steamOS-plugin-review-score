import { routerHook, fetchNoCors } from "@decky/api";
import {
  ButtonItem,
  definePlugin,
  Field,
  PanelSection,
  PanelSectionRow,
  SliderField,
  staticClasses,
  findInReactTree,
  createReactTreePatcher,
  afterPatch,
  appDetailsClasses,
  ReactRouter,
} from "@decky/ui";
import * as React from "react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { FaStar } from "react-icons/fa";

// ─── Settings ────────────────────────────────────────────────────────────────

type Position = "top-right" | "top-left" | "top-center";

interface Settings {
  position: Position;
  horizontalOffset: number;
  verticalOffset: number;
}

const STORAGE_KEY = "steam-reviews.settings";

const POSITION_OPTIONS: { value: Position; label: string }[] = [
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top center" },
];

const defaultSettings: Settings = {
  position: "top-right",
  horizontalOffset: 24,
  verticalOffset: 56,
};

const readSettings = (): Settings => {
  if (typeof localStorage === "undefined") {
    return defaultSettings;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw);
    return { ...defaultSettings, ...parsed };
  } catch (_error) {
    return defaultSettings;
  }
};

// Shared global state — single source of truth across all hook instances
let _globalSettings = readSettings();
const _listeners = new Set<(settings: Settings) => void>();
const _notifyListeners = () => {
  _listeners.forEach((fn) => fn(_globalSettings));
};
const _setGlobal = (partial: Partial<Settings>) => {
  _globalSettings = { ..._globalSettings, ...partial };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_globalSettings));
  }
  _notifyListeners();
};

const useSettings = () => {
  const [settings, setSettings] = useState(_globalSettings);
  useEffect(() => {
    const handler = (s: Settings) => setSettings({ ...s });
    _listeners.add(handler);
    setSettings({ ..._globalSettings });
    return () => {
      _listeners.delete(handler);
    };
  }, []);
  const setPartialSetting = useCallback((partial: Partial<Settings>) => {
    _setGlobal(partial);
  }, []);
  return { settings, setSetting: setPartialSetting };
};

// ─── Settings Panel ───────────────────────────────────────────────────────────

const SettingsPanel = () => {
  const { settings, setSetting } = useSettings();
  const posIdx = POSITION_OPTIONS.findIndex((o) => o.value === settings.position);
  return (
    <PanelSection title="Steam Reviews">
      <PanelSectionRow>
        <Field label="Card position">
          <ButtonItem
            layout="below"
            onClick={() => {
              const next = POSITION_OPTIONS[(posIdx + 1) % POSITION_OPTIONS.length];
              setSetting({ position: next.value });
            }}
          >
            {POSITION_OPTIONS[posIdx]?.label ?? settings.position}
          </ButtonItem>
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="Horizontal offset"
          value={settings.horizontalOffset}
          min={0}
          max={100}
          step={1}
          onChange={(val: number) => setSetting({ horizontalOffset: val })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="Vertical offset"
          value={settings.verticalOffset}
          min={0}
          max={300}
          step={4}
          onChange={(val: number) => setSetting({ verticalOffset: val })}
        />
      </PanelSectionRow>
    </PanelSection>
  );
};

// ─── Game Overview Hook ───────────────────────────────────────────────────────

const useParams = Object.values(ReactRouter).find((val) =>
  /return (\w)\?\1\.params:{}/.test(`${val}`)
) as () => { appid?: string };

const useGameOverview = () => {
  const { appid } = useParams();
  const [overview, setOverview] = useState<any>();
  useEffect(() => {
    if (!appid) return;
    const numericId = parseInt(appid, 10);
    if (Number.isNaN(numericId)) return;
    const details = (window as any).appStore.GetAppOverviewByGameID(numericId);
    setOverview(details);
  }, [appid]);
  return overview;
};

// ─── Global "game launching" tracker ──────────────────────────────────────────
// Registered ONCE at plugin mount (not per badge-instance) so it survives the
// badge component being torn down/rebuilt frequently by route re-renders.
//
// Only GameActionStart is used to set the hidden state.
// GameActionEnd and RegisterForAppLifetimeNotifications are intentionally
// NOT used to clear it: GameActionEnd can fire too early (before the game
// actually appears on screen), and onLifetime fires as soon as bRunning=true
// (a few seconds after launch), both of which caused the badge to reappear
// almost immediately.
//
// Instead, the badge stays hidden for exactly 5 minutes (300 000 ms) via the
// safety timer — long enough to ensure the game is fully loaded and the user
// won't see the badge pop back in during the transition.
let _launchingAppid: number | null = null;
let _launchingSafetyTimer: ReturnType<typeof setTimeout> | null = null;
const _launchListeners = new Set<() => void>();
const _notifyLaunchListeners = () => {
  _launchListeners.forEach((fn) => {
    try {
      fn();
    } catch (_err) {
      /* ignore */
    }
  });
};
const _clearLaunching = () => {
  if (_launchingSafetyTimer) {
    clearTimeout(_launchingSafetyTimer);
    _launchingSafetyTimer = null;
  }
  _launchingAppid = null;
  _notifyLaunchListeners();
};

const registerGameActionTracking = () => {
  console.log("[steam-reviews] registerGameActionTracking() called at plugin mount.");
  let onStart: { unregister?: () => void } | undefined;
  try {
    onStart = (window as any).SteamClient?.Apps?.RegisterForGameActionStart?.(
      (_actionType: unknown, strAppId: string, actionName: string) => {
        if (actionName !== "LaunchApp") return;
        _launchingAppid = parseInt(strAppId, 10);
        console.log(`[steam-reviews] (global) GameActionStart LaunchApp for ${_launchingAppid}`);
        _notifyLaunchListeners();
        // Badge stays hidden for 5 minutes after launch.
        // No other event clears this — only the timer.
        if (_launchingSafetyTimer) clearTimeout(_launchingSafetyTimer);
        _launchingSafetyTimer = setTimeout(() => {
          console.log("[steam-reviews] (global) 5-min launch timer elapsed — clearing state.");
          _clearLaunching();
        }, 300000);
      }
    );
  } catch (err) {
    console.warn("[steam-reviews] RegisterForGameActionStart unavailable:", err);
  }
  return () => {
    try {
      onStart?.unregister?.();
    } catch (_err) {
      /* ignore */
    }
    if (_launchingSafetyTimer) {
      clearTimeout(_launchingSafetyTimer);
      _launchingSafetyTimer = null;
    }
  };
};

const useIsGameLaunching = (appid: number | undefined) => {
  const [, forceRender] = useReducer((c) => c + 1, 0);
  useEffect(() => {
    const listener = () => forceRender();
    _launchListeners.add(listener);
    return () => {
      _launchListeners.delete(listener);
    };
  }, []);
  return appid != null && _launchingAppid === appid;
};

// ─── Steam Reviews API ────────────────────────────────────────────────────────

interface SteamReviewsResult {
  found: boolean;
  error?: string;
  appid?: number;
  all_reviews_label?: string;
  all_reviews_positive?: number;
  all_reviews_total?: number;
  all_reviews_negative?: number;
  all_reviews_score_pct?: number | null;
  recent_reviews_label?: string;
  recent_reviews_total?: number;
  recent_reviews_score_pct?: number | null;
  store_url?: string;
}

const CACHE_KEY = "steam-reviews.cache.v5";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 15000; // 15 seconds — avoid the badge hanging on "Loading…" forever

const getCached = (key: string): SteamReviewsResult | undefined => {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    const entry = parsed[key];
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) return undefined;
    return entry.payload;
  } catch (_err) {
    return undefined;
  }
};

const setCached = (key: string, payload: SteamReviewsResult) => {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[key] = { timestamp: Date.now(), payload };
    localStorage.setItem(CACHE_KEY, JSON.stringify(parsed));
  } catch (_err) {
    // ignore
  }
};

// Steam's public appreviews JSON endpoint only ever returns all-time totals in
// query_summary — the filter/day_range params only affect which individual
// reviews are listed, not the aggregate score. The 30-day "recent" score is
// only available server-rendered on the store page itself, so we scrape that
// one block out of the HTML instead. Bypass the mature-content age gate via
// cookies (a long-standing, stable Steam trick) so the block is present for
// every app, not just non-mature ones.
const RECENT_REVIEWS_RE =
  /data-tooltip-html="(\d+)% of the ([\d,]+) user reviews in the last 30 days are positive\."[\s\S]*?<span class="game_review_summary [a-z_]+">([^<]+)<\/span>/;

const parseRecentReviews = (
  html: string
): Pick<SteamReviewsResult, "recent_reviews_label" | "recent_reviews_total" | "recent_reviews_score_pct"> | undefined => {
  const match = html.match(RECENT_REVIEWS_RE);
  if (!match) return undefined;
  return {
    recent_reviews_score_pct: parseInt(match[1], 10),
    recent_reviews_total: parseInt(match[2].replace(/,/g, ""), 10),
    recent_reviews_label: match[3].trim(),
  };
};

const queryRecentReviews = async (appid: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchNoCors(`https://store.steampowered.com/app/${appid}/`, {
      method: "GET",
      headers: {
        Accept: "text/html",
        Cookie: "birthtime=0; lastagecheckage=1-January-1990; wants_mature_content=1",
      },
      signal: controller.signal,
    } as RequestInit);
    if (!resp.ok) return undefined;
    const html = await resp.text();
    return parseRecentReviews(html);
  } catch (_err) {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async (url: string, signal: AbortSignal) => {
  const resp = await fetchNoCors(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  } as RequestInit);
  if (!resp.ok) throw new Error(`Steam API error (${resp.status})`);
  return resp.json();
};

// Official IUserReviewsService/GetAppReviews (works without an API key). Notes:
// `languages` must be ["all"] (default is English only, which gives wrong
// totals), `num_per_page` is clamped to >= 1, and unknown appids come back as
// an empty `response` object rather than a failure flag.
const fetchReviewSummaryV1 = async (appid: number, signal: AbortSignal) => {
  const input = encodeURIComponent(
    JSON.stringify({ filter: "all", languages: ["all"], num_per_page: 1 })
  );
  const payload = await getJson(
    `https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?appid=${appid}&input_json=${input}`,
    signal
  );
  return payload?.response?.query_summary;
};

// Legacy endpoint, deprecated by Valve — kept only as a fallback.
const fetchReviewSummaryLegacy = async (appid: number, signal: AbortSignal) => {
  const payload = await getJson(
    `https://store.steampowered.com/appreviews/${appid}?json=1&filter=all&review_type=all&purchase_type=all&language=all&num_per_page=0`,
    signal
  );
  return payload?.success === 1 ? (payload.query_summary ?? {}) : undefined;
};

const fetchReviewSummary = async (appid: number, signal: AbortSignal) => {
  try {
    const qs = await fetchReviewSummaryV1(appid, signal);
    if (qs) return qs;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
  }
  return fetchReviewSummaryLegacy(appid, signal);
};

const querySteamReviews = async (appid: number): Promise<SteamReviewsResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const qs = await fetchReviewSummary(appid, controller.signal);
    if (!qs) return { found: false, error: "Steam API returned failure" };

    const totalPositive = qs.total_positive ?? 0;
    const totalReviews = qs.total_reviews ?? 0;
    const totalNegative = qs.total_negative ?? 0;
    const scorePct =
      totalReviews > 0 ? Math.round((totalPositive / totalReviews) * 10000) / 100 : null;
    const allLabel = qs.review_score_desc || "No Reviews";

    // Best-effort — a scrape failure shouldn't take down the all-time score.
    const recent = await queryRecentReviews(appid);

    return {
      found: true,
      appid,
      all_reviews_label: allLabel,
      all_reviews_positive: totalPositive,
      all_reviews_total: totalReviews,
      all_reviews_negative: totalNegative,
      all_reviews_score_pct: scorePct,
      ...recent,
      store_url: `https://store.steampowered.com/app/${appid}/#app_reviews_hash`,
    };
  } catch (err) {
    return {
      found: false,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? "Steam API timed out"
            : err.message
          : "Unable to contact Steam",
    };
  } finally {
    clearTimeout(timer);
  }
};

const useSteamReviews = (appid: number | undefined) => {
  // Init directly from cache to avoid "Loading..." flash after idle/remount
  const [data, setData] = useState<SteamReviewsResult | undefined>(() =>
    appid != null ? getCached(String(appid)) : undefined
  );
  const [loading, setLoading] = useState(() => (appid != null ? !getCached(String(appid)) : false));
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!appid) return;
    const cacheKey = String(appid);
    const cached = getCached(cacheKey);
    if (cached) {
      setData(cached);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await querySteamReviews(appid);
      if (result.found) {
        setCached(cacheKey, result);
      }
      setData(result);
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setData(undefined);
    } finally {
      setLoading(false);
    }
  }, [appid]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
};

// ─── Tone helpers ─────────────────────────────────────────────────────────────

type Tone = "unknown" | "great" | "good" | "weak";

const toneForPct = (pct: number | null | undefined): Tone => {
  if (typeof pct !== "number") return "unknown";
  if (pct >= 80) return "great";
  if (pct >= 65) return "good";
  return "weak";
};

// Drops trailing zeros — 92 stays "92", 74.09 stays "74.09".
const formatPct = (pct: number): string => pct.toFixed(2).replace(/\.?0+$/, "");

// ─── CSS ──────────────────────────────────────────────────────────────────────

const steamReviewsStyle = (
  <style>{`
    .steamrev-badge-root {
      position: absolute;
      z-index: 2;
      --steamrev-offset-x: 24px;
      --steamrev-offset-y: 56px;
    }

    .steamrev-badge-root[data-position='top-right'] {
      top: var(--steamrev-offset-y);
      right: var(--steamrev-offset-x);
    }
    .steamrev-badge-root[data-position='bottom-right'] {
      bottom: var(--steamrev-offset-y);
      right: var(--steamrev-offset-x);
    }
    .steamrev-badge-root[data-position='top-left'] {
      top: var(--steamrev-offset-y);
      left: var(--steamrev-offset-x);
    }
    .steamrev-badge-root[data-position='bottom-left'] {
      bottom: var(--steamrev-offset-y);
      left: var(--steamrev-offset-x);
    }
    .steamrev-badge-root[data-position='top-center'] {
      top: var(--steamrev-offset-y);
      left: 50%;
      transform: translateX(-50%);
    }
    .steamrev-badge-root[data-position='bottom-center'] {
      bottom: var(--steamrev-offset-y);
      left: 50%;
      transform: translateX(-50%);
    }

    .steamrev-card {
      min-width: 255px;
      width: fit-content;
      max-width: min(420px, 92vw);
      background: rgba(10, 10, 10, 0.88);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 10px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: #f5f5f5;
      font-family: var(--font-family, "Motiva Sans");
      box-shadow: 0 8px 16px rgba(0,0,0,0.4);
      backdrop-filter: blur(6px);
    }

    .steamrev-scores {
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: 6px;
      row-gap: 3px;
      align-items: baseline;
    }

    .steamrev-score-row {
      display: contents;
    }

    .steamrev-row-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: rgba(255,255,255,0.50);
      text-transform: uppercase;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .steamrev-row-value {
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      overflow-wrap: anywhere;
    }

    .steamrev-row-value[data-tone='great'] { color: #66bb6a; }
    .steamrev-row-value[data-tone='good']  { color: #ffb74d; }
    .steamrev-row-value[data-tone='weak']  { color: #ef5350; }

    .steamrev-row-count {
      font-size: 11px;
      color: rgba(255,255,255,0.45);
    }

    .steamrev-divider {
      grid-column: 1 / -1;
      border: none;
      border-top: 1px solid rgba(255,255,255,0.08);
      margin: 2px 0;
    }

    .steamrev-score-chip { display: none; }

    .steamrev-card-inner {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }

    .steamrev-steam-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: rgba(255,255,255,0.65);
    }
    .steamrev-body { display: none; }
    .steamrev-title { display: none; }
    .steamrev-status { display: none; }
    .steamrev-actions { display: none; }
  `}</style>
);

// ─── Badge Component ──────────────────────────────────────────────────────────

function SteamLogo(props: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size || 22}
      height={props.size || 22}
      fill="currentColor"
      style={props.style || {}}
    >
      <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.497 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.252 0-2.265-1.014-2.265-2.265z" />
    </svg>
  );
}

const SteamReviewsBadge = () => {
  const overview = useGameOverview();
  const { appid } = useParams();
  const numericAppid = appid ? parseInt(appid, 10) : undefined;

  const { data, loading, error } = useSteamReviews(
    numericAppid == null || Number.isNaN(numericAppid) ? undefined : numericAppid
  );
  const { settings } = useSettings();
  const { position, horizontalOffset, verticalOffset } = settings;

  const allTone = useMemo(() => toneForPct(data?.all_reviews_score_pct), [data?.all_reviews_score_pct]);
  const recentTone = useMemo(
    () => toneForPct(data?.recent_reviews_score_pct),
    [data?.recent_reviews_score_pct]
  );

  const isLaunching = useIsGameLaunching(
    numericAppid == null || Number.isNaN(numericAppid) ? undefined : numericAppid
  );

  if (!numericAppid || Number.isNaN(numericAppid)) return <></>;
  if (isLaunching) return <></>;

  const renderScores = () => {
    if (loading)
      return (
        <div className="steamrev-scores">
          <div className="steamrev-score-row">
            <span className="steamrev-row-label">Loading…</span>
          </div>
        </div>
      );

    if (error)
      return (
        <div className="steamrev-scores">
          <div className="steamrev-score-row">
            <span className="steamrev-row-label">⚠️ {error}</span>
          </div>
        </div>
      );

    if (!data?.found) return null;

    const allCount = data.all_reviews_total?.toLocaleString() ?? "0";
    const recentCount = data.recent_reviews_total?.toLocaleString();

    return (
      <div className="steamrev-scores">
        {data.recent_reviews_label && recentCount ? (
          <>
            <div className="steamrev-score-row">
              <span className="steamrev-row-label">RECENT REVIEWS:</span>
              <span className="steamrev-row-value" data-tone={recentTone}>
                {data.recent_reviews_label} ({recentCount})
              </span>
            </div>
            <hr className="steamrev-divider" />
          </>
        ) : null}
        <div className="steamrev-score-row">
          <span className="steamrev-row-label">ALL REVIEWS:</span>
          <span className="steamrev-row-value" data-tone={allTone}>
            {data.all_reviews_label} ({allCount})
          </span>
        </div>
        {data.all_reviews_score_pct != null ? (
          <>
            <hr className="steamrev-divider" />
            <div className="steamrev-score-row">
              <span className="steamrev-row-label">GLOBAL SCORE:</span>
              <span className="steamrev-row-value" data-tone={allTone}>
                {formatPct(data.all_reviews_score_pct)}% ({allCount})
              </span>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div
      id="steam-reviews-badge-container"
      className="steamrev-badge-root"
      data-position={position}
      style={
        {
          "--steamrev-offset-x": `${horizontalOffset || 0}px`,
          "--steamrev-offset-y": `${verticalOffset || 0}px`,
        } as React.CSSProperties
      }
    >
      {steamReviewsStyle}
      <div className="steamrev-card">
        <div className="steamrev-card-inner">
          <div className="steamrev-steam-icon">
            <SteamLogo size={20} style={{ opacity: 0.7 }} />
          </div>
          <div style={{ flex: 1 }}>{renderScores()}</div>
        </div>
      </div>
    </div>
  );
};

// ─── Route Patch ─────────────────────────────────────────────────────────────

function patchLibraryApp() {
  return routerHook.addPatch("/library/app/:appid", (tree: any) => {
    const routeProps = findInReactTree(tree, (x: any) => x?.renderFunc);
    if (!routeProps) return tree;

    const patchHandler = createReactTreePatcher(
      [
        (root: any) =>
          findInReactTree(root, (node: any) => node?.props?.children?.props?.overview)?.props?.children,
      ],
      (_nodes: any, ret: any) => {
        const container = findInReactTree(
          ret,
          (element: any) =>
            Array.isArray(element?.props?.children) &&
            element?.props?.className?.includes(appDetailsClasses.InnerContainer)
        );
        if (!container) return ret;

        const hasBadge = container.props.children.some(
          (child: any) => child?.props?.id === "steam-reviews-badge-container"
        );
        if (!hasBadge) {
          container.props.children.splice(1, 0, <SteamReviewsBadge key="steam-reviews" />);
        }
        return ret;
      }
    );

    afterPatch(routeProps, "renderFunc", patchHandler);
    return tree;
  });
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────

export default definePlugin(() => {
  const libraryPatch = patchLibraryApp();
  const unregisterGameActionTracking = registerGameActionTracking();
  return {
    title: <div className={staticClasses.Title}>Steam Reviews</div>,
    icon: <FaStar />,
    content: <SettingsPanel />,
    onDismount() {
      routerHook.removePatch("/library/app/:appid", libraryPatch);
      unregisterGameActionTracking();
    },
  };
});
