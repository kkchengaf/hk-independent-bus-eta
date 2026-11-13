import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { fetchEtas } from "hk-bus-eta";
import type { Eta } from "hk-bus-eta";
import AppContext from "../context/AppContext";
import DbContext from "../context/DbContext";
import useLanguage from "./useTranslation";
import {
  DEFAULT_HEADWAY_MS,
  ESTIMATE_PASS_GRACE_MS,
  PASS_GRACE_MS,
  TRACKING_PROGRESS_KEY,
  buildEtaPoints,
  buildTrackTable,
  estimateProgressSeq,
  findTrackByCell,
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

const BASE_WINDOW = 3;
const MAX_WINDOW = 8;
const MAX_CACHED_LISTS = 80;
const MIN_LIST_TTL_MS = 15_000;
const BASE_PROFILE_LIMIT = 30;
const PROFILE_STEP = 20;
const MAX_PROFILE_LIMIT = 90;
const PROFILE_AHEAD_THRESHOLD = 10;
/** cached ETA lists older than this are not used to build the table */
const LISTS_MAX_AGE_MS = 3 * 60_000;

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
  const identityRef = useRef<{ seq: number; etaMs: number } | null>(null);
  const lastSightingsRef = useRef(0);
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
    identityRef.current = null;
    lastSightingsRef.current = 0;
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
    const staticSegmentMs = (fromSeq: number, toSeq: number) =>
      journeySegmentMs(profileRef.current, boardSeq, fromSeq, toSeq);

    // 1. Build the bus/stop table from every fresh list we hold. The boarding
    //    row is injected so the trip keeps its identity even after the
    //    operator drops that ETA from the list.
    const lists = new Map<number, EtaPoint[]>();
    for (const [seq, cached] of listsRef.current) {
      if (now - cached.ts <= LISTS_MAX_AGE_MS) lists.set(seq, cached.points);
    }
    const boardPoints = lists.get(boardSeq) ?? [];
    const anchorPoint: EtaPoint = {
      etaMs: anchorMs,
      etaStr: trip.anchorEta,
      scheduled: trip.anchorSource === "scheduled",
      co: trip.co,
      dest: trip.dest,
    };
    const hasAnchor = boardPoints.some(
      (point) => Math.abs(point.etaMs - anchorMs) <= 90_000
    );
    lists.set(
      boardSeq,
      hasAnchor
        ? boardPoints
        : [...boardPoints, anchorPoint].sort((a, b) => a.etaMs - b.etaMs)
    );

    const table = buildTrackTable({
      seqs: [...lists.keys()],
      lists,
      staticSegmentMs,
      fallbackHeadwayMs: DEFAULT_HEADWAY_MS,
    });

    // 2. Identify the row of our bus: its last confirmed sighting, otherwise
    //    the ETA the user tapped.
    const identity = identityRef.current;
    const track: BusTrack =
      (identity && findTrackByCell(table, identity.seq, identity.etaMs)) ||
      findTrackByCell(table, boardSeq, anchorMs) || {
        id: -1,
        cells: new Map([
          [
            boardSeq,
            {
              seq: boardSeq,
              etaMs: anchorMs,
              etaStr: trip.anchorEta,
              scheduled: trip.anchorSource === "scheduled",
            },
          ],
        ]),
      };

    // 3. Project the row into per-stop arrivals. Stops where our bus is not
    //    listed are interpolated between its own sightings, and a bus that
    //    appears exactly where ours is due is adopted so the ride continues
    //    after a congested black spot.
    const { stops: projected, adopted } = projectTrack({
      track,
      boardSeq,
      lastSeq,
      staticSegmentMs,
      factors: table.factors,
      medianFactor: table.medianFactor,
      now,
      otherCells: (seq) =>
        table.tracks
          .filter((candidate) => candidate.id !== track.id)
          .map((candidate) => candidate.cells.get(seq))
          .filter((cell): cell is TrackCell => !!cell),
    });
    for (const stop of projected) arrivals.set(stop.seq, stop);

    // 4. Remember the newest real sighting so the row survives the next
    //    rebuild, and grow the polling window while the bus stays hidden.
    const realCells = [...track.cells.values()].filter(
      (cell) => cell.seq >= boardSeq && !adopted.includes(cell.seq)
    );
    const newest = realCells.reduce<TrackCell | null>(
      (acc, cell) => (!acc || cell.seq > acc.seq ? cell : acc),
      null
    );
    if (newest) {
      identityRef.current = { seq: newest.seq, etaMs: newest.etaMs };
    }
    const added = Math.max(0, realCells.length - lastSightingsRef.current);
    lastSightingsRef.current = Math.max(
      lastSightingsRef.current,
      realCells.length
    );

    const observedSeqs = realCells.map((cell) => cell.seq);
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
            // never look ahead of the bus: a delayed vehicle would otherwise
            // fall behind the polling window and stay untracked
            Math.min(progressSeq - 1, lastObservedSeq + 1)
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
