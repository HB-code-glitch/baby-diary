# Premium Tutorial V2 Design

## Goal

Replace the current dense ten-step tour with a concise, premium six-step tutorial that matches Baby Diary's warm paper-and-pastel design, is fully natural in Korean and Japanese, and can be skipped safely at any moment.

## Context and problems

The current tutorial already has a small skip control, but it sits separately at the lower-left edge of the window and is easy to miss. It moves through nearly every page, presents several facts in each step, has no previous-step control, estimates a fixed tooltip height that can clip longer Japanese copy, and treats completion and skipping as the same unversioned boolean. It also says data is always safe, which is too absolute for an onboarding message.

The component is 623 lines and mixes state persistence, step definitions, geometry, accessibility, rendering, and styling decisions. The redesign will split only the reusable state/model from the view; it will not rewrite the rest of the app.

## Considered approaches

### 1. Polish the existing ten-step coachmark tour

Lowest code risk, but it preserves the core information-overload problem and keeps sending the user through every page. Rejected.

### 2. Six-step essentials tour with contextual spotlight cards

Recommended. Keep the useful spotlight pattern, reduce the content to four essential concepts between a welcome and finish screen, and place skip/back/next inside one consistent card. This preserves the app's current visual language while improving comprehension and control.

### 3. Full-screen illustrated onboarding story

Visually dramatic, but it hides the real interface and requires new illustration assets. It teaches less effectively and adds avoidable package weight. Rejected.

## Experience structure

The tutorial contains exactly six steps:

1. **Welcome — centered:** one-minute expectation, replay reassurance, primary “Start” and secondary “Skip”.
2. **Quick record — Home:** spotlight the quick-record row. Explain only that one press records common care events and detailed inputs open when needed.
3. **Today at a glance — Home:** spotlight the hero/summary area. Explain that summaries appear progressively as records accumulate.
4. **Look back later — Navigation:** spotlight the sidebar navigation as a group. Introduce History, Stats, Diary, and Messages as optional destinations without visiting each page.
5. **Settings and family — Settings:** spotlight the settings/sync area. Explain baby information, language/theme, backup location, and optional family connection without promising infallible synchronization.
6. **Ready — centered:** tell the user the tutorial is available again in Settings and return to Home on completion.

The copy must use short paragraphs, at most two supporting lines per contextual step, and no medical or data-safety guarantees.

## Controls and state

- “Skip tutorial” is visible on the welcome screen and in the header of every subsequent card.
- `Escape` skips immediately. No confirmation dialog is added because Settings always offers replay.
- Contextual steps provide Back and Next. Welcome has Start; the final step has “Start recording”.
- When replay starts from Settings, skipping returns to Settings. A completed tour returns to Home.
- The state is versioned as tutorial version `2` and records `completed` or `skipped`. A v0.3.7 user who completed the old tutorial sees V2 once, then never automatically again for version 2.
- Malformed or unavailable localStorage never blocks the app. It may cause the tutorial to be offered again, but never marks it completed falsely.
- Background controls are inert while the tutorial is open. The spotlight is explanatory only; it must not permit accidental record creation through the cutout.

## Visual design

- Preserve the existing Plus Jakarta Sans/Pretendard/Zen Maru typography and warm cream, stone, amber, sage, and rose tokens.
- Use a warm elevated paper card with a subtle tinted shadow, 18–20px outer radius, tighter inner radii, one quiet category label, a 22–24px title, and restrained body copy.
- Add one small icon tile per step using icons already available in the project. No new dependency or image asset.
- Replace the detached bottom dots and skip pill with an integrated progress rail and actions inside the card.
- Light and dark modes use existing surface tokens. Avoid generic blue/purple gradients and excessive glass blur.
- At narrow widths or short heights, the card becomes a bottom sheet with safe viewport margins and a scrollable body. All actions remain visible at 720×560 and above.

## Motion system

- Card entrance: 240ms opacity plus 8px rise using the existing smooth ease-out token.
- Step content transition: 180ms opacity/translate, with the primary title appearing before supporting text.
- Spotlight ring: 260ms transform/opacity continuity between targets; no animated `top`, `left`, `width`, or `height` loops.
- Button hover/press: 140–180ms with a maximum 1px lift/press.
- Under `prefers-reduced-motion: reduce`, remove travel and spotlight morphing; content changes instantly and stays fully visible.

## Component boundaries

- `src/lib/tutorial.ts`: versioned storage contract, launch decision, six-step metadata, and pure helpers.
- `src/components/TutorialTour.tsx`: navigation orchestration, measurement, focus/keyboard control, inert background, and responsive placement.
- `src/components/TutorialCard.tsx`: semantic dialog content, integrated progress, icon, copy, and action controls.
- `src/index.css`: tutorial surfaces, responsive layout, motion tokens, focus states, and dark/reduced-motion variants.
- `src/App.tsx`: remember the page that launched replay and handle `completed` versus `skipped` exits.
- `src/i18n/ko.json` and `src/i18n/ja.json`: complete parallel copy for every visible label and step.

## Accessibility

- The card is a modal dialog with a labelled title and description.
- Focus moves into the card on each step and returns to the replay button or originating context when the tour closes.
- Tab focus cannot reach the app behind the overlay.
- All buttons have visible focus rings and at least a 40px hit area.
- Progress exposes “step N of 6” as localized text; decorative segments stay hidden from assistive technology.
- Escape, Enter, Left Arrow, and Right Arrow map to skip, next, previous, and next without overriding text inputs.
- Korean and Japanese copy must fit without clipping at 960×640, 1200×800, and the supported compact 720×560 test viewport.

## Verification

1. Pure tests cover version-2 launch rules, completed/skipped persistence, malformed storage, six-step ordering, and translation-key parity.
2. Packaged Electron E2E covers Korean first launch and skip, relaunch suppression, Settings replay, Japanese full completion with Back/Next, compact viewport overflow, keyboard Escape, and reduced motion.
3. Existing full checks, production build, and packaged E2E continue to pass on Windows and macOS CI.
4. Screenshots are captured for welcome, contextual spotlight, compact layout, dark mode, and Japanese copy review.

## Out of scope

- Changing the language picker itself.
- Adding analytics or remote tutorial state.
- Reworking application navigation or feature behavior.
- Claiming that synchronization or backups can never fail.
