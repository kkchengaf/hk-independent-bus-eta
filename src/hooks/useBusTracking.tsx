import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { fetchEtas } from "hk-bus-eta";
import type { Eta } from "hk-bus-eta";
import AppContext from "../context/AppContext";
import DbContext from "../context/DbContext";
import useLanguage from "./useTranslation";
import {
  ESTIMATE_PASS_GRACE_MS,
  PASS_GRACE_MS,
  TRACKING_PROGRESS_KEY,
  buildEtaPoints,
  buildTrackTable,
  findTrackByAnchor,
  journeySegmentMs,
  loadJourneyProfile,
  projectTrack,
} from "../busTracking";
import type {
  BusTrack,
  EtaPoint,
  TrackCell,
  TrackedStop,
  TrackedTrip,
  TrackingProgress,
} from "../busTracking";

/** polling window sizes; widens while a refresh finds nothing new */
const WINDOW_STEPS = [3, 5, 8];
const MAX_CACHED_LISTS = 80;
const MIN_LIST_TTL_MS = 15_000;
const BASE_PROFILE_LIMIT = 30;
const PROFILE_STEP = 20;
const MAX_PROFILE_LIMIT = 90;
const PROFILE_AHEAD_THRESHOLD = 10;
/** cached ETA lists older than this are not used to build the table */
const LISTS_MAX_AGE_MS = 3 * 60_000;
/** the pinned boarding cell may coincide with an operator row this closely */
const ANCHOR_MATCH_MS = 60_000;
/** weight of this cycle's congestion measurement when smoothing */
const ALPHA_WEIGHT = 0.3;
/** a segment congestion factor is forgotten when it stops being measured */
const ALPHA_TTL_MS = 30 * 60_000;

export interface BusTrackingResult {
  stops: Record<number, TrackedStop>;
  nextSeq: number | null;
  isRefreshing: boolean;
  lastUpdatedAt: number | null;
  isComplete: boolean;
  /** feed an ETA list that a stop view already fetched into the tracker */
  reportEtas: (routeKey: string, seq: number, etas: Eta[]) => void;
}

/**
 * Polls the ETA of the stops around the tracked bus and chains its arrival
 * times down the route. When the bus drops out of the operator's top 3 at a
 * stop, the segment time of the bus immediately ahead is used instead.
 */
export const useBusTracking = (trip: TrackedTrip | null): BusTrackingResult => {
  const {
    db: { routeList, stopList, holidays, serviceDayMap },
  } = useContext(DbContext);
  const { isVisible, refreshInterval } = useContext(AppContext);
  const language = useLanguage();

  const [stops, setStops] = useState<Record<number, TrackedStop>>({});
  const [nextSeq, setNextSeq] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [profileLimit, setProfileLimit] = useState(BASE_PROFILE_LIMIT);

  const listsRef = useRef(new Map<number, { points: EtaPoint[]; ts: number }>());
  const listSignaturesRef = useRef(new Map<number, string>());
  const arrivalsRef = useRef(new Map<number, TrackedStop>());
  /**
   * Arrivals the bus has actually reached. The operator stops listing a stop
   * once the bus leaves it, so without this the rebuilt row loses the fact
   * that our bus was there and re-adopts whichever bus comes next.
   */
  const settledRef = useRef(new Map<number, TrackCell>());
  /** per-segment congestion ratios, smoothed across refresh cycles */
  const alphasRef = useRef(new Map<number, { value: number; ts: number }>());
  /** stops where our bus has been really seen, for window widening */
  const seenSeqsRef = useRef(new Set<number>());
  const windowStepRef = useRef(0);
  const profileRef = useRef<number[] | null>(null);
  const progressWrittenAtRef = useRef(0);
  const progressTerminusRef = useRef<number | null>(null);
  const cycleRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const recomputeRef = useRef<() => number>(() => 0);

  const tripKey = trip
    ? `${trip.routeKey}|${trip.boardSeq}|${trip.startedAt}`
    : "";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    listsRef.current = new Map();
    listSignaturesRef.current = new Map();
    arrivalsRef.current = new Map();
    settledRef.current = new Map();
    alphasRef.current = new Map();
    seenSeqsRef.current = new Set();
    windowStepRef.current = 0;
    profileRef.current = null;
    progressWrittenAtRef.current = 0;
    progressTerminusRef.current = null;
    cycleRef.current = 0;
    if (!tripKey) {
      try {
        localStorage.removeItem(TRACKING_PROGRESS_KEY);
      } catch {
        // ignore unavailable storage
      }
    }
    setProfileLimit(BASE_PROFILE_LIMIT);
    setStops({});
    setNextSeq(null);
    setLastUpdatedAt(null);
    setIsComplete(false);
  }, [tripKey]);

  const recompute = useCallback((): number => {
    if (!trip) return 0;
    const route = routeList[trip.routeKey];
    if (!route) return 0;

    const stopIds = Object.values(route.stops)[0] ?? [];
    const lastSeq = stopIds.length - 1;
    const boardSeq = trip.boardSeq;
    const anchorMs = Date.parse(trip.anchorEta);
    const now = Date.now();
    if (!Number.isFinite(anchorMs) || lastSeq <= boardSeq) return 0;

    const staticSegmentMs = (fromSeq: number, toSeq: number) =>
      journeySegmentMs(profileRef.current, boardSeq, fromSeq, toSeq);

    // The boarding stop is pinned to the tapped ETA for the whole trip: our
    // row is defined by it, so no later sighting can turn it into another bus
    // that has already passed this stop.
    const boardCell: TrackCell = {
      seq: boardSeq,
      etaMs: anchorMs,
      etaStr: trip.anchorEta,
      scheduled: trip.anchorSource === "scheduled",
      real: true,
    };

    // 1. Build the bus/stop table from the lists we hold. The pinned boarding
    //    cell is injected so our row exists even after the operator drops that
    //    departure from its list.
    const lists = new Map<number, EtaPoint[]>();
    for (const [seq, cached] of listsRef.current) {
      if (now - cached.ts <= LISTS_MAX_AGE_MS) lists.set(seq, cached.points);
    }
    const boardPoints = lists.get(boardSeq) ?? [];
    if (
      !boardPoints.some(
        (point) => Math.abs(point.etaMs - anchorMs) <= ANCHOR_MATCH_MS
      )
    ) {
      const anchorPoint: EtaPoint = {
        etaMs: anchorMs,
        etaStr: trip.anchorEta,
        scheduled: trip.anchorSource === "scheduled",
        co: trip.co,
        dest: trip.dest,
      };
      lists.set(
        boardSeq,
        [...boardPoints, anchorPoint].sort((a, b) => a.etaMs - b.etaMs)
      );
    }

    const previousAlphas = new Map<number, number>();
    for (const [seq, record] of alphasRef.current) {
      if (now - record.ts <= ALPHA_TTL_MS) previousAlphas.set(seq, record.value);
    }

    const table = buildTrackTable({
      seqs: [...lists.keys()],
      lists,
      staticSegmentMs,
      previousAlphas,
      alphaWeight: ALPHA_WEIGHT,
    });

    // remember this cycle's measurements; segments that were not re-measured
    // keep their older timestamp and expire on their own
    for (const seq of table.freshSegments) {
      const value = table.segmentAlphas.get(seq);
      if (value != null) alphasRef.current.set(seq, { value, ts: now });
    }

    // 2. Our row is the one holding that pinned cell. Arrivals the bus has
    //    already reached are re-attached: the operator drops a stop's ETA once
    //    the bus leaves it, and losing that would let the next bus be taken
    //    for ours.
    const track: BusTrack = findTrackByAnchor(table, boardSeq, anchorMs) ?? {
      id: -1,
      cells: new Map([[boardSeq, boardCell]]),
    };
    settledRef.current.forEach((cell, seq) => {
      if (seq !== boardSeq) track.cells.set(seq, cell);
    });

    // 3. Walk the row forward. Holes are estimated; a cell of another row is
    //    adopted only when it cannot be a bus running ahead of ours.
    const { stops: projected } = projectTrack({
      track,
      boardSeq,
      lastSeq,
      boardCell,
      staticSegmentMs,
      segmentAlphas: table.segmentAlphas,
      alpha: table.alpha,
      now,
      candidatesAt: (seq) =>
        table.tracks
          .filter((candidate) => candidate !== track)
          .map((candidate) => candidate.cells.get(seq))
          .filter((cell): cell is TrackCell => !!cell),
    });
    const arrivals = new Map<number, TrackedStop>();
    for (const stop of projected) arrivals.set(stop.seq, stop);

    // 4. Count stops where the bus was really seen, so the polling window can
    //    widen when a refresh found nothing new.
    const observedSeqs = projected
      .filter((stop) => stop.source !== "estimate")
      .map((stop) => stop.seq);
    let added = 0;
    for (const seq of observedSeqs) {
      if (seenSeqsRef.current.has(seq)) continue;
      seenSeqsRef.current.add(seq);
      added += 1;
    }
    for (const stop of arrivals.values()) {
      if (stop.source === "estimate") {
        // projections are built from real sightings, so an overdue one has
        // almost certainly happened; keeping it "upcoming" would leave the
        // countdown stuck at zero and show 即將抵達 on a stop we already left
        const confirmedLater =
          stop.seq === lastSeq || observedSeqs.some((seq) => seq > stop.seq);
        stop.passed =
          stop.etaMs < now - ESTIMATE_PASS_GRACE_MS ||
          (confirmedLater && stop.etaMs < now - PASS_GRACE_MS);
      } else {
        stop.passed = stop.etaMs < now - PASS_GRACE_MS;
      }
      // once the bus has reached a stop, remember it: the operator will drop
      // that ETA from its list and the next rebuild must not forget it
      if (stop.passed) {
        settledRef.current.set(stop.seq, {
          seq: stop.seq,
          etaMs: stop.etaMs,
          etaStr: stop.eta,
          scheduled: stop.source === "scheduled",
          real: stop.source !== "estimate",
        });
      }
    }

    let upcomingSeq: number | null = null;
    let fallbackSeq: number | null = null;
    for (let seq = boardSeq; seq <= lastSeq; seq++) {
      const stop = arrivals.get(seq);
      if (!stop || stop.passed) continue;
      if (fallbackSeq == null) fallbackSeq = seq;
      // skip stops that are already over in practice so the countdown does
      // not sit on a stale projection
      if (stop.etaMs < now - 60_000) continue;
      upcomingSeq = seq;
      break;
    }
    if (upcomingSeq == null) upcomingSeq = fallbackSeq;

    const lastStop = arrivals.get(lastSeq);
    const complete = !!lastStop && lastStop.passed;

    // remember the best-known terminus arrival so a later app launch can
    // detect a trip that finished while the app was closed
    let terminusEtaMs = lastStop?.etaMs ?? null;
    if (terminusEtaMs == null) {
      // the profile may not reach the terminus yet; project the rest of the
      // route with the average segment time observed so far
      const arrivalList = Array.from(arrivals.values());
      const lastArrival = arrivalList[arrivalList.length - 1];
      if (lastArrival && lastArrival.seq > boardSeq) {
        const averageSegmentMs =
          (lastArrival.etaMs - anchorMs) / (lastArrival.seq - boardSeq);
        if (Number.isFinite(averageSegmentMs) && averageSegmentMs > 0) {
          terminusEtaMs =
            lastArrival.etaMs +
            Math.max(0, lastSeq - lastArrival.seq) * averageSegmentMs;
        }
      }
    }

    if (terminusEtaMs != null) {
      const changed =
        progressTerminusRef.current == null ||
        Math.abs(terminusEtaMs - progressTerminusRef.current) > 60_000;
      const stale = now - progressWrittenAtRef.current > 60_000;
      if (changed || stale) {
        progressWrittenAtRef.current = now;
        progressTerminusRef.current = terminusEtaMs;
        try {
          const progress: TrackingProgress = {
            startedAt: trip.startedAt,
            terminusEtaMs,
          };
          localStorage.setItem(TRACKING_PROGRESS_KEY, JSON.stringify(progress));
        } catch {
          // ignore unavailable storage
        }
      }
    }

    arrivalsRef.current = arrivals;

    if (mountedRef.current) {
      const record: Record<number, TrackedStop> = {};
      for (const [seq, stop] of arrivals) record[seq] = stop;
      setStops(record);
      setNextSeq(upcomingSeq);
      setIsComplete(complete);
      setLastUpdatedAt(now);
    }

    return added;
  }, [trip, routeList]);

  useEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);

  useEffect(() => {
    if (!trip) return;
    if (navigator.userAgent === "prerendering") return;
    const route = routeList[trip.routeKey];
    if (!route) return;

    const controller = new AbortController();
    let cancelled = false;

    loadJourneyProfile({
      routeId: trip.routeKey,
      route,
      stopList,
      holidays,
      startSeq: trip.boardSeq,
      maxSegments: profileLimit,
      signal: controller.signal,
      onChunk: (profile) => {
        if (cancelled) return;
        profileRef.current = profile;
        recomputeRef.current();
      },
    }).catch(() => {});

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trip, routeList, stopList, holidays, profileLimit]);

  const refresh = useCallback(async () => {
    if (!trip || busyRef.current) return;
    if (
      navigator.userAgent === "prerendering" ||
      !isVisible ||
      !navigator.onLine
    ) {
      return;
    }

    const route = routeList[trip.routeKey];
    if (!route) {
      setIsComplete(true);
      return;
    }

    const stopIds = Object.values(route.stops)[0] ?? [];
    const lastSeq = stopIds.length - 1;
    if (lastSeq <= trip.boardSeq) {
      setIsComplete(true);
      return;
    }

    const lastArrival = arrivalsRef.current.get(lastSeq);
    if (lastArrival?.passed) return;

    busyRef.current = true;
    setIsRefreshing(true);
    try {
      // the window is anchored at the last stop where the bus was really
      // seen; congestion makes a bus slower than any projection, so looking
      // near its last sighting is what finds it again
      let lastSightingSeq = trip.boardSeq;
      let lastSightingPassed = false;
      for (const [seq, stop] of arrivalsRef.current) {
        if (stop.source === "estimate") continue;
        if (seq >= lastSightingSeq) {
          lastSightingSeq = seq;
          lastSightingPassed = stop.passed;
        }
      }

      const windowStart = Math.min(
        lastSeq,
        Math.max(
          trip.boardSeq,
          lastSightingPassed ? lastSightingSeq + 1 : lastSightingSeq
        )
      );
      const windowEnd = Math.min(
        lastSeq,
        windowStart + WINDOW_STEPS[windowStepRef.current] - 1
      );

      // extend the journey-time horizon as the window reaches its end
      if (
        profileLimit < MAX_PROFILE_LIMIT &&
        windowEnd + PROFILE_AHEAD_THRESHOLD >= trip.boardSeq + profileLimit
      ) {
        setProfileLimit((limit) =>
          Math.min(limit + PROFILE_STEP, MAX_PROFILE_LIMIT)
        );
      }

      const seqs = new Set<number>();
      for (let seq = windowStart; seq <= windowEnd; seq++) seqs.add(seq);
      // check the terminus occasionally so the trip can finish cleanly
      if (cycleRef.current % 4 === 0) seqs.add(lastSeq);

      const ttl = Math.max(refreshInterval, MIN_LIST_TTL_MS);
      const now = Date.now();
      const pending: number[] = [];
      seqs.forEach((seq) => {
        const cached = listsRef.current.get(seq);
        if (!cached || now - cached.ts >= ttl) pending.push(seq);
      });

      if (pending.length > 0) {
        const results = await Promise.all(
          pending.map(async (seq) => ({
            seq,
            etas: await fetchEtas({
              ...route,
              seq,
              stopList,
              language,
              holidays,
              serviceDayMap,
            }).catch(() => []),
          }))
        );
        if (!mountedRef.current) return;

        const fetchedAt = Date.now();
        for (const { seq, etas } of results) {
          listsRef.current.set(seq, {
            points: buildEtaPoints(etas, trip.co, trip.dest, fetchedAt),
            ts: fetchedAt,
          });
        }
      }

      if (listsRef.current.size > MAX_CACHED_LISTS) {
        const keepFrom = windowStart - 20;
        for (const seq of Array.from(listsRef.current.keys())) {
          if (seq < keepFrom) listsRef.current.delete(seq);
        }
      }

      const added = recompute();
      // widen the search while a refresh finds nothing new, then snap back
      windowStepRef.current =
        added > 0
          ? 0
          : Math.min(windowStepRef.current + 1, WINDOW_STEPS.length - 1);
      cycleRef.current += 1;
    } catch (e) {
      if (mountedRef.current) console.error(e);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, [
    trip,
    routeList,
    stopList,
    language,
    holidays,
    serviceDayMap,
    isVisible,
    refreshInterval,
    profileLimit,
    recompute,
  ]);

  const reportEtas = useCallback(
    (routeKey: string, seq: number, etas: Eta[]) => {
      if (!trip || trip.routeKey !== routeKey || etas.length === 0) return;
      const signature = etas.map((eta) => eta.eta).join("|");
      if (listSignaturesRef.current.get(seq) === signature) return;
      listSignaturesRef.current.set(seq, signature);
      listsRef.current.set(seq, {
        points: buildEtaPoints(etas, trip.co, trip.dest, Date.now()),
        ts: Date.now(),
      });
      // an already-fetched stop view is as good as our own fetch, so use it
      // immediately instead of waiting for the next polling cycle
      recompute();
    },
    [trip, recompute]
  );

  useEffect(() => {
    if (!trip) return;
    if (navigator.userAgent === "prerendering") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(tick, refreshInterval);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [trip, refreshInterval, refresh]);

  return {
    stops,
    nextSeq,
    isRefreshing,
    lastUpdatedAt,
    isComplete,
    reportEtas,
  };
};
