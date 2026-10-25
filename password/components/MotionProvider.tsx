"use client";

import { MotionConfig } from "framer-motion";

/**
 * Respect the operating system's "reduce motion" setting for every animation in
 * the app.
 *
 * `reducedMotion="user"` makes framer-motion drop transform/layout animations
 * when `prefers-reduced-motion: reduce` is set, while keeping opacity changes so
 * state transitions stay perceivable. Without this the UI ignores the setting
 * entirely, which is one of the accessibility gaps recorded in
 * `.work/plans/20261025-personas-v1.md` §5.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
