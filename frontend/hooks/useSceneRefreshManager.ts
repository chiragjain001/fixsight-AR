import { useCallback, useRef } from 'react';
import { useWorkflowStore } from '../store/workflowStore';

// ── Types ───────────────────────────────────────────────────────────────────
export type IntentCategory = 'chat' | 'verify' | 'full_refresh' | 'control' | 'ignore' | 'plan_task';

export interface IntentResult {
  category: IntentCategory;
  controlAction?: 'next' | 'prev' | 'repeat';
  reason: string;
}

// ── Constants & Heuristics ──────────────────────────────────────────────────
const MIN_REFRESH_MS = 8000;  // 8s cooldown for manual refresh
const MIN_VERIFY_MS  = 4000;  // 4s cooldown for manual verify

// Basic heuristic regexes
const IGNORE_PATTERNS = [
  /^(um|uh|hmm|okay|ok|alright|yeah|yes|no)\.?$/i,
  /^what was that\?$/i,
];

const CONTROL_PATTERNS = [
  { pattern: /next step/i, action: 'next' as const },
  { pattern: /previous step|go back/i, action: 'prev' as const },
  { pattern: /repeat that|say that again/i, action: 'repeat' as const },
];

const RESCAN_PATTERNS = [
  /scan again/i,
  /look at this/i,
  /what is this/i,
];

const COMPLETION_PATTERNS = [
  /done/i,
  /finished/i,
  /completed/i,
  /removed it/i,
  /disconnected it/i,
  /that's done/i,
];

const TASK_PATTERNS = [
  /how do i/i,
  /how to/i,
  /how can i/i,
  /show me/i,
  /teach me/i,
  /guide me/i,
  /help me/i,
  /what should i do/i,
  /fix this/i,
  /repair/i,
  /step by step/i,
  /tell me what to do/i,
  /what is next/i,
  /what's next/i,
  /what do i do/i,
  /i need to/i,
];

// ── Hook ──────────────────────────────────────────────────────────────────────
export const useSceneRefreshManager = () => {
  const lastRefreshAt = useRef<number>(0);
  const lastVerifyAt  = useRef<number>(0);

  // ── 5-Way Intent Classifier ───────────────────────────────────────────────
  const analyzeIntent = useCallback((transcript: string): IntentResult => {
    const { sceneId } = useWorkflowStore.getState();
    const now = Date.now();

    // 1. IGNORE — short-circuit before anything else
    if (IGNORE_PATTERNS.some(p => p.test(transcript.trim()))) {
      return { category: 'ignore', reason: 'Filler or meta command — no action needed' };
    }

    // 2. CONTROL — direct store action, no LLM
    for (const { pattern, action } of CONTROL_PATTERNS) {
      if (pattern.test(transcript)) {
        return { category: 'control', controlAction: action, reason: `User said "${action}"` };
      }
    }

    // 3. FULL_REFRESH — camera changed (only if we have a prior scan)
    if (sceneId && RESCAN_PATTERNS.some(p => p.test(transcript))) {
      if (now - lastRefreshAt.current >= MIN_REFRESH_MS) {
        return { category: 'full_refresh', reason: 'User requested rescan' };
      }
    }

    // 4. VERIFY — user claims an action is done (only if we have a prior scan)
    if (sceneId && COMPLETION_PATTERNS.some(p => p.test(transcript))) {
      if (now - lastVerifyAt.current >= MIN_VERIFY_MS) {
        return { category: 'verify', reason: 'User signaled task completion' };
      }
    }
    
    // 5. PLAN TASK - User asked how to do something
    if (TASK_PATTERNS.some(p => p.test(transcript))) {
      return { category: 'plan_task', reason: 'User requested an interactive task guide' };
    }

    // 5. CHAT — default, goes to LLM
    return { category: 'chat', reason: 'General query' };
  }, []);

  return { analyzeIntent };
};
