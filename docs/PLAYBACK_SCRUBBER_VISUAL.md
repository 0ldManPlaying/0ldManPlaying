# Playback Scrubber – Visual Preview

Deze mock laat de beoogde visuele opbouw zien van de React Native `PlaybackScrubber`:

- recording bar + buffered overlay
- event ticks per type
- playhead line + handle
- tooltip tijdens scrubbing
- prev/next event controls

Gebruik `docs/playback-scrubber-visual.html` voor een lokale preview in de browser.

## Extra voorbeeld: event preview + icon-locatie variant

Open ook `docs/playback-scrubber-event-preview.html` voor:
- Variant A: hover op event marker toont image preview + event metadata.
- Variant B: icon-gebaseerde zonekaart die laat zien **waar** events plaatsvinden.

## Verrijkte variant (aanbevolen)

Gebruik `docs/playback-scrubber-event-preview.html` als primaire UX-richting:
- Hover/focus/tap event preview (ook keyboard-vriendelijk)
- Pin/unpin preview state
- Event filters per type
- Rijkere metadata (zone, severity, confidence, clip-duur)
- Icon gebaseerde locatiehint in combinatie met timeline

## Verticaal + histogram zoom (nieuw)

Open `docs/playback-scrubber-vertical-zoom.html`:
- Verticale tijdlijn
- Zoombereik van **14 uur overview** tot **1 seconde detail**
- Histogram per tijdblok voor event-dichtheid op lage zoom
- Auto-overgang naar individuele event-details op hoge zoom
