import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export type ScrubberRange = { startMs: number; endMs: number };
export type EventType = 'motion' | 'ai' | 'audio' | 'tamper' | 'timelapse';
export type ScrubberEvent = {
  id: string;
  tsMs: number;
  type: EventType;
  severity?: 1 | 2 | 3;
};

type SeekReason = 'drag' | 'release' | 'tap' | 'event' | 'program';

type PlaybackScrubberProps = {
  startMs: number;
  endMs: number;
  currentMs: number;
  isPlaying: boolean;
  recordingRanges: ScrubberRange[];
  bufferedRanges: ScrubberRange[];
  events: ScrubberEvent[];
  zoomSeconds?: number;
  onZoomChange?: (seconds: number) => void;
  onSeekRequest: (tsMs: number, reason: SeekReason) => void;
  onScrubStateChange?: (isScrubbing: boolean) => void;
  getThumbnail?: (tsMs: number) => Promise<{ uri: string }>;
  eventFilter?: Set<EventType>;
  style?: StyleProp<ViewStyle>;
};

type ScrubberControllerInput = {
  startMs: number;
  endMs: number;
  currentMs: number;
  initialZoomSeconds?: number;
  controlledZoomSeconds?: number;
  onZoomChange?: (seconds: number) => void;
  onSeekRequest: (tsMs: number, reason: SeekReason) => void;
  onScrubStateChange?: (isScrubbing: boolean) => void;
};

type Viewport = {
  centerMs: number;
  windowMs: number;
  widthPx: number;
};

const MIN_ZOOM_MS = 10_000;
const DEBOUNCE_DRAG_MS = 120;
const MAX_MARKERS = 200;
const MIN_HIT_SLOP = 18;

const EVENT_COLORS: Record<EventType, string> = {
  motion: '#F59E0B',
  ai: '#8B5CF6',
  audio: '#10B981',
  tamper: '#EF4444',
  timelapse: '#3B82F6',
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

const formatHMS = (epochMs: number): string => {
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], { hour12: false });
};

const normalizeRanges = (ranges: ScrubberRange[]) =>
  [...ranges]
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .reduce<ScrubberRange[]>((acc, curr) => {
      const prev = acc[acc.length - 1];
      if (!prev || curr.startMs > prev.endMs) {
        acc.push({ ...curr });
      } else {
        prev.endMs = Math.max(prev.endMs, curr.endMs);
      }
      return acc;
    }, []);

const rangeToStyle = (range: ScrubberRange, viewport: Viewport) => {
  const leftMs = viewport.centerMs - viewport.windowMs / 2;
  const pxPerMs = viewport.widthPx / viewport.windowMs;
  const left = (range.startMs - leftMs) * pxPerMs;
  const width = Math.max((range.endMs - range.startMs) * pxPerMs, 1);
  return { left, width };
};

const tsToX = (tsMs: number, viewport: Viewport) => {
  const leftMs = viewport.centerMs - viewport.windowMs / 2;
  return ((tsMs - leftMs) / viewport.windowMs) * viewport.widthPx;
};

const xToTs = (x: number, viewport: Viewport, startMs: number, endMs: number) => {
  const leftMs = viewport.centerMs - viewport.windowMs / 2;
  const ts = leftMs + (x / viewport.widthPx) * viewport.windowMs;
  return clamp(ts, startMs, endMs);
};

const useThumbnailPreview = (
  getThumbnail?: (tsMs: number) => Promise<{ uri: string }>,
  maxEntries = 40
) => {
  const cacheRef = useRef(new Map<number, string>());
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const fetchThumbnail = useCallback(
    async (tsMs: number) => {
      if (!getThumbnail) return;
      const key = Math.floor(tsMs / 1000) * 1000;
      const cache = cacheRef.current;
      if (cache.has(key)) {
        const value = cache.get(key)!;
        cache.delete(key);
        cache.set(key, value);
        setPreviewUri(value);
        return;
      }
      try {
        const result = await getThumbnail(key);
        cache.set(key, result.uri);
        if (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        setPreviewUri(result.uri);
      } catch {
        setPreviewUri(null);
      }
    },
    [getThumbnail, maxEntries]
  );

  return { previewUri, fetchThumbnail };
};

export const useScrubberController = ({
  startMs,
  endMs,
  currentMs,
  initialZoomSeconds = 3600,
  controlledZoomSeconds,
  onZoomChange,
  onSeekRequest,
  onScrubStateChange,
}: ScrubberControllerInput) => {
  const totalMs = Math.max(endMs - startMs, MIN_ZOOM_MS);
  const [widthPx, setWidthPx] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const uncontrolledZoomMs = useRef(clamp(initialZoomSeconds * 1000, MIN_ZOOM_MS, totalMs));
  const zoomMs = clamp((controlledZoomSeconds ? controlledZoomSeconds * 1000 : uncontrolledZoomMs.current), MIN_ZOOM_MS, totalMs);

  const centerMsSV = useSharedValue(clamp(currentMs, startMs, endMs));
  const windowMsSV = useSharedValue(zoomMs);
  const playheadMsSV = useSharedValue(clamp(currentMs, startMs, endMs));
  const lastDragEmitAt = useSharedValue(0);

  const setZoomMs = useCallback(
    (nextZoomMs: number) => {
      const clamped = clamp(nextZoomMs, MIN_ZOOM_MS, totalMs);
      uncontrolledZoomMs.current = clamped;
      windowMsSV.value = withTiming(clamped, { duration: 150 });
      onZoomChange?.(Math.round(clamped / 1000));
    },
    [onZoomChange, totalMs, windowMsSV]
  );

  useEffect(() => {
    if (!isScrubbing) {
      playheadMsSV.value = clamp(currentMs, startMs, endMs);
      centerMsSV.value = clamp(currentMs, startMs, endMs);
    }
  }, [centerMsSV, currentMs, endMs, isScrubbing, playheadMsSV, startMs]);

  useEffect(() => {
    if (controlledZoomSeconds) {
      const next = clamp(controlledZoomSeconds * 1000, MIN_ZOOM_MS, totalMs);
      windowMsSV.value = next;
    }
  }, [controlledZoomSeconds, totalMs, windowMsSV]);

  const setScrubState = useCallback(
    (next: boolean) => {
      setIsScrubbing(next);
      onScrubStateChange?.(next);
    },
    [onScrubStateChange]
  );

  const emitSeek = useCallback(
    (tsMs: number, reason: SeekReason) => onSeekRequest(clamp(tsMs, startMs, endMs), reason),
    [endMs, onSeekRequest, startMs]
  );

  return {
    widthPx,
    setWidthPx,
    isScrubbing,
    setScrubState,
    setZoomMs,
    emitSeek,
    shared: {
      centerMsSV,
      windowMsSV,
      playheadMsSV,
      lastDragEmitAt,
    },
    viewport: {
      centerMs: centerMsSV.value,
      windowMs: windowMsSV.value,
      widthPx,
    },
    limits: { startMs, endMs, totalMs },
  };
};

export const PlaybackScrubber: React.FC<PlaybackScrubberProps> = (props) => {
  const {
    startMs,
    endMs,
    currentMs,
    recordingRanges,
    bufferedRanges,
    events,
    onSeekRequest,
    onScrubStateChange,
    onZoomChange,
    zoomSeconds,
    eventFilter,
    style,
    getThumbnail,
  } = props;

  const controller = useScrubberController({
    startMs,
    endMs,
    currentMs,
    controlledZoomSeconds: zoomSeconds,
    onSeekRequest,
    onScrubStateChange,
    onZoomChange,
  });

  const [localViewport, setLocalViewport] = useState<Viewport>({
    centerMs: currentMs,
    windowMs: (zoomSeconds ?? 3600) * 1000,
    widthPx: 1,
  });

  const { previewUri, fetchThumbnail } = useThumbnailPreview(getThumbnail);

  useAnimatedReaction(
    () => ({
      centerMs: controller.shared.centerMsSV.value,
      windowMs: controller.shared.windowMsSV.value,
    }),
    (v) => runOnJS(setLocalViewport)({ centerMs: v.centerMs, windowMs: v.windowMs, widthPx: controller.widthPx })
  );

  const filteredEvents = useMemo(() => {
    if (!eventFilter || eventFilter.size === 0) return events;
    return events.filter((e) => eventFilter.has(e.type));
  }, [eventFilter, events]);

  const clusteredEvents = useMemo(() => {
    if (controller.widthPx <= 1) return [];
    const bucketPx = Math.max(5, Math.ceil(controller.widthPx / MAX_MARKERS));
    const buckets = new Map<number, ScrubberEvent[]>();
    for (const event of filteredEvents) {
      const x = tsToX(event.tsMs, localViewport);
      if (x < -6 || x > controller.widthPx + 6) continue;
      const bucket = Math.floor(x / bucketPx);
      const list = buckets.get(bucket) ?? [];
      list.push(event);
      buckets.set(bucket, list);
    }

    const merged = [...buckets.entries()].map(([bucket, list]) => {
      const tsMs = list[Math.floor(list.length / 2)].tsMs;
      const severity = list.reduce((max, e) => Math.max(max, e.severity ?? 1), 1) as 1 | 2 | 3;
      const type = list.find((e) => e.type === 'tamper')?.type ?? list[0].type;
      return { id: `cluster-${bucket}`, tsMs, type, severity, count: list.length };
    });

    return merged.slice(0, MAX_MARKERS);
  }, [controller.widthPx, filteredEvents, localViewport]);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => controller.setWidthPx(Math.max(e.nativeEvent.layout.width, 1)),
    [controller]
  );

  const timelineTap = Gesture.Tap().onEnd((e) => {
    const viewport: Viewport = {
      centerMs: controller.shared.centerMsSV.value,
      windowMs: controller.shared.windowMsSV.value,
      widthPx: controller.widthPx,
    };
    const ts = xToTs(e.x, viewport, startMs, endMs);
    controller.shared.playheadMsSV.value = ts;
    controller.shared.centerMsSV.value = ts;
    runOnJS(controller.emitSeek)(ts, 'tap');
  });

  const pan = Gesture.Pan()
    .hitSlop(MIN_HIT_SLOP)
    .onBegin(() => runOnJS(controller.setScrubState)(true))
    .onUpdate((e) => {
      const viewport: Viewport = {
        centerMs: controller.shared.centerMsSV.value,
        windowMs: controller.shared.windowMsSV.value,
        widthPx: Math.max(controller.widthPx, 1),
      };
      const ts = xToTs(e.x, viewport, startMs, endMs);
      controller.shared.playheadMsSV.value = ts;
      controller.shared.centerMsSV.value = ts;

      const now = Date.now();
      if (now - controller.shared.lastDragEmitAt.value >= DEBOUNCE_DRAG_MS) {
        controller.shared.lastDragEmitAt.value = now;
        runOnJS(controller.emitSeek)(ts, 'drag');
      }
      runOnJS(fetchThumbnail)(ts);
    })
    .onFinalize(() => {
      const ts = controller.shared.playheadMsSV.value;
      runOnJS(controller.emitSeek)(ts, 'release');
      runOnJS(controller.setScrubState)(false);
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = clamp(controller.shared.windowMsSV.value / e.scale, MIN_ZOOM_MS, controller.limits.totalMs);
      controller.shared.windowMsSV.value = next;
    })
    .onEnd(() => {
      runOnJS(controller.setZoomMs)(controller.shared.windowMsSV.value);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const now = controller.shared.windowMsSV.value;
      const mid = (MIN_ZOOM_MS + controller.limits.totalMs) / 2;
      const target = now > mid ? Math.max(now / 3, MIN_ZOOM_MS) : Math.min(now * 3, controller.limits.totalMs);
      runOnJS(controller.setZoomMs)(target);
    });

  const composed = Gesture.Simultaneous(timelineTap, pan, pinch, doubleTap);

  const playheadStyle = useAnimatedStyle(() => {
    const viewport: Viewport = {
      centerMs: controller.shared.centerMsSV.value,
      windowMs: controller.shared.windowMsSV.value,
      widthPx: Math.max(controller.widthPx, 1),
    };
    const x = tsToX(controller.shared.playheadMsSV.value, viewport);
    return { transform: [{ translateX: x }] };
  });

  const jumpToAdjacentEvent = (direction: -1 | 1) => {
    const baseTs = controller.shared.playheadMsSV.value;
    const sorted = [...filteredEvents].sort((a, b) => a.tsMs - b.tsMs);
    const target =
      direction < 0
        ? [...sorted].reverse().find((e) => e.tsMs < baseTs)
        : sorted.find((e) => e.tsMs > baseTs);
    if (!target) return;
    controller.shared.playheadMsSV.value = target.tsMs;
    controller.shared.centerMsSV.value = withTiming(target.tsMs, { duration: 200 });
    controller.emitSeek(target.tsMs, 'event');
  };

  const recording = useMemo(() => normalizeRanges(recordingRanges), [recordingRanges]);
  const buffered = useMemo(() => normalizeRanges(bufferedRanges), [bufferedRanges]);

  return (
    <View style={[styles.container, style]}>
      <View style={styles.controlsRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous event"
          style={styles.navButton}
          onPress={() => jumpToAdjacentEvent(-1)}
        >
          <Text style={styles.navButtonText}>Prev</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next event"
          style={styles.navButton}
          onPress={() => jumpToAdjacentEvent(1)}
        >
          <Text style={styles.navButtonText}>Next</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={composed}>
        <Animated.View style={styles.timelineRoot} onLayout={onLayout}>
          <View style={styles.track}>
            {recording.map((range, idx) => {
              const bar = rangeToStyle(range, localViewport);
              return <View key={`rec-${idx}`} style={[styles.recordingBar, bar]} />;
            })}
            {buffered.map((range, idx) => {
              const bar = rangeToStyle(range, localViewport);
              return <View key={`buf-${idx}`} style={[styles.bufferedBar, bar]} />;
            })}
            {clusteredEvents.map((event) => {
              const x = tsToX(event.tsMs, localViewport);
              return (
                <View
                  key={event.id}
                  accessibilityRole="text"
                  accessibilityLabel={`${event.type} event at ${formatHMS(event.tsMs)}`}
                  style={[
                    styles.eventTick,
                    {
                      left: x,
                      backgroundColor: EVENT_COLORS[event.type],
                      height: 8 + (event.severity ?? 1) * 3,
                    },
                  ]}
                />
              );
            })}
          </View>

          <Animated.View style={[styles.playheadWrap, playheadStyle]}>
            <View style={styles.playheadLine} />
            <View style={styles.playheadHandle} />
          </Animated.View>

          {controller.isScrubbing && (
            <View style={styles.tooltip} pointerEvents="none">
              <Text style={styles.tooltipText}>{formatHMS(controller.shared.playheadMsSV.value)}</Text>
              {previewUri ? <Text style={styles.tooltipSub}>{previewUri}</Text> : null}
            </View>
          )}
        </Animated.View>
      </GestureDetector>

      <View style={styles.footerRow}>
        <Text style={styles.timeLabel}>{formatHMS(startMs)}</Text>
        <Text style={styles.timeLabel}>{formatHMS(controller.shared.playheadMsSV.value)}</Text>
        <Text style={styles.timeLabel}>{formatHMS(endMs)}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  controlsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  navButton: {
    minHeight: 40,
    minWidth: 80,
    paddingHorizontal: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1F2937',
  },
  navButtonText: {
    color: '#FFF',
    fontWeight: '600',
  },
  timelineRoot: {
    minHeight: 84,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111827',
    justifyContent: 'center',
  },
  track: {
    marginHorizontal: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#374151',
    overflow: 'hidden',
  },
  recordingBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: '#2563EB',
  },
  bufferedBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: '#93C5FD',
    opacity: 0.6,
  },
  eventTick: {
    position: 'absolute',
    width: 2,
    bottom: -10,
    borderRadius: 2,
  },
  playheadWrap: {
    position: 'absolute',
    top: 10,
    bottom: 10,
    width: 0,
  },
  playheadLine: {
    width: 2,
    flex: 1,
    marginLeft: -1,
    backgroundColor: '#F9FAFB',
  },
  playheadHandle: {
    width: 18,
    height: 18,
    marginLeft: -9,
    marginTop: -2,
    borderRadius: 9,
    backgroundColor: '#F9FAFB',
  },
  tooltip: {
    position: 'absolute',
    top: 6,
    left: 14,
    right: 14,
    alignItems: 'center',
  },
  tooltipText: {
    color: '#FFF',
    fontWeight: '700',
  },
  tooltipSub: {
    color: '#D1D5DB',
    fontSize: 11,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeLabel: {
    color: '#374151',
    fontSize: 12,
  },
});
