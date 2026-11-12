import { useContext, useMemo } from "react";
import { Box, Chip, SxProps, Theme, Typography } from "@mui/material";
import { DirectionsBus as DirectionsBusIcon } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import AppContext from "../../context/AppContext";
import { useEtas } from "../../hooks/useEtas";
import { LinearProgress } from "../Progress";
import { Eta, Terminal } from "hk-bus-eta";
import { getPlatformSymbol, getLineColor } from "../../utils";
import useLanguage from "../../hooks/useTranslation";
import DbContext from "../../context/DbContext";
import BusTrackingContext from "../../context/BusTrackingContext";
import TrackedEtaControl from "../bus-tracking/TrackedEtaControl";
import { formatHkTime, waitMinutes } from "../../busTracking";
import type { TrackedStop } from "../../busTracking";
import { DoubleTrainIcon, SingleTrainIcon } from "../home/SuccinctEtas";

interface TimeReportProps {
  routeId: string;
  seq: number;
  containerSx?: SxProps<Theme>;
  showStopName?: boolean;
  /**
   * When true, the report is exposed as a polite live region so that
   * screen readers announce arrival-time changes for the focused stop.
   * Off by default to avoid chatter when many reports are on screen.
   */
  announce?: boolean;
}

const TimeReport = ({
  routeId,
  seq,
  containerSx,
  showStopName = false,
  announce = false,
}: TimeReportProps) => {
  const { t } = useTranslation();
  const language = useLanguage();
  const {
    db: { routeList, stopList },
  } = useContext(DbContext);
  const { getTrackedStop, findTrackedEtaIndex } =
    useContext(BusTrackingContext);
  const etas = useEtas(`${routeId}/${seq}`);

  const trackedStop = getTrackedStop(routeId, seq);
  const trackedIndex = useMemo(
    () => (etas ? findTrackedEtaIndex(routeId, seq, etas) : -1),
    [etas, findTrackedEtaIndex, routeId, seq]
  );
  const showTrackedEstimate =
    !!trackedStop && !trackedStop.passed && trackedIndex < 0;

  const { route, co, stops } = routeList[routeId];
  const stopId = Object.values(stops)[0][seq];
  const routeDests = useMemo(
    () =>
      Object.values(routeList[routeId].stops)
        .map((ids) => stopList[ids[ids.length - 1]].name)
        .concat(routeList[routeId].dest),
    [routeList, routeId, stopList]
  );

  const noScheduleRemark = useMemo(() => {
    let isEndOfTrainLine = false;
    if (co[0] === "mtr") {
      isEndOfTrainLine =
        stops["mtr"].indexOf(stopId) + 1 >= stops["mtr"].length;
    } else if (co.includes("lightRail")) {
      isEndOfTrainLine =
        stops["lightRail"].indexOf(stopId) + 1 >= stops["lightRail"].length;
    }

    if (etas === null) {
      return null;
    }

    if (isEndOfTrainLine && etas.length === 0) {
      return t("終點站");
    } else if (
      etas.length > 0 &&
      etas.every((e) => !e.eta) &&
      etas[0].remark[language]
    ) {
      return etas[0].remark[language];
    } else if (etas.length === 0 || etas.every((e) => !e.eta)) {
      return t("未有班次資料");
    }
    return null;
  }, [etas, co, stops, stopId, t, language]);

  const liveProps = announce
    ? { role: "status" as const, "aria-live": "polite" as const }
    : {};

  if (etas == null) {
    return (
      <Box sx={containerSx} {...liveProps}>
        <LinearProgress aria-label={t("資料更新中")} />
      </Box>
    );
  }

  return (
    <Box sx={containerSx} {...liveProps}>
      {showStopName && (
        <Typography variant="caption">
          {stopList[stopId].name[language]}
        </Typography>
      )}
      {noScheduleRemark}
      {etas.length > 0 &&
        etas.every((e) => e.eta) &&
        etas.map((eta, idx) => (
          <EtaLine
            key={`route-${idx}`}
            eta={eta}
            routeDests={routeDests}
            showCompany={co.length > 1}
            route={route}
            routeKey={routeId}
            seq={seq}
            tracked={idx === trackedIndex}
          />
        ))}
      {showTrackedEstimate && trackedStop && (
        <TrackedEtaRow stop={trackedStop} />
      )}
    </Box>
  );
};

interface TrackedEtaRowProps {
  stop: TrackedStop;
}

/**
 * Shown when the tracked bus is no longer among the operator's ETAs for this
 * stop, so its chained estimate stays visible.
 */
const TrackedEtaRow = ({ stop }: TrackedEtaRowProps) => {
  const { t } = useTranslation();
  const { etaFormat } = useContext(AppContext);
  const { openDialog } = useContext(BusTrackingContext);
  const waitTime = waitMinutes(stop.etaMs);
  const exactTime = formatHkTime(stop.etaMs);

  return (
    <Box sx={trackedRowSx}>
      <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0 }}>
        <DirectionsBusIcon fontSize="small" sx={trackedIconSx} />
        <Box component="span" sx={{ fontSize: "0.8em", mr: 1 }}>
          {t("你的班次")}
        </Box>
        {stop.source === "estimate" && "≈ "}
        {etaFormat === "exact" && exactTime}
        {etaFormat !== "exact" && (
          <>
            {etaFormat === "mixed" && <>{exactTime}&emsp;</>}
            <Box
              component="span"
              sx={{
                ...waitTimeSx,
                color: (theme) => theme.palette.warning.main,
              }}
            >
              {waitTime <= 0 ? " - " : `${waitTime} `}
            </Box>
            <Box component="span" sx={{ fontSize: "0.8em" }}>
              {t("分鐘")}
            </Box>
          </>
        )}
      </Typography>
      <Chip
        size="small"
        variant="outlined"
        color="warning"
        label={stop.source === "estimate" ? t("預計") : t("實時")}
        onClick={openDialog}
      />
    </Box>
  );
};

interface EtaMsgProps {
  eta: Eta;
  routeDests: Terminal[];
  showCompany: boolean;
  route: string;
  routeKey: string;
  seq: number;
  tracked: boolean;
}

const EtaLine = ({
  eta,
  routeDests,
  showCompany,
  route,
  routeKey,
  seq,
  tracked,
}: EtaMsgProps) => {
  const { eta: etaTime, remark, co, dest } = eta;
  const { t } = useTranslation();
  const language = useLanguage();
  const { etaFormat, platformMode } = useContext(AppContext);

  const branchRoute = useMemo(() => {
    if (co === "mtr") {
      return true;
    }
    for (const routeDest of routeDests) {
      if (routeDest.en.toLowerCase() === dest.en.toLowerCase()) {
        return false;
      }
      if (routeDest.zh === dest.zh) {
        return false;
      }
    }
    return true;
  }, [routeDests, dest, co]);

  const waitTime = Math.round(
    (new Date(etaTime).getTime() - new Date().getTime()) / 60 / 1000
  );

  const exactTimeJsx = (
    <Box
      component="span"
      sx={etaFormat !== "exact" ? { fontSize: "0.9em" } : {}}
    >
      {etaTime.slice(11, 16)}
    </Box>
  );

  const isTrain = co === "mtr" || co === "lightRail";

  let waitTimeText;
  let trainTextUsed;
  if (isTrain && waitTime <= 1) {
    waitTimeText = waitTime === 1 ? `${t("即將抵達")} ` : `${t("正在離開")} `;
    trainTextUsed = true;
  } else {
    waitTimeText = waitTime < 1 ? " - " : `${waitTime} `;
    trainTextUsed = false;
  }

  const waitTimeJsx = (
    <Box component="span">
      <Box
        component="span"
        sx={{ ...waitTimeSx, color: (theme) => theme.palette.warning.main }}
        fontSize={trainTextUsed ? "0.9em" : undefined}
      >
        {waitTimeText}
      </Box>
      {!trainTextUsed && (
        <Box component="span" sx={{ fontSize: "0.8em" }}>
          {t("分鐘")}
        </Box>
      )}
    </Box>
  );

  return (
    <Box sx={etaRowSx}>
      <Typography
        variant="subtitle1"
        sx={{ justifyContent: "center", flex: 1, minWidth: 0 }}
      >
        {etaFormat === "diff" && waitTimeJsx}
        {etaFormat === "exact" && exactTimeJsx}
        {etaFormat === "mixed" && (
          <>
            {exactTimeJsx}&emsp;{waitTimeJsx}
          </>
        )}
        {!isTrain && <>&emsp;-&nbsp;</>}
        <Box
          component="span"
          sx={{ fontSize: "0.8em", textOverflow: "ellipsis" }}
        >
          {showCompany && <>&emsp;{t(co)}</>}
          &emsp;
          <EtaRemark
            remark={remark}
            co={co}
            language={language}
            route={route}
            platformMode={platformMode}
          />
          {isTrain && " "}
          {!isTrain && <>&emsp;</>}
          {branchRoute && dest[language]}
        </Box>
      </Typography>
      <TrackedEtaControl
        routeKey={routeKey}
        seq={seq}
        eta={eta}
        tracked={tracked}
      />
    </Box>
  );
};

interface EtaRemarkProps {
  remark: Eta["remark"];
  co: Eta["co"];
  route: string;
  platformMode: boolean;
  language: "zh" | "en";
}

const EtaRemark = ({
  remark,
  language,
  co,
  route,
  platformMode,
}: EtaRemarkProps) => {
  if (remark === null) return "";

  const isTrain = co === "mtr" || co === "lightRail";
  if (!isTrain) {
    return remark[language];
  }

  const parts: string[] = [];
  let ret = "";
  let trains = "";

  // the parser only works with en but zh can be used as fallback for display anyway
  (remark.en || remark[language]).split(" - ").forEach((part, i) => {
    // retrieve single digit numerical string from remark as a circle text
    const platform = [...(part.matchAll(/^Platform (\d+)$/g) ?? [])][0] || [];
    // replace only when single occurrence of single digit numerical string
    // if the remark has more than one occurrence of numerical string
    // or if the only numerical string occurrence are more than one digit, use original remark
    if (platform.length === 2 && platform[1].length) {
      // getPlatformSymbol only supports single digit number
      ret = getPlatformSymbol(Number(platform[1]), platformMode) ?? platform[1];
      return;
    }

    const trainsLocal = (/^▭+$/g.exec(part) ?? [])[0];
    if (trainsLocal) {
      trains = trainsLocal;
      return;
    }

    parts.push(remark[language].split(" - ")[i]);
  });

  return (
    <>
      <Box
        component="span"
        color={getLineColor([co], route, true)}
        sx={{ marginX: 0.25 }}
      >
        {ret}
      </Box>
      <Box component="span" sx={{ marginX: 0.25 }}>
        {trains.length === 1 && <SingleTrainIcon />}
        {trains.length === 2 && <DoubleTrainIcon />}
      </Box>
      {parts.map((part, i) => (
        <Box key={i} component="span" sx={{ marginX: 0.25 }}>
          {part}
        </Box>
      ))}
    </>
  );
};

export default TimeReport;

const waitTimeSx: SxProps<Theme> = {
  fontWeight: "700",
  color: "#088bce",
};

const etaRowSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
};

const trackedRowSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  pl: 1,
  borderLeft: (theme) => `3px solid ${theme.palette.warning.main}`,
  backgroundColor: "action.hover",
};

const trackedIconSx: SxProps<Theme> = {
  mr: 0.5,
  verticalAlign: "text-bottom",
};
