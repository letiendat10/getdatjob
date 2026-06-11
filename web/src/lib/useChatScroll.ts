"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// Within this of the absolute bottom, the view counts as "at the bottom".
const AT_BOTTOM_PX = 32;

// The fields the hook needs off a chat message; both pages' ChatMessage types
// satisfy this structurally.
export interface ScrollMessage {
  id: string;
  role: "user" | "assistant";
  jobs?: readonly unknown[];
  isThinking?: boolean;
}

// A heavy block rendered OUTSIDE the messages array (e.g. the paywall step
// block). `id` must match the data-mid attribute on the block's wrapper.
export interface HeavyBlock {
  id: string;
  active: boolean;
}

/**
 * Scroll behavior for the Kai chat thread — shared by `/kai` and the `/me` Chat
 * tab so the two surfaces can't drift. Owns ALL scroll decisions; callers pass
 * `messages` (plus optional extras) and render the pill.
 *
 * Hybrid model:
 * - LIGHT content (text bubbles, scan checklist, streamed tokens):
 *   followMode "always" (onboarding): every light arrival scrolls to the
 *   bottom — the flow is scripted and the user just acted, so the pill should
 *   never appear for plain bubbles.
 *   followMode "pinned" (free chat): stick to the bottom only while the user
 *   is already there; never move them once they've scrolled up (pill instead).
 * - HEAVY content (a message carrying job cards, or an active heavy block like
 *   the paywall): NEVER moves the view — the user keeps their place in the
 *   conversation and the pill invites them down (first tap lands at the START
 *   of the new block, second at the bottom). Light follow is suspended (even
 *   in "always" mode) until the user reaches the bottom themselves, so nothing
 *   yanks them past unread cards. If the user's own message landed in the same
 *   commit (e.g. a chip tap that opens the paywall), that message is pinned to
 *   the top of the viewport so their action stays visible.
 * - The user's OWN message always scrolls into view — sending re-pins.
 *
 * Pinnedness is sampled from scroll events, not from post-append geometry, so
 * new content landing below the fold can't be mistaken for the user having
 * scrolled away. Scrolls are instant (`behavior: "instant"`) so the thread's
 * CSS `scroll-behavior: smooth` doesn't queue laggy animations during
 * streaming.
 */
export function useChatScroll(
  threadRef: RefObject<HTMLDivElement | null>,
  messages: readonly ScrollMessage[],
  opts?: {
    followKey?: unknown;
    heavyBlock?: HeavyBlock | null;
    followMode?: "pinned" | "always";
  },
) {
  const [showJump, setShowJump] = useState(false);

  const pinnedRef = useRef(true);
  // True from a heavy anchor until the user reaches the bottom themselves —
  // suspends light follow so nothing yanks them off the cards/paywall.
  const anchorHoldRef = useRef(false);
  const modeRef = useRef<"pinned" | "always">("pinned");
  useEffect(() => {
    modeRef.current = opts?.followMode ?? "pinned";
  });

  const seenIdsRef = useRef<Set<string>>(new Set());
  const heavyDoneRef = useRef<Set<string>>(new Set());
  const heavyBlockDoneRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(null);
  // When set, the pill jumps to this anchor (top of unseen heavy content)
  // instead of the thread bottom.
  const jumpTargetRef = useRef<string | null>(null);

  // Recompute pinnedness + pill from current geometry. Only safe to call when
  // the geometry reflects a position the user (or a finished programmatic
  // scroll) chose — not right after an append.
  const syncFromGeometry = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = below <= AT_BOTTOM_PX;
    if (pinnedRef.current) {
      jumpTargetRef.current = null;
      anchorHoldRef.current = false; // reached the bottom = hold released
    }
    setShowJump(below > AT_BOTTOM_PX);
  }, [threadRef]);

  const onScroll = useCallback(() => { syncFromGeometry(); }, [syncFromGeometry]);

  // LIGHT content. "always" mode scrolls to the bottom unconditionally (unless
  // a heavy anchor holds the view); "pinned" mode only when the user was
  // already at the bottom. Runs synchronously from the post-commit effect, so
  // the DOM is current; any user scroll-up dispatched its scroll event (and
  // unpinned us) before this commit.
  const follow = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    if (anchorHoldRef.current) { syncFromGeometry(); return; }
    if (!pinnedRef.current && modeRef.current !== "always") { syncFromGeometry(); return; }
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    syncFromGeometry();
  }, [threadRef, syncFromGeometry]);

  // The user's own message or a freshly restored thread: jump to the bottom.
  // Sending is an explicit intent, so this re-pins even after a scroll-up.
  const revealLatest = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    pinnedRef.current = true;
    anchorHoldRef.current = false;
    jumpTargetRef.current = null;
    setShowJump(false);
  }, [threadRef]);

  // HEAVY content: bring the TOP of the block to the top of the viewport
  // (scroll-margin-top on .msg-anchor leaves the gap below the nav), then
  // re-measure — a tall block leaves the bottom below the fold, which unpins
  // and shows the pill; a short one stays pinned and keeps following.
  const anchorTo = useCallback((id: string) => {
    const el = threadRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-mid="${id}"]`);
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "instant" });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    }
    syncFromGeometry();
  }, [threadRef, syncFromGeometry]);

  // HEAVY content: never move the view — the user keeps their place and the
  // pill invites them down. `revealFromId` (the user's own message when it
  // landed in the same commit) is pinned to the viewport top first so their
  // action stays visible. syncFromGeometry shows the pill only if the new
  // content actually extends below the fold (and releases the hold if not).
  const notifyHeavy = useCallback((id: string, revealFromId?: string | null) => {
    anchorHoldRef.current = true;
    jumpTargetRef.current = id;
    if (revealFromId) anchorTo(revealFromId);
    else syncFromGeometry();
  }, [anchorTo, syncFromGeometry]);

  // Pill onClick: first stop is the start of any unseen heavy block (only if
  // the user hasn't already scrolled to/past it), then the bottom.
  const jumpToLatest = useCallback(() => {
    const el = threadRef.current;
    const targetId = jumpTargetRef.current;
    if (el && targetId) {
      jumpTargetRef.current = null;
      const target = el.querySelector(`[data-mid="${targetId}"]`);
      if (target && target.getBoundingClientRect().top - el.getBoundingClientRect().top > 8) {
        target.scrollIntoView({ block: "start", behavior: "instant" });
        syncFromGeometry();
        return;
      }
    }
    revealLatest();
  }, [threadRef, syncFromGeometry, revealLatest]);

  const heavyBlock = opts?.heavyBlock ?? null;
  const followKey = opts?.followKey;

  useEffect(() => {
    // Re-arm the heavy block when it deactivates, so re-entering (e.g. coming
    // back to the paywall) anchors again.
    if (heavyBlock && !heavyBlock.active && heavyBlockDoneRef.current === heavyBlock.id) {
      heavyBlockDoneRef.current = null;
    }

    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    // First non-empty commit with multiple messages = a restored/fetched
    // thread, not live conversation.
    const bulk = seenIdsRef.current.size === 0 && messages.length > 1;

    let lastUserId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserId = messages[i].id; break; }
    }
    const newUser = lastUserId !== null && lastUserId !== lastUserIdRef.current;

    // The !isThinking guard is load-bearing: the jobs SSE event lands while the
    // message still renders as a thinking bubble WITHOUT its data-mid wrapper,
    // so anchoring must wait for the commit where the cards (and anchor) exist.
    const newHeavyMsg =
      !!last &&
      last.role === "assistant" &&
      !last.isThinking &&
      (last.jobs?.length ?? 0) > 0 &&
      !heavyDoneRef.current.has(last.id);

    const blockActivated =
      !!heavyBlock?.active && heavyBlockDoneRef.current !== heavyBlock.id;

    // Bookkeeping before acting, so no branch can skip it.
    for (const m of messages) {
      seenIdsRef.current.add(m.id);
      // On a bulk load every heavy message is old news — never anchor to it.
      if (bulk && (m.jobs?.length ?? 0) > 0) heavyDoneRef.current.add(m.id);
    }
    lastUserIdRef.current = lastUserId;
    if (newHeavyMsg && last) heavyDoneRef.current.add(last.id);
    if (blockActivated && heavyBlock) heavyBlockDoneRef.current = heavyBlock.id;

    if (bulk) {
      if (blockActivated && heavyBlock) {
        // Fresh load resting at the paywall: open AT it — there is no prior
        // reading position to preserve on a reload.
        anchorHoldRef.current = true;
        jumpTargetRef.current = null;
        anchorTo(heavyBlock.id);
      } else {
        revealLatest();
      }
    } else if (blockActivated && heavyBlock) {
      notifyHeavy(heavyBlock.id, newUser ? lastUserId : null);
    } else if (newHeavyMsg && last) {
      notifyHeavy(last.id, newUser ? lastUserId : null);
    } else if (newUser) {
      revealLatest();
    } else {
      follow();
    }
    // heavyBlock/opts identities churn every render; only their primitive
    // signals should retrigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, followKey, heavyBlock?.active]);

  // Content can change height OUTSIDE a React commit (late-loading images,
  // fonts, entrance animations). Re-stick / re-sync the pill when that happens
  // so the view never silently ends up mid-thread with stale pill state.
  // Pinned-only, NEVER a force: only commit-driven follow may pull a
  // scrolled-up user down ("new content arrived"); a resize while the user is
  // away from the bottom must not fight their scrolling.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!anchorHoldRef.current && pinnedRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
      syncFromGeometry();
    });
    ro.observe(el.firstElementChild ?? el);
    return () => ro.disconnect();
  }, [threadRef, syncFromGeometry]);

  return { onScroll, jumpToLatest, showJump };
}
