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
export const ESTIMATE_PASS_GRACE_MS = 5 * 60_000;

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

interface WeightedSample {
  ratio: number;
  weight: number;
}

/** median where each sample can carry a weight (used for diluted samples) */
const weightedMedian = (samples: WeightedSample[]): number => {
  if (samples.length === 0) return 1;
  const sorted = [...samples].sort((a, b) => a.ratio - b.ratio);
  const total = sorted.reduce((acc, sample) => acc + sample.weight, 0);
  if (!(total > 0)) return sorted[sorted.length >> 1].ratio;

  const half = total / 2;
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    const before = running;
    running += sorted[i].weight;
    if (running < half) continue;
    // a tie straddling the midpoint is averaged, exactly like an even-count median
    const next = sorted[i + 1];
    if (next && before < half && running === half) {
      return (sorted[i].ratio + next.ratio) / 2;
    }
    return sorted[i].ratio;
  }
  return sorted[sorted.length - 1].ratio;
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
  // a NaN can leak in from a failed segment fetch; treat it as unknown
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) * 60_000);
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
  /**
   * false when the value came from our own projection rather than from the
   * operator. Only real cells may be used to learn congestion, otherwise the
   * estimate would be fed back into itself.
   */
  real: boolean;
}

export interface BusTrack {
  id: number;
  cells: Map<number, TrackCell>;
}

export interface TrackTable {
  tracks: BusTrack[];
  /** median observed travel time / journey time across the fleet */
  alpha: number;
  /** congestion ratio per segment (keyed by the segment's from-stop) */
  segmentAlphas: Map<number, number>;
  /** segments that produced a measurement this cycle */
  freshSegments: Set<number>;
}

export interface BuildTrackTableOptions {
  /** stops that currently have a fresh ETA list, ascending */
  seqs: number[];
  lists: Map<number, EtaPoint[]>;
  /** static journey time between two stops, from the journey profile */
  staticSegmentMs: (fromSeq: number, toSeq: number) => number | null;
  /** congestion ratios kept from the previous cycle, for smoothing */
  previousAlphas?: Map<number, number>;
  /** weight given to this cycle's measurement when smoothing */
  alphaWeight?: number;
}

/**
 * A bus cannot beat free flow, but both the ETA and the journey time are
 * minute-quantised and the model is a statistical estimate, so anything within
 * this window of the journey time is still the same bus.
 */
const JOURNEY_FLOOR_SLACK_MS = 2 * 60_000;

/**
 * Build the bus/stop table.
 *
 * Buses are laid out along the columns from the furthest known stop backwards,
 * preserving order: a bus can never overtake another, so each row can only
 * claim a later column than the row before it.
 *
 * A row is only extended when the implied travel time is at least the journey
 * time of that segment. Congestion can only make a bus slower than free flow,
 * never faster, so a candidate quicker than `staticSegmentMs` belongs to a
 * different bus - this is what stops a leading bus from stealing our row.
 * When the journey time of a segment is unknown, that segment is left alone:
 * nothing is associated there and the bus is estimated instead.
 */
export const buildTrackTable = ({
  seqs,
  lists,
  staticSegmentMs,
  previousAlphas,
  alphaWeight = 0.3,
}: BuildTrackTableOptions): TrackTable => {
  const tracks: BusTrack[] = [];
  const sortedSeqs = [...seqs].sort((a, b) => a - b);

  let nextId = 1;
  for (let i = sortedSeqs.length - 1; i >= 0; i--) {
    const seq = sortedSeqs[i];
    const rows = lists.get(seq) ?? [];
    if (rows.length === 0) continue;

    const nextSeq = i + 1 < sortedSeqs.length ? sortedSeqs[i + 1] : null;
    const journeyMs = nextSeq != null ? staticSegmentMs(seq, nextSeq) : null;

    let cursorEtaMs = Number.NEGATIVE_INFINITY;
    const claimed = new Set<number>();
    // the same bus may be late, but not by a whole extra headway; without a
    // ceiling the next departure is attached to our row the moment our own
    // bus leaves the stop, which made the trip run forever. Short segments get
    // at least 6 extra minutes because their congestion ratio is noisier.
    const maxDeltaMs =
      journeyMs != null
        ? journeyMs + Math.max(6 * 60_000, journeyMs)
        : null;

    for (const row of rows) {
      const cell: TrackCell = {
        seq,
        etaMs: row.etaMs,
        etaStr: row.etaStr,
        scheduled: row.scheduled,
        real: true,
      };

      let best: BusTrack | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;

      if (nextSeq != null && journeyMs != null) {
        for (const track of tracks) {
          if (claimed.has(track.id)) continue;
          const nextCell = track.cells.get(nextSeq);
          if (!nextCell) continue;
          if (nextCell.etaMs < cursorEtaMs) continue;
          const delta = nextCell.etaMs - row.etaMs;
          if (delta < journeyMs - JOURNEY_FLOOR_SLACK_MS) continue;
          if (maxDeltaMs != null && delta > maxDeltaMs) continue;
          // the least delayed bus that is still physically possible is ours
          if (delta < bestDelta) {
            best = track;
            bestDelta = delta;
          }
        }
      }

      if (best && nextSeq != null) {
        best.cells.set(seq, cell);
        claimed.add(best.id);
        cursorEtaMs = best.cells.get(nextSeq)!.etaMs;
      } else {
        tracks.push({ id: nextId++, cells: new Map([[seq, cell]]) });
      }
    }
  }

  // congestion is measured per segment from real ETAs: two cells in the same
  // row are one bus's observed travel across that stretch of road
  const strictSamples = new Map<number, number[]>();
  const dilutedSamples = new Map<number, WeightedSample[]>();
  const allRatios: number[] = [];
  const addStrict = (seq: number, ratio: number) => {
    const list = strictSamples.get(seq);
    if (list) list.push(ratio);
    else strictSamples.set(seq, [ratio]);
  };
  const addDiluted = (seq: number, sample: WeightedSample) => {
    const list = dilutedSamples.get(seq);
    if (list) list.push(sample);
    else dilutedSamples.set(seq, [sample]);
  };

  for (const track of tracks) {
    const known = [...track.cells.keys()].sort((a, b) => a - b);
    for (let i = 1; i < known.length; i++) {
      const from = known[i - 1];
      const to = known[i];
      const a = track.cells.get(from)!;
      const b = track.cells.get(to)!;
      // timetabled ETAs say nothing about traffic, and our own projections
      // must never feed back into the ratio
      if (!a.real || !b.real || a.scheduled || b.scheduled) continue;
      const spanMs = staticSegmentMs(from, to);
      if (spanMs == null || spanMs <= 0) continue;
      const observed = b.etaMs - a.etaMs;
      if (!Number.isFinite(observed) || observed <= 0) continue;

      const ratio = observed / spanMs;
      allRatios.push(ratio);

      if (to === from + 1) {
        addStrict(from, ratio);
      } else {
        // only the average over several segments is known; credit it to each
        // of them in proportion to their share of the span
        for (let s = from; s < to; s++) {
          const segMs = staticSegmentMs(s, s + 1);
          if (segMs == null || segMs <= 0) continue;
          addDiluted(s, { ratio, weight: segMs / spanMs });
        }
      }
    }
  }

  const alpha = allRatios.length ? clamp(median(allRatios), 1, 2) : 1;

  const segmentAlphas = new Map<number, number>();
  const freshSegments = new Set<number>();
  const measuredSeqs = new Set([
    ...strictSamples.keys(),
    ...dilutedSamples.keys(),
  ]);

  for (const seq of measuredSeqs) {
    const strict = strictSamples.get(seq) ?? [];
    let value: number;
    if (strict.length >= 2) {
      // two independent observations are enough to trust the segment
      value = median(strict);
    } else {
      const merged: WeightedSample[] = [
        ...strict.map<WeightedSample>((ratio) => ({ ratio, weight: 1 })),
        ...(dilutedSamples.get(seq) ?? []),
      ];
      if (merged.length === 0) continue;
      value = weightedMedian(merged);
    }
    segmentAlphas.set(seq, clamp(value, 1, 2));
    freshSegments.add(seq);
  }

  // smooth against the previous cycle; a single refresh is too short to
  // rewrite what we know about the road, and the sample set rotates as the
  // polling window moves
  for (const [seq, value] of segmentAlphas) {
    const previous = previousAlphas?.get(seq);
    if (previous == null) continue;
    segmentAlphas.set(
      seq,
      clamp(previous * (1 - alphaWeight) + value * alphaWeight, 1, 2)
    );
  }
  // keep segments that produced nothing this cycle, so a stop leaving the
  // window does not instantly fall back to the fleet average
  if (previousAlphas) {
    for (const [seq, previous] of previousAlphas) {
      if (!segmentAlphas.has(seq)) segmentAlphas.set(seq, previous);
    }
  }

  return { tracks, alpha, segmentAlphas, freshSegments };
};

/**
 * Our bus is identified by the ETA the user tapped. That cell is pinned at the
 * boarding stop on every rebuild, so the row holding it is always our row -
 * never a row that merely happens to be near a later sighting.
 */
export const findTrackByAnchor = (
  table: TrackTable,
  boardSeq: number,
  anchorMs: number,
  toleranceMs = 60_000
): BusTrack | null => {
  let best: BusTrack | null = null;
  let bestDiff = toleranceMs;
  for (const track of table.tracks) {
    const cell = track.cells.get(boardSeq);
    if (!cell) continue;
    const diff = Math.abs(cell.etaMs - anchorMs);
    if (diff < bestDiff || (diff === bestDiff && best && track.cells.size > best.cells.size)) {
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
  /** the pinned ETA of the tracked bus at the boarding stop */
  boardCell: TrackCell;
  staticSegmentMs: (fromSeq: number, toSeq: number) => number | null;
  /** congestion ratio per segment, measured from the table */
  segmentAlphas: Map<number, number>;
  /** fleet-wide fallback for segments with no measurement */
  alpha: number;
  now: number;
  /** cells of every other bus at a stop, used to re-acquire our bus */
  candidatesAt: (seq: number) => TrackCell[];
}

export interface ProjectTrackResult {
  stops: TrackedStop[];
  /** stops where a cell of another row was confirmed as ours */
  adopted: number[];
}

/**
 * Turn a row of the table into the per-stop series we display.
 *
 * The row is walked forward from the pinned boarding cell. A stop with a cell
 * of our own is published as observed. A hole is filled with another row's
 * cell only when that cell is at least one free-flow journey time after the
 * last confirmed position, so it can never be a bus running ahead of ours.
 * Everything else is estimated with the journey time scaled once by the
 * congestion ratio: applying a per-segment factor cumulatively would inflate
 * every hop and drift away from reality within a few stops.
 */
export const projectTrack = ({
  track,
  boardSeq,
  lastSeq,
  boardCell,
  staticSegmentMs,
  segmentAlphas,
  alpha,
  now,
  candidatesAt,
}: ProjectTrackOptions): ProjectTrackResult => {
  const adopted: number[] = [];
  const result: TrackedStop[] = [];

  // our own bus knows its segments best, when it has been seen on them
  const ownAlphas = new Map<number, number>();
  const ownSeqs = [...track.cells.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ownSeqs.length; i++) {
    const from = ownSeqs[i - 1];
    const to = ownSeqs[i];
    if (to !== from + 1) continue;
    const a = track.cells.get(from)!;
    const b = track.cells.get(to)!;
    if (!a.real || !b.real || a.scheduled || b.scheduled) continue;
    const jt = staticSegmentMs(from, to);
    if (jt == null || jt <= 0) continue;
    const observed = b.etaMs - a.etaMs;
    if (!Number.isFinite(observed) || observed <= 0) continue;
    ownAlphas.set(from, clamp(observed / jt, 1, 2));
  }

  const alphaOf = (seq: number): number =>
    ownAlphas.get(seq) ?? segmentAlphas.get(seq) ?? alpha;

  const makeObserved = (seq: number, cell: TrackCell): TrackedStop => ({
    seq,
    eta: cell.etaStr,
    etaMs: cell.etaMs,
    // a remembered projection keeps saying so instead of looking like live data
    source: !cell.real
      ? "estimate"
      : cell.scheduled
      ? "scheduled"
      : "realtime",
    passed: false,
    updatedAt: now,
  });

  // last stop with real evidence, and the last value we published
  let anchorSeq = boardSeq;
  let anchorEtaMs = boardCell.etaMs;
  let publishedEtaMs = boardCell.etaMs;
  if (!Number.isFinite(publishedEtaMs)) return { stops: [], adopted };

  // running totals from the current anchor, so the span to each stop is a sum
  // of per-segment journey times - never a product of congestion factors
  let cursorSeq = anchorSeq;
  let spanJtMs = 0;
  let spanTravelMs = 0;
  const resetSpan = (seq: number) => {
    cursorSeq = seq;
    spanJtMs = 0;
    spanTravelMs = 0;
  };
  const spanTo = (seq: number): { jtMs: number; travelMs: number } | null => {
    for (let s = cursorSeq; s < seq; s++) {
      const jt = staticSegmentMs(s, s + 1);
      if (jt == null || !Number.isFinite(jt)) return null;
      spanJtMs += jt;
      spanTravelMs += jt * alphaOf(s);
    }
    cursorSeq = Math.max(cursorSeq, seq);
    return { jtMs: spanJtMs, travelMs: spanTravelMs };
  };

  track.cells.set(boardSeq, boardCell);
  result.push(makeObserved(boardSeq, boardCell));

  for (let seq = boardSeq + 1; seq <= lastSeq; seq++) {
    const span = spanTo(seq);
    if (!span) break;
    const freeFlowMs = span.jtMs;

    const own = track.cells.get(seq);
    if (own && own.etaMs >= publishedEtaMs) {
      result.push(makeObserved(seq, own));
      anchorSeq = seq;
      anchorEtaMs = own.etaMs;
      publishedEtaMs = own.etaMs;
      resetSpan(seq);
      continue;
    }

    // a bus cannot beat free flow by more than the rounding slack, and it
    // cannot arrive before the stop we have already published
    const floorMs = Math.max(
      publishedEtaMs,
      anchorEtaMs + freeFlowMs - JOURNEY_FLOOR_SLACK_MS
    );
    const estimatedMs = Math.max(
      publishedEtaMs,
      anchorEtaMs + span.travelMs
    );
    // an unbounded floor would let the *next* bus at this stop be taken for
    // ours once ours has left, which made the trip run forever; stay within a
    // delay allowance of our own projection instead
    const delayAllowanceMs = clamp(
      freeFlowMs * 0.5,
      3 * 60_000,
      10 * 60_000
    );
    const ceilingMs = estimatedMs + delayAllowanceMs;

    const reacquired = candidatesAt(seq)
      .filter((cell) => cell.etaMs >= floorMs && cell.etaMs <= ceilingMs)
      .sort((a, b) => a.etaMs - b.etaMs)[0];

    if (reacquired) {
      track.cells.set(seq, reacquired);
      adopted.push(seq);
      result.push(makeObserved(seq, reacquired));
      anchorSeq = seq;
      anchorEtaMs = reacquired.etaMs;
      publishedEtaMs = reacquired.etaMs;
      resetSpan(seq);
      continue;
    }

    if (!Number.isFinite(estimatedMs)) break;
    result.push({
      seq,
      eta: new Date(estimatedMs).toISOString(),
      etaMs: estimatedMs,
      source: "estimate",
      passed: false,
      updatedAt: now,
    });
    publishedEtaMs = estimatedMs;
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
      // a failed segment fetch can resolve to NaN/Infinity; a single bad hop
      // must not poison the whole cumulative profile
      running += Number.isFinite(value) && value > 0
        ? value
        : FALLBACK_SEGMENT_MINUTES;
      profile.push(running);
    }
    seq += batch.length;
    onChunk?.(profile.slice());
  }

  journeyProfileCache.set(cacheKey, { profile: profile.slice(), ts: Date.now() });
  return profile;
};
