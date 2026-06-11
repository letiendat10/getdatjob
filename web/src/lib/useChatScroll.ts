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
 * - LIGHT content (text bubbles, scan checklist, streamed tokens): stick to the
 *   bottom while the user is already there; never move them once they've
 *   scrolled up (the pill appears instead).
 * - HEAVY content (a message carrying job cards, or an active heavy block like
 *   the paywall): scroll ONCE so the top of the block lands at the top of the
 *   viewport, then stop following — the user reads down at their own pace. If
 *   they had scrolled away, don't move them; the pill's first tap then lands at
 *   the TOP of the heavy block (a second tap goes to the bottom).
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
  opts?: { followKey?: unknown; heavyBlock?: HeavyBlock | null },
) {
  const [showJump, setShowJump] = useState(false);

  const pinnedRef = useRef(true);
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
    if (pinnedRef.current) jumpTargetRef.current = null;
    setShowJump(below > AT_BOTTOM_PX);
  }, [threadRef]);

  const onScroll = useCallback(() => { syncFromGeometry(); }, [syncFromGeometry]);

  // LIGHT content: keep the bottom in view, but only if the user was already
  // there. Runs synchronously from the post-commit effect, so the DOM is
  // current; any user scroll-up dispatched its scroll event (and unpinned us)
  // before this commit.
  const follow = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!pinnedRef.current) { syncFromGeometry(); return; }
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

  const notifyHeavy = useCallback((id: string) => {
    if (pinnedRef.current) {
      jumpTargetRef.current = null;
      anchorTo(id);
    } else {
      jumpTargetRef.current = id;
      setShowJump(true);
    }
  }, [anchorTo]);

  // Pill onClick: first stop is the top of any unseen heavy block, then bottom.
  const jumpToLatest = useCallback(() => {
    const target = jumpTargetRef.current;
    if (target) {
      jumpTargetRef.current = null;
      anchorTo(target);
      return;
    }
    revealLatest();
  }, [anchorTo, revealLatest]);

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

    if (blockActivated && heavyBlock) {
      // Outranks bulk: a session restored AT the paywall anchors its top
      // instead of dumping the user at the pricing block's bottom.
      notifyHeavy(heavyBlock.id);
    } else if (bulk) {
      revealLatest();
    } else if (newHeavyMsg && last) {
      notifyHeavy(last.id);
    } else if (newUser) {
      revealLatest();
    } else {
      follow();
    }
    // heavyBlock/opts identities churn every render; only their primitive
    // signals should retrigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, followKey, heavyBlock?.active]);

  return { onScroll, jumpToLatest, showJump };
}
