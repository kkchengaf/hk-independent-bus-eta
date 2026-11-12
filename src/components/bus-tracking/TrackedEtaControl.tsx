import { useContext } from "react";
import { Chip, IconButton, Tooltip } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import {
  DirectionsBus as DirectionsBusIcon,
  GpsFixed as GpsFixedIcon,
} from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import type { Eta } from "hk-bus-eta";
import BusTrackingContext from "../../context/BusTrackingContext";

interface TrackedEtaControlProps {
  routeKey: string;
  seq: number;
  eta: Eta;
  tracked: boolean;
}

/**
 * 追蹤班次 action shown next to an ETA row. Turns into a 追蹤中 marker once
 * the row belongs to the tracked trip.
 */
const TrackedEtaControl = ({
  routeKey,
  seq,
  eta,
  tracked,
}: TrackedEtaControlProps) => {
  const { t } = useTranslation();
  const { trip, canTrack, startTracking, openDialog } =
    useContext(BusTrackingContext);

  if (navigator.userAgent === "prerendering") return null;

  // the marker must keep showing wherever the tracked bus is, including the
  // final stop; only starting a new track is disabled there
  if (tracked) {
    return (
      <Tooltip title={t("你的班次")}>
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          icon={<DirectionsBusIcon fontSize="small" />}
          label={t("追蹤中")}
          onClick={openDialog}
          sx={trackedChipSx}
        />
      </Tooltip>
    );
  }

  // nowhere left to track from the final stop
  if (!canTrack(routeKey, eta.co, seq)) return null;

  const label = trip ? t("改為追蹤此班次") : t("追蹤班次");
  return (
    <Tooltip title={label}>
      <IconButton
        size="small"
        aria-label={label}
        onClick={() => startTracking(routeKey, seq, eta)}
        sx={trackButtonSx}
      >
        <GpsFixedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
};

export default TrackedEtaControl;

const trackedChipSx: SxProps<Theme> = {
  height: 24,
  flexShrink: 0,
  "& .MuiChip-icon": {
    fontSize: "1rem",
  },
  "& .MuiChip-label": {
    px: 0.5,
    fontSize: "0.7rem",
  },
};

const trackButtonSx: SxProps<Theme> = {
  flexShrink: 0,
  opacity: 0.7,
};
