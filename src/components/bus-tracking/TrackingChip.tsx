import { useContext } from "react";
import { Button } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import {
  CheckCircle as CheckCircleIcon,
  DirectionsBus as DirectionsBusIcon,
} from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import BusTrackingContext from "../../context/BusTrackingContext";
import DbContext from "../../context/DbContext";
import { waitMinutes } from "../../busTracking";

/**
 * Floating entry point that keeps the tracked trip reachable on every page.
 */
const TrackingChip = () => {
  const { t } = useTranslation();
  const { trip, stops, nextSeq, isComplete, openDialog } =
    useContext(BusTrackingContext);
  const {
    db: { routeList },
  } = useContext(DbContext);

  if (!trip || navigator.userAgent === "prerendering") return null;

  const route = routeList[trip.routeKey];
  const next = nextSeq != null ? stops[nextSeq] : null;
  const minutes = next ? waitMinutes(next.etaMs) : null;

  let status: string;
  if (isComplete) status = t("已到達終點站");
  else if (minutes != null && minutes <= 0) status = t("即將抵達");
  else if (minutes != null) status = `${t("下一站")} ${minutes} ${t("分鐘")}`;
  else status = t("追蹤中");

  return (
    <Button
      variant="contained"
      size="small"
      color="primary"
      startIcon={
        isComplete ? <CheckCircleIcon /> : <DirectionsBusIcon />
      }
      onClick={openDialog}
      aria-label={t("開啟班次追蹤")}
      sx={chipSx}
    >
      {`${route?.route ?? trip.routeKey} · ${status}`}
    </Button>
  );
};

export default TrackingChip;

const chipSx: SxProps<Theme> = {
  position: "fixed",
  left: "50%",
  bottom: "calc(64px + env(safe-area-inset-bottom, 0px))",
  transform: "translateX(-50%)",
  zIndex: (theme) => theme.zIndex.drawer,
  borderRadius: 999,
  boxShadow: 4,
  textTransform: "none",
  whiteSpace: "nowrap",
  maxWidth: "calc(100vw - 32px)",
};
