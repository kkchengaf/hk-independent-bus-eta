import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Company, Eta, RouteListEntry } from "hk-bus-eta";
import DbContext from "./DbContext";
import { useBusTracking } from "../hooks/useBusTracking";
import {
  ESTIMATE_MATCH_TOLERANCE_MS,
  SAME_TRIP_TOLERANCE_MS,
  TRACKING_COMPLETE_GRACE_MS,
  TRACKING_PROGRESS_KEY,
  TRACKING_STORAGE_KEY,
  canTrackStop,
  isScheduledRemark,
} from "../busTracking";
import type {
  LocalizedText,
  TrackedEtaSource,
  TrackedStop,
  TrackedTrip,
  TrackingProgress,
} from "../busTracking";

const MAX_TRIP_AGE_MS = 4 * 60 * 60_000;
/** buffer on top of the route's official journey time for the offline check */
const JOURNEY_TIME_BUFFER_MS = 30 * 60_000;

export interface BusTrackingContextValue {
  trip: TrackedTrip | null;
  stops: Record<number, TrackedStop>;
  nextSeq: number | null;
  isRefreshing: boolean;
  lastUpdatedAt: number | null;
  isComplete: boolean;
  isDialogOpen: boolean;
  canTrack: (routeKey: string, co: Company, seq: number) => boolean;
  startTracking: (routeKey: string, seq: number, eta: Eta) => void;
  stopTracking: () => void;
  openDialog: () => void;
  closeDialog: () => void;
  getTrackedStop: (routeKey: string, seq: number) => TrackedStop | null;
  /** index of the ETA row that belongs to the tracked bus, or -1 */
  findTrackedEtaIndex: (
    routeKey: string,
    seq: number,
    etas: Eta[]
  ) => number;
  /** feed a stop's already-fetched ETAs into the tracker */
  reportEtas: (routeKey: string, seq: number, etas: Eta[]) => void;
}

const BusTrackingContext = createContext<BusTrackingContextValue>(
  {} as BusTrackingContextValue
);

interface BusTrackingProviderProps {
  children: ReactNode;
}

const loadStoredTrip = (
  routeList: Record<string, RouteListEntry>
): TrackedTrip | null => {
  try {
    const raw = localStorage.getItem(TRACKING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TrackedTrip>;
    if (
      parsed?.v !== 1 ||
      typeof parsed.routeKey !== "string" ||
      typeof parsed.boardSeq !== "number" ||
      typeof parsed.anchorEta !== "string" ||
      typeof parsed.startedAt !== "number" ||
      !parsed.co ||
      !parsed.dest ||
      Date.now() - parsed.startedAt > MAX_TRIP_AGE_MS
    ) {
      return null;
    }
    const route = routeList[parsed.routeKey];
    if (!route) return null;

    const now = Date.now();
    let progress: TrackingProgress | null = null;
    try {
      progress = JSON.parse(
        localStorage.getItem(TRACKING_PROGRESS_KEY) ?? "null"
      );
    } catch {
      progress = null;
    }

    if (
      progress &&
      progress.startedAt === parsed.startedAt &&
      typeof progress.terminusEtaMs === "number"
    ) {
      // the bus already reached the terminus before the app was closed
      if (now > progress.terminusEtaMs + TRACKING_COMPLETE_GRACE_MS) {
        return null;
      }
    } else {
      // no progress snapshot: fall back to the route's official journey time
      const jt = Number(route.jt);
      const anchorMs = Date.parse(parsed.anchorEta);
      if (
        Number.isFinite(jt) &&
        jt > 0 &&
        Number.isFinite(anchorMs) &&
        now > anchorMs + jt * 60_000 + JOURNEY_TIME_BUFFER_MS
      ) {
        return null;
      }
    }

    return parsed as TrackedTrip;
  } catch {
    return null;
  }
};

export const BusTrackingProvider = ({ children }: BusTrackingProviderProps) => {
  const {
    db: { routeList },
  } = useContext(DbContext);
  const [trip, setTrip] = useState<TrackedTrip | null>(() =>
    loadStoredTrip(routeList)
  );
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const {
    stops,
    nextSeq,
    isRefreshing,
    lastUpdatedAt,
    isComplete,
    reportEtas,
  } = useBusTracking(trip);

  useEffect(() => {
    try {
      if (trip) {
        localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(trip));
      } else {
        localStorage.removeItem(TRACKING_STORAGE_KEY);
        localStorage.removeItem(TRACKING_PROGRESS_KEY);
      }
    } catch {
      // storage may be unavailable (private mode); tracking still works
    }
  }, [trip]);

  // once the bus reaches the terminus the trip is over; forget it
  useEffect(() => {
    if (!isComplete) return;
    setTrip(null);
    setIsDialogOpen(false);
  }, [isComplete]);

  const canTrack = useCallback(
    (routeKey: string, co: Company, seq: number) =>
      canTrackStop(routeList[routeKey], co, seq),
    [routeList]
  );

  const startTracking = useCallback((routeKey: string, seq: number, eta: Eta) => {
    if (!eta.eta) return;
    const source: TrackedEtaSource = isScheduledRemark(eta.remark)
      ? "scheduled"
      : "realtime";
    const dest: LocalizedText = eta.dest ?? { zh: "", en: "" };
    setTrip({
      v: 1,
      routeKey,
      co: eta.co,
      dest,
      boardSeq: seq,
      anchorEta: eta.eta,
      anchorSource: source,
      startedAt: Date.now(),
    });
    setIsDialogOpen(true);
  }, []);

  const stopTracking = useCallback(() => {
    setTrip(null);
    setIsDialogOpen(false);
  }, []);

  const openDialog = useCallback(() => setIsDialogOpen(true), []);
  const closeDialog = useCallback(() => setIsDialogOpen(false), []);

  const getTrackedStop = useCallback(
    (routeKey: string, seq: number) => {
      if (!trip || trip.routeKey !== routeKey) return null;
      return stops[seq] ?? null;
    },
    [trip, stops]
  );

  const findTrackedEtaIndex = useCallback(
    (routeKey: string, seq: number, etas: Eta[]) => {
      const stop = getTrackedStop(routeKey, seq);
      if (!stop || stop.passed) return -1;
      // a chained estimate is less precise than an observed ETA, so allow it
      // a wider window before treating a displayed row as our bus
      const tolerance =
        stop.source === "estimate"
          ? ESTIMATE_MATCH_TOLERANCE_MS
          : SAME_TRIP_TOLERANCE_MS;
      let best = -1;
      let bestDiff = tolerance;
      etas.forEach((eta, idx) => {
        if (!eta.eta) return;
        const etaMs = Date.parse(eta.eta);
        if (!Number.isFinite(etaMs)) return;
        const diff = Math.abs(etaMs - stop.etaMs);
        if (diff <= bestDiff) {
          best = idx;
          bestDiff = diff;
        }
      });
      return best;
    },
    [getTrackedStop]
  );

  const value = useMemo<BusTrackingContextValue>(
    () => ({
      trip,
      stops,
      nextSeq,
      isRefreshing,
      lastUpdatedAt,
      isComplete,
      isDialogOpen,
      canTrack,
      startTracking,
      stopTracking,
      openDialog,
      closeDialog,
      getTrackedStop,
      findTrackedEtaIndex,
      reportEtas,
    }),
    [
      trip,
      stops,
      nextSeq,
      isRefreshing,
      lastUpdatedAt,
      isComplete,
      isDialogOpen,
      canTrack,
      startTracking,
      stopTracking,
      openDialog,
      closeDialog,
      getTrackedStop,
      findTrackedEtaIndex,
      reportEtas,
    ]
  );

  return (
    <BusTrackingContext.Provider value={value}>
      {children}
    </BusTrackingContext.Provider>
  );
};

export default BusTrackingContext;
