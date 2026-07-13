# Evidence-based age guidance design

**Date:** 2026-07-13  
**Release target:** 0.3.9  
**Languages/platforms:** Korean and Japanese; macOS and Windows

## Purpose

Replace Baby Diary's embedded infant-care claims with conservative, actionable guidance backed by public-health agencies and clinical guidelines. The app must show what matters at the child's current age without turning population-level ranges into personal targets or pretending to diagnose an individual child.

## Authority hierarchy

1. Country-specific public authorities: Korea Disease Control and Prevention Agency (KDCA), Japan Children and Families Agency (CFA), and Japan Ministry of Health, Labour and Welfare (MHLW).
2. Global public-health and clinical guideline bodies: WHO, CDC, NIH/NICHD, and NICE.
3. Professional consensus documents only where the public authorities do not cover the topic, primarily the American Academy of Pediatrics (AAP).
4. Primary trials may explain the origin of a guideline but are not used for promotional risk-reduction percentages in parent-facing copy.

Commercial parenting sites, uncited precise schedules, and claims that cannot be linked to an official primary source are removed. Every displayed guidance item has one or more stable source IDs, an official URL, the issuing organisation, publication title, and a review date.

## Content principles

- Use plain actions: what to do now, what to avoid, and when to get help.
- Use age only as a routing aid. Hunger, fullness, readiness, growth trajectory, prematurity, and clinician plans override generic timing.
- Never describe a feeding range as a quota, daily allowance, maximum to enforce, or amount remaining.
- Never predict a next breastfeeding time for an older infant. Responsive feeding and the child's cues are the default.
- Do not provide medicine doses. Fever advice routes risk and lists emergency signs; it does not diagnose.
- Country-dependent schedules such as vaccination are linked to the live Korean or Japanese authority page instead of copied into the app.
- Developmental milestones are checkpoints, not pass/fail tests. Loss of a previously acquired skill or caregiver concern always prompts early professional discussion.
- Corrected age and the child's clinical plan apply to preterm infants and children with medical conditions.

## Source registry

The typed source registry will include, at minimum:

- WHO infant and young child feeding fact sheet and complementary-feeding guideline
- WHO physical activity, sedentary behaviour, and sleep guideline for children under 5
- CDC infant/toddler nutrition pages for responsive feeding, complementary foods, iron, choking, and foods to avoid
- CDC Learn the Signs. Act Early developmental milestone resources
- NICHD Safe to Sleep guidance
- AAP 2022 safe-sleep policy statement
- NICE NG143 fever in under-5s and NICE NG194 newborn red flags
- KDCA infant/toddler nutrition, national infant check-up, and vaccination-assistant pages
- Japan CFA safe-sleep, infant nutrition/weaning, accident-prevention, and infant check-up pages
- Japan MHLW vaccination information

Sources open in the system browser through a narrow Electron IPC bridge that accepts only `https:` URLs on the registry's explicit authority-host allowlist. Browser development mode may use `window.open` with `noopener,noreferrer`. The guidance remains useful without an internet connection because the concise action text is bundled with the app.

## Age routing

Age is calculated in completed days from the stored birthdate. Boundary behaviour is deterministic and covered by tests.

| Stage | Age window | First priorities |
|---|---:|---|
| Newborn | 0–27 days | responsive milk feeding and intake concerns; safe sleep; fever/newborn danger signs; supervised awake floor time; local newborn check-up |
| Young infant | 28–89 days | responsive feeding; safe sleep; supervised tummy time; 2-month developmental observation and current vaccination/check-up link |
| 3–5 months | 90–181 days | safe sleep; active floor play; complementary-food readiness near 6 months, never before 4 months; age-aware fever threshold |
| 6–8 months | 182–273 days | breast milk/formula remains central; 2–3 complementary meals with iron-rich variety; allergen and choking safety; no honey/cow's milk as a drink/juice; oral care |
| 9–11 months | 274–364 days | texture and self-feeding progression; 3–4 meals with optional snacks as needed; 9-month developmental check; choking and safe sleep |
| 12–17 months | 365–547 days | varied family foods and responsive meals; continued breastfeeding if desired; safe activity/sleep; dental care and local check-up/vaccine link |
| 18–23 months | 548–729 days | 18-month developmental screening and act-early signs; at least 180 minutes of varied activity; no routine screen time; family meals and oral care |
| 2 years | 730–1094 days | language/social development; active play; screen time no more than 1 hour and less is better; 11–14 hours sleep; balanced family foods and dental care |
| 3–4 years | 1095–1825 days | developmental checkpoints; at least 180 minutes activity including 60 minutes energetic play; screen time no more than 1 hour; 10–13 hours sleep; injury prevention |
| 5+ years | 1826+ days | the infant/toddler guide retires to a general safety/check-up card and directs caregivers to local paediatric guidance rather than extrapolating infant claims |

The visible UI shows at most three priority cards. A `more` disclosure reveals remaining age-relevant categories. Emergency signs and official-source access remain available regardless of the stage.

## Guidance categories and required actions

### Safe sleep and activity

- Put infants on their back for every sleep until age 1.
- Use a firm, flat, non-inclined separate infant sleep surface with only a fitted sheet; keep soft objects and loose bedding out.
- Room-share, without bed-sharing, ideally for at least the first 6 months.
- Start supervised awake tummy/floor time early; sleep always returns to the back position.
- Apply WHO age-appropriate activity, restraint, screen, and sleep guidance without presenting sleep hours as a performance score.

### Feeding and nutrition

- Breastfeeding and formula guidance follows hunger/fullness cues and growth, not a countdown clock or forced target.
- Early newborn copy may state that feeding is often frequent and that a sleepy newborn or poor intake needs an individual clinician plan; it must not claim one universal wake schedule.
- Complementary foods start around 6 months when readiness signs are present and never before 4 months.
- From 6 months, include iron-rich foods and varied textures; continue breast milk or formula through 12 months.
- Offer allergens in safe, age-appropriate forms with other foods; severe eczema or egg allergy requires clinician advice before peanut introduction.
- Before 12 months: no honey, no cow's milk as the main drink, and no juice. Avoid unpasteurised food and choking shapes; no added sugar under age 2.
- Vitamin D and iron are framed as clinician/local-policy questions because supplementation differs by feeding pattern, prematurity, product intake, and country.

### Fever and urgent care

`evaluateFever` routes recorded temperature conservatively:

- Under 3 months and 38.0°C or higher: urgent same-day/emergency assessment.
- 3–6 months and 39.0°C or higher: high-risk warning for prompt assessment.
- Older than 6 months: temperature height alone does not determine serious illness; symptoms and red flags drive urgency.
- Any age: pale/blue/mottled colour, difficult or grunting breathing, marked drowsiness or poor response, non-blanching rash, seizure, stiff neck or bulging fontanelle, severe dehydration, or bilious/projectile vomiting prompts emergency help.
- Fever lasting 5 days or longer needs medical assessment; worsening, caregiver concern, poor drinking, or dehydration warrants earlier advice.
- Remove tepid sponging. Avoid underdressing or over-wrapping. Offer fluids.
- Antipyretics are for distress, not merely to lower the number. The app gives no dose and tells caregivers to follow the label and clinician/pharmacist advice; a child under 3 months is assessed first.

Temperature measurement site is not stored, so the UI must not claim that a recorded value is rectal.

### Development, check-ups, vaccination, and oral health

- Surface only the current CDC checkpoint and a short observation prompt; never mark a child delayed from app data.
- If a skill is lost or the caregiver is concerned, advise speaking to a clinician promptly rather than waiting for the next check-up.
- Link Korean users to KDCA check-up/vaccination pages and Japanese users to CFA/MHLW pages.
- From the first tooth, begin age-appropriate brushing; recommend a dental visit by the first birthday, with fluoride details left to local dental advice where national recommendations differ.

## UI behaviour

### Home

Replace the single formula-focused guidance row with `지금 필요한 것 / 今必要なこと`:

- shows the child's age-stage label and no more than three priority summaries;
- each summary expands in place to action text and sources;
- `more` reveals the rest without navigating away;
- if birthdate is missing, one calm setup prompt is shown instead of generic age assumptions.

### Settings

Replace the 13-item mixed evidence accordion and the fixed breastfeeding interval table with one evidence centre:

- current-stage items first;
- category filter or grouped disclosure for all reference items;
- official-source links and `reviewed 2026-07-13` metadata;
- a concise disclaimer explaining individual variation, prematurity/corrected age, and emergencies.

### Post-record feedback

- Formula: confirm recorded amount and daily logged total/count, then show hunger/fullness cues. No `remaining`, enforced cap, or red warning caused solely by total volume.
- Breastfeeding: confirm count/side and elapsed time only; do not calculate a recommended next feed window.
- Fever: use structured red-flag arrays so Korean/Japanese punctuation cannot change medical logic.

The visual patch reuses the existing premium card language, restrained motion, and progressive disclosure. It must respect `prefers-reduced-motion` and remain keyboard/screen-reader accessible.

## Data and compatibility

- No event, profile, family-code, login, or sync schema changes.
- Guidance is static versioned content and is never synced as user data.
- Existing diary records and statistics remain unchanged.
- macOS and Windows use the same React/TypeScript path. A new typed `openEvidenceSource` bridge validates the URL again in the main process before calling `shell.openExternal`; arbitrary renderer-supplied URLs are rejected.

## Acceptance criteria

1. Every parent-facing medical/nutrition/development claim in the guidance flow maps to an official source ID.
2. No commercial parenting source remains in the guidance source registry or visible copy.
3. Age boundaries, missing/invalid birthdates, preterm caveats, and 5+ fallback are unit-tested.
4. Fever tests cover under 3 months, 3–6 months, over 6 months, unknown age, red flags, and the removal of tepid sponging.
5. Feeding tests prove there is no daily `remaining/max` warning and no next-feed prediction.
6. Korean and Japanese key parity and source-link validity are tested.
7. The home panel never shows more than three priority cards before expansion.
8. Typecheck, unit tests, production build, Windows packaged E2E, and macOS packaged CI all pass.
