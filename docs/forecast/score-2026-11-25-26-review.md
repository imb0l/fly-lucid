# Overnight review — 25/26 Nov results and 28 Nov test setup

## Scope

- 25 Nov board was frozen at 08:04 WAT, so only later departures are a live test.
- 26 Nov board was frozen before the full WAT day; it is the first complete day, but it was inspected during debugging and is therefore development/evaluation data, not an untouched holdout.
- Ground truth is the poller's `events` table, not FR24 history. Only legs with a recorded `DEP` carrying both `flt` and `dest` can be scored.

## Frozen-board results

| Day | Board legs | Scored legs | MAE | Median abs | Bias (actual − pred) | p10–p90 coverage | Mean width | MAE vs schedule |
|---|---|---|---|---|---|---|---|---|
| 25 Nov | 389 | 109 | 41.5 | 21.5 | +26 | 83% | 99 | 67.3 |
| 26 Nov | 413 | 94 | 52.4 | 17.3 | +40 | 70% | 96 | 80.4 |

26 Nov by method:

| Method | n | MAE | Median abs | Bias | Coverage | Width |
|---|---|---|---|---|---|---|
| blend | 57 | 38.8 | 13.8 | +24 | 75% | 82 |
| delay-prior | 37 | 73.3 | 21.8 | +65 | 62% | 118 |

The scored subset is not the board: 26 Nov scored 57/142 blend legs (40%) but only 37/271 delay-prior legs (14%), and 86% of scored legs were LOS/ABV. The 52.4 headline is an observable-subset result, not board-wide accuracy.

## Live `/api/search` snapshots

| Horizon | Day | Captured candidates | Scored | MAE | Median abs | Coverage | Width |
|---|---|---|---|---|---|---|---|
| T−120 | 25 Nov | 52 | 12 | 64.1 | 14.4 | 50% | 63 |
| T−60 | 25 Nov | 66 | 19 | 63.6 | 14.0 | 53% | 54 |
| T−120 | 26 Nov | 50 | 20 | 49.3 | 14.2 | 70% | 63 |
| T−60 | 26 Nov | 69 | 29 | 33.5 | 13.0 | 69% | 54 |

Paired on identical legs, live T−60 was worse than day-ahead by 9.4 min MAE (95% bootstrap CI −0.7 to +21.5). The failure was concentrated in unadjusted tails: T−60 unadjusted n=28 MAE 69.1, tail-adjusted n=20 MAE 12.2. The live model had no schedule-anchored delay prior and underpredicted when no tail link was available.

Capture completeness was also limited by user-session/reboot gaps: 25/26 Nov captured 336/341 rows out of 760 intended horizon windows. The snapshot window is now 30 min (was 10) to tolerate short interruptions; `captured_at_ts` preserves the true horizon.

## `safe_by` calibration

`P(actual < safe_by)` on 80 matched live snapshots was **3/80 = 3.75%** (Wilson 95% CI 1.3–10.5%). This is consistent with the intended ~5% early rate but does not establish it.

The structural defect was zero-width intervals: six matched tail-adjusted rows had `p10 = p50 = p90`, and two of those six departed before `safe_by`. A ±30 min epistemic band for floor-collapsed forecasts removes both observed misses in replay (2/6 → 0/6). All other zero-spread forecasts now retain a minimum ±12 min band rather than claiming zero uncertainty.

## Verified changes shipped overnight

1. **Slot before weekday:** schedule-slot clusters are selected from all days first; weekday/weekend preference is applied inside the selected cluster only when it has at least five samples. Fixes the QI522 17:45 query that previously anchored on the old 12:00 slot.
2. **Observed-only latest-residual prior:** for unadjusted candidates, shift p10/p50/p90 upward by 25% of the latest departure's residual, capped at 45 min; `safe_by` never moves earlier. On 25/26 Nov T−60 replay: unadjusted MAE 69.13 → 63.67; all matched 45.43 → 42.25; early count unchanged. Pre-registered for 28 Nov; not tuned further.
3. **Fresh-state tail-swap guard:** a fresh `aircraft_state` row for the target flight can replace the prior-day reg; a fresh row for the old reg carrying another flight blocks the floor; ambiguous multiple regs block the floor.
4. **Truthful API/UI:** `/api/live` filters on observation `ts` as well as write time; health exposes `lastPollOkTs`; flight history validates/normalizes flight numbers; data routes are `no-store`; UI shows p50, data age, stale-feed explanations, retry states, and accessible errors/focus.
5. **Watchlist/storage hardening:** canonical keys, validation, storage-error visibility, past-date cleanup, auto-refresh, and correct message placement.

## Rejected after measurement

- **Rolling schedule-derived delay pool:** no MAE gain; 26 Nov worsened. Removed from the board generator. The `sched_ts` backfill remains as diagnostics infrastructure only.
- **Low-sample pooled fallback:** raises coverage but interval calibration and bias do not transfer (26 Nov full-board low-sample MAE 78.9, coverage 61%). Not shipped.
- **Conformal interval compression:** live T−60 needs ~85 min at 80% coverage, not less than the current 54 min. Compression is not the current problem; point accuracy and logging are.
- **Event-chain/outstation readiness floors:** replay shows false floors and no reliable MAE gain. Not added.

## 28 Nov clean test

- `docs/forecast/board-2026-11-28.md`: 379-leg baseline frozen before first departure (contains the rejected rolling-pool experiment for comparison).
- `docs/forecast/board-2026-11-28-candidate.md`: 379-leg final candidate with harvest-only prior, slot fix, and minimum interval width.
- Live snapshots record the final product at T−120/T−60, including `safe_by`.
- `fly-lucid-score-28.timer` writes `docs/forecast/score-2026-11-28-auto.md` at 29 Nov 00:30 WAT.

## Verification

- Server: TypeScript build clean; **65/65 tests passing**.
- Web: TypeScript + Vite production build clean; FindPage visually checked in Chromium with p50, window, `safe_by`, and data age rendered.
- 8–17 Nov walk-forward after final changes: all-leg MAE **42.9**, blend MAE **29.8**, history-only MAE **30.1**, coverage **79%**, width **118.6**.
