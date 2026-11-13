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
import { waitInfo } from "../../busTracking";

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
  const wait = next ? waitInfo(next.etaMs) : null;

  let status: string;
  if (isComplete) status = t("已到達終點站");
  else if (wait?.state === "arriving") status = t("即將抵達");
  else if (wait?.state === "future")
    status = `${t("下一站")} ${wait.minutes} ${t("分鐘")}`;
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
  // the theme's primary.contrastText is intentionally faint for flat buttons,
  // so set readable colours for this solid pill explicitly
  backgroundColor: (theme) =>
    theme.palette.mode === "light"
      ? theme.palette.background.paper
      : theme.palette.primary.main,
  color: (theme) =>
    theme.palette.mode === "light" ? theme.palette.text.primary : "#000",
  border: (theme) =>
    theme.palette.mode === "light" ? "1px solid rgba(0, 0, 0, 0.23)" : "none",
  "&.MuiButton-root:hover": {
    backgroundColor: (theme) =>
      theme.palette.mode === "light"
        ? theme.palette.grey[100]
        : theme.palette.primary.main,
  },
};
