import React, { useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet, Switch, Text, View } from 'react-native';
import { EventType, PlaybackScrubber, ScrubberEvent, ScrubberRange } from './PlaybackScrubber';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = NOW - DAY_MS;
const END_MS = NOW;

const makeRanges = (): ScrubberRange[] => [
  { startMs: START_MS + 5 * 60_000, endMs: START_MS + 8 * 60 * 60_000 },
  { startMs: START_MS + 9 * 60 * 60_000, endMs: START_MS + 17 * 60 * 60_000 },
  { startMs: START_MS + 18 * 60 * 60_000, endMs: END_MS - 3 * 60_000 },
];

const makeEvents = (): ScrubberEvent[] => {
  const out: ScrubberEvent[] = [];
  const types: EventType[] = ['motion', 'ai', 'audio', 'tamper', 'timelapse'];
  for (let i = 0; i < 500; i += 1) {
    const tsMs = START_MS + Math.floor((i / 500) * DAY_MS);
    out.push({
      id: `e-${i}`,
      tsMs,
      type: types[i % types.length],
      severity: ((i % 3) + 1) as 1 | 2 | 3,
    });
  }
  return out;
};

export const PlaybackScreen: React.FC = () => {
  const [currentMs, setCurrentMs] = useState(END_MS - 3_600_000);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomSeconds, setZoomSeconds] = useState(3600);
  const [showMotion, setShowMotion] = useState(true);

  const recordingRanges = useMemo(makeRanges, []);
  const bufferedRanges = useMemo(() => [{ startMs: currentMs - 5 * 60_000, endMs: currentMs + 2 * 60_000 }], [currentMs]);
  const events = useMemo(makeEvents, []);

  const activeFilter = useMemo(() => {
    const filter = new Set<EventType>(['ai', 'audio', 'tamper', 'timelapse']);
    if (showMotion) filter.add('motion');
    return filter;
  }, [showMotion]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headRow}>
        <Text style={styles.title}>CCTV Playback</Text>
        <View style={styles.switchRow}>
          <Text>Motion</Text>
          <Switch value={showMotion} onValueChange={setShowMotion} />
        </View>
      </View>

      <PlaybackScrubber
        startMs={START_MS}
        endMs={END_MS}
        currentMs={currentMs}
        isPlaying={isPlaying}
        recordingRanges={recordingRanges}
        bufferedRanges={bufferedRanges}
        events={events}
        zoomSeconds={zoomSeconds}
        onZoomChange={setZoomSeconds}
        eventFilter={activeFilter}
        onScrubStateChange={(scrubbing) => setIsPlaying(!scrubbing)}
        onSeekRequest={(tsMs) => {
          // this is where you'd call player.seek(tsMs)
          setCurrentMs(tsMs);
        }}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    padding: 16,
    gap: 16,
  },
  headRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
