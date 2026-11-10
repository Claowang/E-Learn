import { addDays, addMinutes, nowIso } from './util.js';

/**
 * Scheduler in the spirit of Anki's default deck options: short learning steps first,
 * SM-2 style ease/interval growth once a word graduates to review.
 *
 * ratings: 1 = again, 2 = hard, 3 = good, 4 = easy
 */
export function schedule(state, rating, cfg, { now = new Date() } = {}) {
  const current = {
    state: state?.state || 'new',
    step: state?.step ?? 0,
    interval_days: state?.interval_days ?? 0,
    ease: state?.ease ?? 2.5,
    reps: state?.reps ?? 0,
    lapses: state?.lapses ?? 0
  };

  const learningSteps = cfg.learningSteps?.length ? cfg.learningSteps : [1, 10];
  const relearnSteps = cfg.relearnSteps?.length ? cfg.relearnSteps : [10];
  const minEase = cfg.minEase ?? 1.3;
  const maxInterval = cfg.maxIntervalDays ?? 3650;

  const next = { ...current, reps: current.reps + 1, due_at: null, last_review_at: now.toISOString() };
  const clampInterval = (days) => Math.min(maxInterval, Math.max(0, days));

  switch (current.state) {
    case 'new': {
      if (rating === 1) {
        next.state = 'learning';
        next.step = 0;
        next.due_at = addMinutes(now, learningSteps[0]).toISOString();
      } else if (rating === 2) {
        next.state = 'learning';
        next.step = 0;
        next.due_at = addMinutes(now, Math.round(learningSteps[0] * 1.5)).toISOString();
      } else if (rating === 3) {
        next.state = 'learning';
        next.step = 1;
        const minutes = learningSteps[1] ?? Math.round(learningSteps[0] * 6);
        next.due_at = addMinutes(now, minutes).toISOString();
      } else {
        next.state = 'review';
        next.step = 0;
        next.ease = Math.min(3.5, current.ease + 0.15);
        next.interval_days = clampInterval(cfg.easyInterval ?? 4);
        next.due_at = addDays(now, next.interval_days).toISOString();
      }
      break;
    }

    case 'learning':
    case 'relearning': {
      const steps = current.state === 'learning' ? learningSteps : relearnSteps;
      if (rating === 1) {
        next.step = 0;
        next.due_at = addMinutes(now, steps[0]).toISOString();
      } else if (rating === 2) {
        const minutes = steps[current.step] ?? steps[steps.length - 1];
        next.due_at = addMinutes(now, Math.round(minutes * 1.5)).toISOString();
      } else if (rating === 3) {
        const step = current.step + 1;
        if (step >= steps.length) {
          next.state = 'review';
          next.step = 0;
          const base =
            current.state === 'relearning'
              ? Math.max(cfg.graduatingInterval ?? 1, current.interval_days * 0.5)
              : cfg.graduatingInterval ?? 1;
          next.interval_days = clampInterval(base);
          next.due_at = addDays(now, next.interval_days).toISOString();
        } else {
          next.step = step;
          next.due_at = addMinutes(now, steps[step]).toISOString();
        }
      } else {
        next.state = 'review';
        next.step = 0;
        next.ease = Math.min(3.5, current.ease + 0.15);
        next.interval_days = clampInterval(
          current.state === 'relearning'
            ? Math.max(cfg.easyInterval ?? 4, current.interval_days)
            : cfg.easyInterval ?? 4
        );
        next.due_at = addDays(now, next.interval_days).toISOString();
      }
      break;
    }

    case 'review': {
      if (rating === 1) {
        next.state = 'relearning';
        next.step = 0;
        next.lapses = current.lapses + 1;
        next.ease = Math.max(minEase, current.ease - 0.2);
        next.due_at = addMinutes(now, relearnSteps[0]).toISOString();
      } else if (rating === 2) {
        next.ease = Math.max(minEase, current.ease - 0.15);
        next.interval_days = clampInterval(Math.max(1, current.interval_days * 1.2));
        next.due_at = addDays(now, next.interval_days).toISOString();
      } else if (rating === 3) {
        next.interval_days = clampInterval(Math.max(1, current.interval_days * current.ease));
        next.due_at = addDays(now, next.interval_days).toISOString();
      } else {
        next.ease = Math.min(3.5, current.ease + 0.15);
        next.interval_days = clampInterval(
          Math.max(1, current.interval_days * current.ease * 1.3)
        );
        next.due_at = addDays(now, next.interval_days).toISOString();
      }
      break;
    }

    default: {
      next.state = 'learning';
      next.step = 0;
      next.due_at = addMinutes(now, learningSteps[0]).toISOString();
    }
  }

  next.updated_at = nowIso();
  return next;
}

/** Human readable preview of what each rating button would do, shown on the review screen. */
export function previewIntervals(state, cfg, now = new Date()) {
  const out = {};
  for (const rating of [1, 2, 3, 4]) {
    const result = schedule(state, rating, cfg, { now });
    const due = new Date(result.due_at);
    const minutes = Math.max(0, (due.getTime() - now.getTime()) / 60000);
    out[rating] = minutes < 60
      ? `${Math.max(1, Math.round(minutes))} 分钟`
      : minutes < 60 * 36
        ? `${(minutes / 60).toFixed(1)} 小时`
        : `${Math.round(minutes / 1440)} 天`;
  }
  return out;
}
