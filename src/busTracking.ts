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

/** how an arrival should be worded: left to come, imminent, or already gone */
export type WaitState = "future" | "arriving" | "past";

export interface WaitInfo {
  state: WaitState;
  minutes: number;
}

/**
 * A stale projection must never render as "- 分鐘" or a permanent
 * "即將抵達"; anything more than a minute overdue is already gone.
 */
export const waitInfo = (etaMs: number, now = Date.now()): WaitInfo => {
  const remainingMs = etaMs - now;
  if (remainingMs < -60_000) return { state: "past", minutes: 0 };
  if (remainingMs < 60_000) return { state: "arriving", minutes: 0 };
  return { state: "future", minutes: Math.round(remainingMs / 60_000) };
};

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

export const DEFAULT_HEADWAY_MS = 6 * 60_000;

/** typical spacing between consecutive buses at a stop */
export const headwayOf = (
  points: EtaPoint[],
  fallbackMs = DEFAULT_HEADWAY_MS
): number => {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push(points[i].etaMs - points[i - 1].etaMs);
  }
  return gaps.length ? median(gaps) : fallbackMs;
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

/* ------------------------------------------------------------------ *
 * Route-wide bus track table
 *
 * Every stop only exposes the next few buses, and a congested segment can
 * hide a bus completely. Instead of following one chain forward, keep a
 * table of buses (rows) against stops (columns) and keep it alive between
 * refreshes. Rows are built from the last stop backwards, where arrival
 * order is stable, so a bus that "disappears" leaves a hole in a known row
 * instead of being confused with its neighbour.
 * ------------------------------------------------------------------ */

export interface TrackCell {
  seq: number;
  etaMs: number;
  etaStr: string;
  scheduled: boolean;
}

export interface BusTrack {
  id: number;
  cells: Map<number, TrackCell>;
}

export interface TrackTable {
  tracks: BusTrack[];
  /** observed travel time / static journey time, per segment start */
  factors: Map<number, number>;
  /** median observed segment time across the table */
  medianFactor: number;
}

export interface BuildTrackTableOptions {
  /** stops that currently have a fresh ETA list, ascending */
  seqs: number[];
  lists: Map<number, EtaPoint[]>;
  /** static journey time between two stops, from the journey profile */
  staticSegmentMs: (fromSeq: number, toSeq: number) => number | null;
  fallbackHeadwayMs?: number;
}

/** observations never associate further apart than this */
const TRACK_ASSOCIATION_CAP_MS = 45 * 60_000;
/** ETA rounding can make the next stop look slightly earlier */
const TRACK_EARLY_SLACK_MS = 60_000;
/** segments this long are checked against a minimum plausible speed */
const TRACK_LONG_SEGMENT_MS = 5 * 60_000;

/**
 * Build the bus/stop table. Buses are laid out along the columns from the
 * furthest known stop backwards, preserving order: a bus can never overtake
 * another, so each row can only claim a later column than the row before it.
 */
export const buildTrackTable = ({
  seqs,
  lists,
  staticSegmentMs,
  fallbackHeadwayMs = DEFAULT_HEADWAY_MS,
}: BuildTrackTableOptions): TrackTable => {
  const tracks: BusTrack[] = [];
  const factors = new Map<number, number>();
  const sortedSeqs = [...seqs].sort((a, b) => a - b);

  let nextId = 1;
  for (let i = sortedSeqs.length - 1; i >= 0; i--) {
    const seq = sortedSeqs[i];
    const rows = lists.get(seq) ?? [];
    if (rows.length === 0) continue;

    const nextSeq = i + 1 < sortedSeqs.length ? sortedSeqs[i + 1] : null;
    const expected =
      nextSeq != null ? staticSegmentMs(seq, nextSeq) : null;
    const headway = headwayOf(rows, fallbackHeadwayMs);
    // a bus cannot cover a long segment in a fraction of its journey time,
    // and cannot take much longer than the worst congestion we accept
    const minDeltaMs =
      expected != null && expected >= TRACK_LONG_SEGMENT_MS
        ? expected * 0.4
        : 0;
    const maxDeltaMs =
      expected != null
        ? Math.min(
            Math.max(3 * 60_000, expected * 1.8),
            TRACK_ASSOCIATION_CAP_MS
          )
        : Math.max(10 * 60_000, headway * 2);

    let cursorEtaMs = Number.NEGATIVE_INFINITY;
    const claimed = new Set<number>();

    for (const row of rows) {
      let best: BusTrack | null = null;
      let bestDiff = Number.POSITIVE_INFINITY;

      for (const track of tracks) {
        if (claimed.has(track.id)) continue;
        if (nextSeq == null) continue;
        const cell = track.cells.get(nextSeq);
        if (!cell) continue;
        if (cell.etaMs < cursorEtaMs) continue;
        const delta = cell.etaMs - row.etaMs;
        if (delta < minDeltaMs - TRACK_EARLY_SLACK_MS) continue;
        if (delta > maxDeltaMs) continue;
        const diff = Math.abs(delta - (expected ?? delta));
        if (diff < bestDiff) {
          best = track;
          bestDiff = diff;
        }
      }

      const cell: TrackCell = {
        seq,
        etaMs: row.etaMs,
        etaStr: row.etaStr,
        scheduled: row.scheduled,
      };

      if (best && nextSeq != null) {
        best.cells.set(seq, cell);
        claimed.add(best.id);
        cursorEtaMs = best.cells.get(nextSeq)!.etaMs;
      } else {
        tracks.push({ id: nextId++, cells: new Map([[seq, cell]]) });
      }
    }
  }

  // observed speed per segment; this is the "alpha" over the journey-time model
  const samples = new Map<number, number[]>();
  for (const track of tracks) {
    const stops = [...track.cells.keys()].sort((a, b) => a - b);
    for (const seq of stops) {
      const cell = track.cells.get(seq)!;
      const nextCell = track.cells.get(seq + 1);
      if (!nextCell) continue;
      const expected = staticSegmentMs(seq, seq + 1);
      if (expected == null || expected <= 0) continue;
      const observed = nextCell.etaMs - cell.etaMs;
      if (observed <= 0) continue;
      const list = samples.get(seq) ?? [];
      list.push(observed / expected);
      samples.set(seq, list);
    }
  }

  const allSamples: number[] = [];
  for (const [seq, values] of samples) {
    const factor = clamp(median(values), 1, 3);
    factors.set(seq, factor);
    allSamples.push(...values);
  }

  return {
    tracks,
    factors,
    medianFactor: allSamples.length
      ? clamp(median(allSamples), 1, 3)
      : 1,
  };
};

/** the track that owns the ETA row at `seq` (our bus, at the start) */
export const findTrackByCell = (
  table: TrackTable,
  seq: number,
  etaMs: number,
  toleranceMs = 90_000
): BusTrack | null => {
  let best: BusTrack | null = null;
  let bestDiff = toleranceMs;
  for (const track of table.tracks) {
    const cell = track.cells.get(seq);
    if (!cell) continue;
    const diff = Math.abs(cell.etaMs - etaMs);
    if (diff <= bestDiff) {
      best = track;
      bestDiff = diff;
    }
  }
  return best;
};

export interface ProjectTrackOptions {
  track: BusTrack;
  boardSeq: number;
  lastSeq: number;
  staticSegmentMs: (fromSeq: number, toSeq: number) => number | null;
  factors: Map<number, number>;
  medianFactor: number;
  now: number;
  /** cells of every other bus at a stop, used to re-acquire a hidden bus */
  otherCells?: (seq: number) => TrackCell[];
}

export interface ProjectTrackResult {
  stops: TrackedStop[];
  /** stops where another bus was adopted as ours */
  adopted: number[];
}

/**
 * Turn a row of the table into the per-stop series we display. Holes are
 * interpolated between the row's own sightings, and extrapolated with the
 * journey time scaled by the congestion factor observed on that segment.
 * When another bus appears exactly where ours is due, it is adopted so the
 * ride continues after a congested black spot.
 */
export const projectTrack = ({
  track,
  boardSeq,
  lastSeq,
  staticSegmentMs,
  factors,
  medianFactor,
  now,
  otherCells,
}: ProjectTrackOptions): ProjectTrackResult => {
  const cells = track.cells;
  const knownSeqs = [...cells.keys()].sort((a, b) => a - b);
  const adopted: number[] = [];
  if (knownSeqs.length === 0) return { stops: [], adopted };

  const factorOf = (fromSeq: number, toSeq: number): number => {
    let factor = 1;
    for (let s = fromSeq; s < toSeq; s++) {
      factor *= factors.get(s) ?? medianFactor;
    }
    return factor;
  };

  const expectedMs = (fromSeq: number, toSeq: number): number | null => {
    const base = staticSegmentMs(fromSeq, toSeq);
    if (base == null) return null;
    return base * factorOf(fromSeq, toSeq);
  };

  const result: TrackedStop[] = [];
  let prevEtaMs = Number.NEGATIVE_INFINITY;

  for (let seq = boardSeq; seq <= lastSeq; seq++) {
    const cell = cells.get(seq);
    if (cell) {
      result.push({
        seq,
        eta: cell.etaStr,
        etaMs: cell.etaMs,
        source: cell.scheduled ? "scheduled" : "realtime",
        passed: false,
        updatedAt: now,
      });
      prevEtaMs = Math.max(prevEtaMs, cell.etaMs);
      continue;
    }

    const before = [...knownSeqs].reverse().find((s) => s < seq);
    const after = knownSeqs.find((s) => s > seq);
    const stepMs =
      before != null ? expectedMs(before, seq) : null;
    let etaMs: number | null = null;

    if (before != null && after != null) {
      // interpolate between two sightings of the same bus
      const span = expectedMs(before, after);
      const part = expectedMs(before, seq);
      if (span != null && part != null && span > 0) {
        const beforeEta = cells.get(before)!.etaMs;
        const afterEta = cells.get(after)!.etaMs;
        etaMs = beforeEta + ((afterEta - beforeEta) * part) / span;
      }
    } else if (before != null && stepMs != null) {
      etaMs = cells.get(before)!.etaMs + stepMs;
    } else if (before == null && after != null) {
      const step = expectedMs(seq, after);
      if (step != null) etaMs = cells.get(after)!.etaMs - step;
    }

    // re-acquire the bus when another row lands where ours is due
    if (otherCells) {
      const reference =
        etaMs ??
        (before != null ? cells.get(before)!.etaMs + (stepMs ?? 0) : null);
      if (reference != null) {
        const tolerance = Math.max(
          2 * 60_000,
          (stepMs ?? 0) * 0.35
        );
        const lowerBound = Number.isFinite(prevEtaMs)
          ? prevEtaMs
          : Number.NEGATIVE_INFINITY;
        const candidates = otherCells(seq)
          .filter((candidate) => candidate.etaMs >= lowerBound)
          .sort(
            (a, b) =>
              Math.abs(a.etaMs - reference) - Math.abs(b.etaMs - reference)
          );
        const candidate = candidates[0];
        if (
          candidate &&
          Math.abs(candidate.etaMs - reference) <= tolerance
        ) {
          cells.set(seq, candidate);
          adopted.push(seq);
          result.push({
            seq,
            eta: candidate.etaStr,
            etaMs: candidate.etaMs,
            source: candidate.scheduled ? "scheduled" : "realtime",
            passed: false,
            updatedAt: now,
          });
          prevEtaMs = Math.max(prevEtaMs, candidate.etaMs);
          continue;
        }
      }
    }

    if (etaMs == null) break;
    if (Number.isFinite(prevEtaMs)) etaMs = Math.max(etaMs, prevEtaMs);
    result.push({
      seq,
      eta: new Date(etaMs).toISOString(),
      etaMs,
      source: "estimate",
      passed: false,
      updatedAt: now,
    });
    prevEtaMs = etaMs;
  }

  return { stops: result, adopted };
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
