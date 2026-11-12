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
  alignEtas,
  buildEtaPoints,
  estimateProgressSeq,
  findClosestIndex,
  journeySegmentMs,
  loadJourneyProfile,
  matchToleranceMs,
  nextArrivalMs,
  pickReferenceSegment,
} from "../busTracking";
import type {
  EtaPoint,
  TrackedStop,
  TrackedTrip,
  TrackingProgress,
} from "../busTracking";

const BASE_WINDOW = 3;
const MAX_WINDOW = 8;
const MAX_CACHED_LISTS = 80;
const REANCHOR_TOLERANCE_MAX_MS = 10 * 60_000;
const PREVIOUS_STOP_TOLERANCE_MS = 45_000;
const MIN_LIST_TTL_MS = 15_000;
const BASE_PROFILE_LIMIT = 30;
const PROFILE_STEP = 20;
const MAX_PROFILE_LIMIT = 90;
const PROFILE_AHEAD_THRESHOLD = 10;

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
  const observationsRef = useRef(new Map<number, TrackedStop>());
  const profileRef = useRef<number[] | null>(null);
  const progressWrittenAtRef = useRef(0);
  const progressTerminusRef = useRef<number | null>(null);
  const windowSizeRef = useRef(BASE_WINDOW);
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
    observationsRef.current = new Map();
    profileRef.current = null;
    progressWrittenAtRef.current = 0;
    progressTerminusRef.current = null;
    windowSizeRef.current = BASE_WINDOW;
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

    const arrivals = new Map<number, TrackedStop>();
    arrivals.set(boardSeq, {
      seq: boardSeq,
      eta: trip.anchorEta,
      etaMs: anchorMs,
      source: trip.anchorSource,
      passed: false,
      updatedAt: trip.startedAt,
    });

    const observations = new Map(observationsRef.current);
    let added = 0;
    let prevSeq = boardSeq;
    let prevEtaMs = anchorMs;

    for (let seq = boardSeq + 1; seq <= lastSeq; seq++) {
      const known = observations.get(seq);
      if (known) {
        arrivals.set(seq, { ...known });
        prevSeq = seq;
        prevEtaMs = known.etaMs;
        continue;
      }

      const expectedSegmentMs = journeySegmentMs(
        profileRef.current,
        boardSeq,
        prevSeq,
        seq
      );
      if (expectedSegmentMs == null) break;

      const curr = listsRef.current.get(seq)?.points ?? null;
      const prev = listsRef.current.get(prevSeq)?.points ?? null;

      const makeObserved = (point: EtaPoint): TrackedStop => ({
        seq,
        eta: point.etaStr,
        etaMs: point.etaMs,
        source: point.scheduled ? "scheduled" : "realtime",
        passed: false,
        updatedAt: now,
      });
      const makeEstimate = (etaMs: number): TrackedStop => ({
        seq,
        eta: new Date(etaMs).toISOString(),
        etaMs,
        source: "estimate",
        passed: false,
        updatedAt: now,
      });

      let next: TrackedStop | null = null;
      let observed = false;

      if (curr && curr.length > 0) {
        const toleranceMs = matchToleranceMs(curr, expectedSegmentMs);
        const ourPrevIdx = prev
          ? findClosestIndex(prev, prevEtaMs, PREVIOUS_STOP_TOLERANCE_MS)
          : -1;

        if (prev && ourPrevIdx >= 0) {
          const matches = alignEtas(prev, curr, expectedSegmentMs, toleranceMs);
          const match = matches.find((m) => m.prevIdx === ourPrevIdx);
          if (match) {
            next = makeObserved(curr[match.currIdx]);
            observed = true;
          } else {
            // our bus fell out of the top 3: borrow the segment time of the
            // bus immediately ahead to project it forward
            const refSegment = pickReferenceSegment(matches, prev, prevEtaMs);
            const etaMs = nextArrivalMs(
              prevEtaMs,
              expectedSegmentMs,
              refSegment
            );
            if (etaMs != null) next = makeEstimate(etaMs);
          }
        }

        if (!next) {
          // recover after a gap (e.g. reload, or the bus was outside the window)
          const reanchorToleranceMs =
            ourPrevIdx >= 0
              ? toleranceMs
              : Math.min(toleranceMs * 2, REANCHOR_TOLERANCE_MAX_MS);
          const predicted = prevEtaMs + expectedSegmentMs;
          const idx = findClosestIndex(curr, predicted, reanchorToleranceMs);
          if (idx >= 0) {
            next = makeObserved(curr[idx]);
            observed = true;
          }
        }

        if (!next && prev) {
          const matches = alignEtas(prev, curr, expectedSegmentMs, toleranceMs);
          const refSegment = pickReferenceSegment(matches, prev, prevEtaMs);
          const etaMs = nextArrivalMs(
            prevEtaMs,
            expectedSegmentMs,
            refSegment
          );
          if (etaMs != null) next = makeEstimate(etaMs);
        }
      }

      if (!next) {
        const etaMs = nextArrivalMs(prevEtaMs, expectedSegmentMs, null);
        if (etaMs == null) break;
        next = makeEstimate(etaMs);
      }

      if (observed) {
        observations.set(seq, next);
        added += 1;
      }
      arrivals.set(seq, next);
      prevSeq = seq;
      prevEtaMs = next.etaMs;
    }

    for (const stop of arrivals.values()) {
      const grace =
        stop.source === "estimate" ? ESTIMATE_PASS_GRACE_MS : PASS_GRACE_MS;
      stop.passed = stop.etaMs < now - grace;
    }

    let upcomingSeq: number | null = null;
    for (let seq = boardSeq; seq <= lastSeq; seq++) {
      const stop = arrivals.get(seq);
      if (stop && !stop.passed) {
        upcomingSeq = seq;
        break;
      }
    }

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

    observationsRef.current = observations;
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
      const anchorMs = Date.parse(trip.anchorEta);
      let lastObservedSeq = trip.boardSeq;
      let lastObservedPassed = false;
      for (const [seq, stop] of arrivalsRef.current) {
        if (stop.source === "estimate" || seq < lastObservedSeq) continue;
        lastObservedSeq = seq;
        lastObservedPassed = stop.passed;
      }

      const progressSeq = estimateProgressSeq(
        profileRef.current,
        trip.boardSeq,
        Date.now() - anchorMs
      );

      // extend the journey-time horizon as the bus approaches its end
      if (
        profileLimit < MAX_PROFILE_LIMIT &&
        progressSeq + PROFILE_AHEAD_THRESHOLD >= trip.boardSeq + profileLimit
      ) {
        setProfileLimit((limit) =>
          Math.min(limit + PROFILE_STEP, MAX_PROFILE_LIMIT)
        );
      }

      const windowStart = Math.min(
        lastSeq,
        Math.max(
          trip.boardSeq,
          Math.max(
            lastObservedPassed ? lastObservedSeq + 1 : lastObservedSeq,
            progressSeq - 1
          )
        )
      );
      const windowEnd = Math.min(
        lastSeq,
        windowStart + windowSizeRef.current - 1
      );

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
      windowSizeRef.current =
        added === 0
          ? Math.min(windowSizeRef.current + 2, MAX_WINDOW)
          : BASE_WINDOW;
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
