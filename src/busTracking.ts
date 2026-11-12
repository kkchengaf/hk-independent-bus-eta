import { fetchEstJourneyTime } from "hk-bus-eta";
import type { Company, Eta, RouteListEntry, StopList } from "hk-bus-eta";

export type LocalizedText = { zh: string; en: string };
export type TrackedEtaSource = "realtime" | "scheduled";
export type TrackedStopSource = TrackedEtaSource | "estimate";

/** storage key of the persisted active trip */
export const TRACKING_STORAGE_KEY = "busTracking";
/** storage key of the last known terminus arrival, used to auto-untrack later */
export const TRACKING_PROGRESS_KEY = "busTrackingProgress";
/** how long after the terminus arrival a trip is considered over */
export const TRACKING_COMPLETE_GRACE_MS = 5 * 60_000;

export interface TrackingProgress {
  startedAt: number;
  terminusEtaMs: number | null;
}

export interface TrackedTrip {
  v: 1;
  routeKey: string;
  co: Company;
  dest: LocalizedText;
  /** stop sequence where the user tapped 追蹤班次 */
  boardSeq: number;
  /** ISO time of the tapped ETA — also used as the trip label */
  anchorEta: string;
  anchorSource: TrackedEtaSource;
  startedAt: number;
}

export interface TrackedStop {
  seq: number;
  eta: string;
  etaMs: number;
  source: TrackedStopSource;
  passed: boolean;
  updatedAt: number;
}

export interface EtaPoint {
  etaMs: number;
  etaStr: string;
  scheduled: boolean;
  co: Company;
  dest: LocalizedText;
}

export interface EtaMatch {
  prevIdx: number;
  currIdx: number;
  segmentMs: number;
}

/** companies supported by fetchEstJourneyTime and with usable trip-level ETAs */
export const TRACKABLE_COMPANIES: Company[] = [
  "kmb",
  "ctb",
  "nlb",
  "lrtfeeder",
  "gmb",
];

/** two eta rows within this window are treated as the same bus */
export const SAME_TRIP_TOLERANCE_MS = 90_000;
/** estimates can drift further, so allow a wider window when matching rows */
export const ESTIMATE_MATCH_TOLERANCE_MS = 3 * 60_000;
/** an observed arrival leaving this long ago is treated as passed */
export const PASS_GRACE_MS = 2 * 60_000;
/** an estimated arrival must be this stale before it is treated as passed */
export const ESTIMATE_PASS_GRACE_MS = 10 * 60_000;

const MATCH_TOLERANCE_MIN_MS = 2 * 60_000;
const MATCH_TOLERANCE_MAX_MS = 6 * 60_000;
const MAX_JT_SEGMENTS = 80;
const JT_CACHE_TTL_MS = 30 * 60_000;
const JT_CONCURRENCY = 6;
const FALLBACK_SEGMENT_MINUTES = 4;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const formatHkTime = (etaMs: number): string =>
  new Date(etaMs + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);

export const formatHkTimestamp = (ms: number): string =>
  new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(11, 19);

export const waitMinutes = (etaMs: number, now = Date.now()): number =>
  Math.max(0, Math.round((etaMs - now) / 60_000));

export const isScheduledRemark = (remark: Eta["remark"]): boolean =>
  !!remark && (remark.zh?.endsWith("班次") || remark.en?.endsWith("Scheduled Bus"));

const normalize = (value?: string) =>
  (value ?? "").replace(/\s+/g, "").toLowerCase();

export const isSameDestination = (
  a: LocalizedText,
  b: LocalizedText
): boolean =>
  normalize(a.zh) === normalize(b.zh) || normalize(a.en) === normalize(b.en);

/**
 * Convert a stop's ETA list into sorted points that belong to the tracked
 * company/destination. Falls back to a looser filter when the strict one
 * yields nothing, so buggy destination labels do not break tracking.
 */
export const buildEtaPoints = (
  etas: Eta[],
  co: Company,
  dest: LocalizedText,
  now: number
): EtaPoint[] => {
  const points: EtaPoint[] = [];
  for (const eta of etas) {
    if (!eta.eta) continue;
    const etaMs = Date.parse(eta.eta);
    if (!Number.isFinite(etaMs) || etaMs < now - PASS_GRACE_MS) continue;
    points.push({
      etaMs,
      etaStr: eta.eta,
      scheduled: isScheduledRemark(eta.remark),
      co: eta.co,
      dest: eta.dest ?? { zh: "", en: "" },
    });
  }

  const sameCo = points.filter((point) => point.co === co);
  const pool = sameCo.length ? sameCo : points;
  const sameDest = pool.filter((point) => isSameDestination(point.dest, dest));
  const chosen = sameDest.length ? sameDest : pool;
  return chosen.sort((a, b) => a.etaMs - b.etaMs);
};

export const findClosestIndex = (
  points: EtaPoint[],
  targetMs: number,
  toleranceMs: number
): number => {
  let best = -1;
  let bestDiff = toleranceMs;
  points.forEach((point, idx) => {
    const diff = Math.abs(point.etaMs - targetMs);
    if (diff <= bestDiff) {
      best = idx;
      bestDiff = diff;
    }
  });
  return best;
};

export const matchToleranceMs = (
  points: EtaPoint[],
  expectedSegmentMs: number | null
): number => {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push(points[i].etaMs - points[i - 1].etaMs);
  }
  const headway = gaps.length
    ? median(gaps)
    : (expectedSegmentMs ?? 8 * 60_000) * 2;
  return clamp(
    headway / 2,
    MATCH_TOLERANCE_MIN_MS,
    MATCH_TOLERANCE_MAX_MS
  );
};

/**
 * Match the ETA list of the current stop against the previous stop's list.
 * Holds the trip order (no overtaking) and allows trips to appear at the
 * front (already passed the previous stop) or drop out of the top 3.
 */
export const alignEtas = (
  prev: EtaPoint[],
  curr: EtaPoint[],
  expectedSegmentMs: number,
  toleranceMs: number
): EtaMatch[] => {
  const used = new Set<number>();
  const matches: EtaMatch[] = [];

  for (let currIdx = 0; currIdx < curr.length; currIdx++) {
    let bestIdx = -1;
    let bestDiff = toleranceMs;
    for (let prevIdx = 0; prevIdx < prev.length; prevIdx++) {
      if (used.has(prevIdx)) continue;
      const diff = Math.abs(
        curr[currIdx].etaMs - (prev[prevIdx].etaMs + expectedSegmentMs)
      );
      if (diff <= bestDiff) {
        bestIdx = prevIdx;
        bestDiff = diff;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      matches.push({
        prevIdx: bestIdx,
        currIdx,
        segmentMs: curr[currIdx].etaMs - prev[bestIdx].etaMs,
      });
    }
  }

  return matches;
};

/**
 * Segment time of the bus immediately ahead of ours (the bus that was
 * closest before our predicted arrival at the previous stop). Falls back to
 * the closest matched bus behind ours, then null.
 */
export const pickReferenceSegment = (
  matches: EtaMatch[],
  prev: EtaPoint[],
  ourPrevEtaMs: number
): number | null => {
  let ahead: { etaMs: number; segmentMs: number } | null = null;
  let behind: { etaMs: number; segmentMs: number } | null = null;

  for (const match of matches) {
    const prevEtaMs = prev[match.prevIdx].etaMs;
    if (!Number.isFinite(match.segmentMs) || match.segmentMs <= 0) continue;
    if (prevEtaMs <= ourPrevEtaMs + 30_000) {
      if (!ahead || prevEtaMs > ahead.etaMs) {
        ahead = { etaMs: prevEtaMs, segmentMs: match.segmentMs };
      }
    } else if (!behind || prevEtaMs < behind.etaMs) {
      behind = { etaMs: prevEtaMs, segmentMs: match.segmentMs };
    }
  }

  return (ahead ?? behind)?.segmentMs ?? null;
};

export const clampSegmentMs = (
  segmentMs: number,
  expectedSegmentMs: number | null
): number =>
  expectedSegmentMs != null && expectedSegmentMs > 0
    ? clamp(segmentMs, expectedSegmentMs * 0.45, expectedSegmentMs * 2)
    : Math.max(0, segmentMs);

export const nextArrivalMs = (
  prevEtaMs: number,
  expectedSegmentMs: number | null,
  referenceSegmentMs: number | null
): number | null => {
  if (referenceSegmentMs != null) {
    return prevEtaMs + clampSegmentMs(referenceSegmentMs, expectedSegmentMs);
  }
  if (expectedSegmentMs != null) return prevEtaMs + expectedSegmentMs;
  return null;
};

/** cumulative journey-time profile (minutes) from `startSeq`, indexed by offset */
export const journeySegmentMs = (
  profile: number[] | null,
  startSeq: number,
  fromSeq: number,
  toSeq: number
): number | null => {
  if (!profile || toSeq <= fromSeq) return null;
  const from = profile[fromSeq - startSeq];
  const to = profile[toSeq - startSeq];
  if (from == null || to == null) return null;
  return Math.max(0, (to - from) * 60_000);
};

/** best guess of the stop the bus is at, based on elapsed time and the profile */
export const estimateProgressSeq = (
  profile: number[] | null,
  startSeq: number,
  elapsedMs: number
): number => {
  if (!profile || profile.length === 0) return startSeq;
  const elapsedMinutes = elapsedMs / 60_000;
  let seq = startSeq;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] <= elapsedMinutes) seq = startSeq + i;
  }
  return seq;
};

export const canTrackRoute = (
  route: RouteListEntry | undefined,
  co: Company
): boolean => {
  if (!route || !TRACKABLE_COMPANIES.includes(co)) return false;
  const stopIds = Object.values(route.stops)[0];
  if (!stopIds || stopIds.length < 2) return false;
  const firstCo = Object.keys(route.stops)[0] as Company | undefined;
  return !!firstCo && TRACKABLE_COMPANIES.includes(firstCo);
};

/** the last stop has nowhere further to track to */
export const canTrackStop = (
  route: RouteListEntry | undefined,
  co: Company,
  seq: number
): boolean => {
  if (!route || !canTrackRoute(route, co)) return false;
  const stopIds = Object.values(route.stops)[0] ?? [];
  return seq >= 0 && seq < stopIds.length - 1;
};

export interface LoadJourneyProfileOptions {
  routeId: string;
  route: RouteListEntry;
  stopList: StopList;
  holidays?: string[];
  startSeq: number;
  signal?: AbortSignal | null;
  onChunk?: (profile: number[]) => void;
  maxSegments?: number;
}

const journeyProfileCache = new Map<
  string,
  { profile: number[]; ts: number }
>();

/**
 * Cumulative journey time from `startSeq` to each following stop, built with
 * the same fetchEstJourneyTime call JourneyTimePanel uses. Results are cached
 * for a while because the profile only changes slowly during a ride.
 */
export const loadJourneyProfile = async ({
  routeId,
  route,
  stopList,
  holidays,
  startSeq,
  signal,
  onChunk,
  maxSegments = MAX_JT_SEGMENTS,
}: LoadJourneyProfileOptions): Promise<number[]> => {
  const cacheKey = `${routeId}|${startSeq}|${maxSegments}|${new Date().toDateString()}`;
  const cached = journeyProfileCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < JT_CACHE_TTL_MS) {
    onChunk?.(cached.profile);
    return cached.profile;
  }

  const stopIds = Object.values(route.stops)[0] ?? [];
  const endSeq = Math.min(stopIds.length - 1, startSeq + maxSegments);
  const profile = [0];
  let running = 0;
  let seq = startSeq;

  while (seq < endSeq) {
    if (signal?.aborted) throw new Error("journey profile aborted");

    const batch: number[] = [];
    while (batch.length < JT_CONCURRENCY && seq + batch.length < endSeq) {
      batch.push(seq + batch.length);
    }

    const minutes = await Promise.all(
      batch.map((fromSeq) =>
        fetchEstJourneyTime({
          route,
          stopList,
          holidays,
          startSeq: fromSeq,
          endSeq: fromSeq + 1,
          signal,
        }).catch(() => FALLBACK_SEGMENT_MINUTES)
      )
    );

    if (signal?.aborted) throw new Error("journey profile aborted");

    for (const value of minutes) {
      running += value;
      profile.push(running);
    }
    seq += batch.length;
    onChunk?.(profile.slice());
  }

  journeyProfileCache.set(cacheKey, { profile: profile.slice(), ts: Date.now() });
  return profile;
};
