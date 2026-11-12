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
  SAME_TRIP_TOLERANCE_MS,
  canTrackRoute,
  isScheduledRemark,
} from "../busTracking";
import type {
  LocalizedText,
  TrackedEtaSource,
  TrackedStop,
  TrackedTrip,
} from "../busTracking";

const STORAGE_KEY = "busTracking";
const MAX_TRIP_AGE_MS = 4 * 60 * 60_000;

export interface BusTrackingContextValue {
  trip: TrackedTrip | null;
  stops: Record<number, TrackedStop>;
  nextSeq: number | null;
  isRefreshing: boolean;
  lastUpdatedAt: number | null;
  isComplete: boolean;
  isDialogOpen: boolean;
  canTrack: (routeKey: string, co: Company) => boolean;
  startTracking: (routeKey: string, seq: number, eta: Eta) => void;
  stopTracking: () => void;
  openDialog: () => void;
  closeDialog: () => void;
  getTrackedStop: (routeKey: string, seq: number) => TrackedStop | null;
  isTrackedEta: (routeKey: string, seq: number, eta: Eta) => boolean;
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
    const raw = localStorage.getItem(STORAGE_KEY);
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
      !routeList[parsed.routeKey] ||
      Date.now() - parsed.startedAt > MAX_TRIP_AGE_MS
    ) {
      return null;
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
  } = useBusTracking(trip);

  useEffect(() => {
    try {
      if (trip) localStorage.setItem(STORAGE_KEY, JSON.stringify(trip));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage may be unavailable (private mode); tracking still works
    }
  }, [trip]);

  const canTrack = useCallback(
    (routeKey: string, co: Company) => canTrackRoute(routeList[routeKey], co),
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

  const isTrackedEta = useCallback(
    (routeKey: string, seq: number, eta: Eta) => {
      const stop = getTrackedStop(routeKey, seq);
      if (!stop || stop.passed || !eta.eta) return false;
      const etaMs = Date.parse(eta.eta);
      return (
        Number.isFinite(etaMs) &&
        Math.abs(etaMs - stop.etaMs) <= SAME_TRIP_TOLERANCE_MS
      );
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
      isTrackedEta,
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
      isTrackedEta,
    ]
  );

  return (
    <BusTrackingContext.Provider value={value}>
      {children}
    </BusTrackingContext.Provider>
  );
};

export default BusTrackingContext;
