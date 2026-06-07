"use client";

import { useCallback, useState, type RefObject } from "react";

// Within this of the absolute bottom, the view counts as "at the bottom".
const AT_BOTTOM_PX = 32;

/**
 * Scroll behavior for the Kai chat thread — shared by `/kai` and the `/me` Chat
 * tab so the two surfaces can't drift.
 *
 * The ChatGPT pattern: the view does NOT auto-scroll when Kai's content arrives —
 * it stays where it is, and a "scroll to latest" pill appears whenever the bottom
 * of the thread is below the fold. The only auto-scroll is to reveal the user's
 * OWN just-sent message; from there the user scrolls (or taps the pill) to read
 * the rest at their own pace.
 *
 * - `pinToTop(id)` — the user sent/tapped a message: scroll just enough to reveal
 *   it (then the view is left alone).
 * - `followIfPinned()` — on each assistant message/token: never scrolls; only
 *   refreshes the pill.
 * - `onScroll` — keeps the pill in sync as the user scrolls.
 * - `jumpToBottom()` — the pill's onClick: jump to the latest and hide the pill.
 * - `showJump` — drives the "new messages ↓" pill (visible whenever the bottom of
 *   the thread sits below the fold).
 *
 * Scrolls are instant (`behavior: "instant"`) so the thread's CSS
 * `scroll-behavior: smooth` doesn't swallow them.
 */
export function useChatScroll(threadRef: RefObject<HTMLDivElement | null>) {
  const [showJump, setShowJump] = useState(false);

  const syncPill = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > AT_BOTTOM_PX);
  }, [threadRef]);

  const onScroll = useCallback(() => { syncPill(); }, [syncPill]);

  const jumpToBottom = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    setShowJump(false);
  }, [threadRef]);

  // Assistant content: never auto-scroll — just keep the pill in sync so the user
  // can choose to jump to it.
  const followIfPinned = useCallback(() => { syncPill(); }, [syncPill]);

  // The user's own message: scroll to reveal it (it's the latest content at this
  // point), then leave the view be.
  const pinToTop = useCallback(
    (_id: string) => {
      const el = threadRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      setShowJump(false);
    },
    [threadRef],
  );

  return { onScroll, followIfPinned, pinToTop, jumpToBottom, showJump };
}
