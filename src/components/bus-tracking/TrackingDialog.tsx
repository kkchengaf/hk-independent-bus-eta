import { useContext, useEffect, useMemo, useRef } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import {
  Close as CloseIcon,
  DirectionsBus as DirectionsBusIcon,
  StopCircle as StopCircleIcon,
} from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import BusTrackingContext from "../../context/BusTrackingContext";
import DbContext from "../../context/DbContext";
import AppContext from "../../context/AppContext";
import useLanguage from "../../hooks/useTranslation";
import { toProperCase } from "../../utils";
import {
  formatHkTime,
  formatHkTimestamp,
  waitMinutes,
} from "../../busTracking";

/**
 * Lists the estimated / observed arrival of the tracked trip at every stop.
 */
const TrackingDialog = () => {
  const { t } = useTranslation();
  const language = useLanguage();
  const navigate = useNavigate();
  const { etaFormat } = useContext(AppContext);
  const {
    db: { routeList, stopList },
  } = useContext(DbContext);
  const {
    trip,
    stops,
    nextSeq,
    isDialogOpen,
    isRefreshing,
    lastUpdatedAt,
    isComplete,
    closeDialog,
    stopTracking,
  } = useContext(BusTrackingContext);
  const rowRefs = useRef<Record<number, HTMLLIElement | null>>({});

  const rows = useMemo(
    () => Object.values(stops).sort((a, b) => a.seq - b.seq),
    [stops]
  );

  useEffect(() => {
    if (!isDialogOpen || nextSeq == null) return;
    rowRefs.current[nextSeq]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [isDialogOpen, nextSeq]);

  if (!trip) return null;

  const route = routeList[trip.routeKey];
  const stopIds = route ? Object.values(route.stops)[0] ?? [] : [];
  const boardStop = stopList[stopIds[trip.boardSeq]];

  const handleViewRoute = () => {
    closeDialog();
    navigate(`/${language}/route/${trip.routeKey.toLowerCase()}`);
  };

  return (
    <Dialog
      open={isDialogOpen}
      onClose={closeDialog}
      fullWidth
      maxWidth="xs"
      sx={dialogSx}
    >
      <DialogTitle sx={titleSx}>
        <Box minWidth={0}>
          <Typography component="h2" variant="subtitle1" fontWeight={700}>
            <DirectionsBusIcon
              fontSize="small"
              sx={{ mr: 0.5, verticalAlign: "text-bottom" }}
            />
            {`${route?.route ?? trip.routeKey} ${t("往")} ${toProperCase(
              trip.dest[language]
            )}`}
          </Typography>
          <Typography
            component="p"
            variant="caption"
            color="text.secondary"
            noWrap
          >
            {`${t("上車站")}: ${
              boardStop ? toProperCase(boardStop.name[language]) : "-"
            } · ${trip.anchorEta.slice(11, 16)} ${t("班次")}`}
          </Typography>
        </Box>
        <IconButton aria-label={t("關閉視窗")} onClick={closeDialog}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={contentSx}>
        <Box sx={statusSx}>
          {isRefreshing && <CircularProgress size={14} />}
          <Typography variant="caption" color="text.secondary">
            {lastUpdatedAt
              ? `${t("更新於")} ${formatHkTimestamp(lastUpdatedAt)}`
              : t("資料更新中")}
          </Typography>
          {isComplete && (
            <Chip size="small" color="success" label={t("已到達終點站")} />
          )}
        </Box>
        {trip.anchorSource === "scheduled" && (
          <Typography variant="caption" sx={scheduledNoticeSx}>
            {t("此班次為預定班次，時間或有偏差")}
          </Typography>
        )}
        {rows.length === 0 ? (
          <Box sx={loadingSx}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <List dense disablePadding>
            {rows.map((stop) => {
              const isNext = stop.seq === nextSeq;
              const exact = formatHkTime(stop.etaMs);
              const minutes = waitMinutes(stop.etaMs);
              const waitText =
                minutes <= 0
                  ? t("即將抵達")
                  : `${minutes} ${t("分鐘")}`;
              const etaText = stop.passed
                ? exact
                : etaFormat === "exact"
                ? exact
                : etaFormat === "diff"
                ? waitText
                : `${exact}\u3000${waitText}`;
              const sourceLabel = stop.passed
                ? t("已過")
                : stop.source === "estimate"
                ? t("預計")
                : stop.source === "scheduled"
                ? t("預定班次")
                : t("實時");

              return (
                <ListItem
                  key={stop.seq}
                  ref={(el: HTMLLIElement | null) => {
                    rowRefs.current[stop.seq] = el;
                  }}
                  sx={
                    stop.passed
                      ? passedItemSx
                      : isNext
                      ? nextItemSx
                      : undefined
                  }
                  secondaryAction={
                    <Chip
                      size="small"
                      variant="outlined"
                      color={
                        stop.passed
                          ? "default"
                          : stop.source === "estimate"
                          ? "warning"
                          : "success"
                      }
                      label={sourceLabel}
                    />
                  }
                >
                  <ListItemText
                    primary={
                      <Typography
                        component="span"
                        variant="body2"
                        fontWeight={isNext ? 700 : 400}
                      >
                        {`${stop.seq + 1}. ${
                          stopList[stopIds[stop.seq]]?.name[language] ??
                          stopIds[stop.seq] ??
                          ""
                        }`}
                      </Typography>
                    }
                    secondary={
                      <Typography
                        component="span"
                        variant="subtitle2"
                        sx={etaTextSx}
                      >
                        {`${stop.source === "estimate" ? "≈ " : ""}${etaText}`}
                      </Typography>
                    }
                    secondaryTypographyProps={{ component: "span" }}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleViewRoute}>{t("查看路線")}</Button>
        <Button
          color="error"
          startIcon={<StopCircleIcon />}
          onClick={stopTracking}
        >
          {t("停止追蹤")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default TrackingDialog;

const dialogSx: SxProps<Theme> = {
  "& .MuiPaper-root": {
    width: "100%",
    marginTop: "90px",
    height: "calc(100vh - 100px)",
  },
};

const titleSx: SxProps<Theme> = {
  backgroundColor: (theme) => theme.palette.background.default,
  color: (theme) => theme.palette.primary.main,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 1,
};

const contentSx: SxProps<Theme> = {
  p: 0,
};

const statusSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  px: 2,
  py: 0.5,
  minHeight: 32,
};

const scheduledNoticeSx: SxProps<Theme> = {
  display: "block",
  px: 2,
  pb: 0.5,
  color: "warning.main",
};

const loadingSx: SxProps<Theme> = {
  display: "flex",
  justifyContent: "center",
  py: 4,
};

const passedItemSx: SxProps<Theme> = {
  opacity: 0.45,
};

const nextItemSx: SxProps<Theme> = {
  backgroundColor: "action.hover",
  borderLeft: (theme) => `3px solid ${theme.palette.warning.main}`,
};

const etaTextSx: SxProps<Theme> = {
  color: "warning.main",
  fontWeight: 700,
};
