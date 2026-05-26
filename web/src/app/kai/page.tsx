"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import s from "./kai.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

type Job = {
  id: number;
  title: string;
  company: string;
  company_domain: string | null;
  location: string | null;
  url: string | null;
  posted_at: string | null;
  visa_tier: string | null;
  salary_estimate: number | null;
  lca_count: number | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  jobs?: Job[];
  isStreaming?: boolean;
  isThinking?: boolean;
  isRateLimited?: boolean;
};

type Meta = {
  weekCount: number;
  totalCount: number;
  companies: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN ?? "";

const DOMAIN_OVERRIDES: Record<string, string> = { block: "block.xyz" };
function normalizeCompanyName(name: string): string {
  const cleaned = name
    .replace(/,?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc)\.?\s*$/i, "")
    .trim();
  const letters = cleaned.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return cleaned
      .split(/\s+/)
      .map((w) => (/^[A-Z]{1,4}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }
  return cleaned;
}
function companyDomain(name: string): string {
  const stem = normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return DOMAIN_OVERRIDES[stem] ?? stem + ".com";
}

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "server";
  const key = "gdj_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

function formatSalary(n: number): string {
  return "~$" + Math.round(n / 1000) + "K";
}

function timeAgo(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ── Inline markdown renderer (bold + newlines only) ──────────────────────────

function KaiText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part.split("\n").map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            {line}
            {j < arr.length - 1 && <br />}
          </span>
        ));
      })}
      {isStreaming && <span className={s.cursor} />}
    </>
  );
}

// ── Laurel leaf SVG ──────────────────────────────────────────────────────────

function LaurelSVG({ flip }: { flip?: boolean }) {
  return (
    <svg
      className={flip ? s["laurel-svg-flip"] : s["laurel-svg"]}
      viewBox="0 0 30 60"
      fill="currentColor"
      aria-hidden="true"
    >
      <ellipse cx="22" cy="54" rx="5.5" ry="2.2" transform="rotate(-35 22 54)" />
      <ellipse cx="16" cy="46" rx="6" ry="2.4" transform="rotate(-55 16 46)" />
      <ellipse cx="11" cy="36" rx="6.2" ry="2.5" transform="rotate(-75 11 36)" />
      <ellipse cx="9" cy="26" rx="6.2" ry="2.5" transform="rotate(-95 9 26)" />
      <ellipse cx="11" cy="16" rx="6" ry="2.4" transform="rotate(-115 11 16)" />
      <ellipse cx="17" cy="8" rx="5.5" ry="2.2" transform="rotate(-140 17 8)" />
    </svg>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CompanyAvatar({ name, domain }: { name: string; domain: string | null }) {
  const [imgError, setImgError] = useState(false);
  const resolved = domain || companyDomain(name);
  if (LOGO_DEV_TOKEN && !imgError) {
    return (
      <div className="w-10 h-10 rounded-lg flex-shrink-0 border border-zinc-100 bg-white overflow-hidden flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://img.logo.dev/${resolved}?token=${LOGO_DEV_TOKEN}&size=64&format=png&fallback=monogram`}
          alt={name}
          onError={() => setImgError(true)}
          className="w-full h-full object-contain p-0.5"
        />
      </div>
    );
  }
  return (
    <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-zinc-100 border border-zinc-100 flex items-center justify-center font-bold text-xs text-zinc-500 uppercase">
      {name.slice(0, 2)}
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const isVerified = job.visa_tier === "verified";
  const isFriendly = job.visa_tier === "friendly";
  const posted = timeAgo(job.posted_at);
  const displayCompany = normalizeCompanyName(job.company);

  return (
    <a
      href={job.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 px-4 py-4 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors no-underline"
    >
      <CompanyAvatar name={job.company} domain={job.company_domain} />
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold leading-snug text-zinc-900 group-hover:text-blue-600 transition-colors line-clamp-2">
          {job.title}
        </h3>
        <p className="text-xs text-zinc-500 mt-0.5 truncate">
          {displayCompany}{job.location ? ` · ${job.location}` : ""}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {job.salary_estimate && job.salary_estimate > 50000 && (
            <span className="text-xs text-zinc-600 bg-zinc-100 px-1.5 py-0.5 rounded">
              {formatSalary(job.salary_estimate)}
            </span>
          )}
          {isVerified && (
            <span
              className="inline-flex rounded-full p-[2px]"
              style={{ background: "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)" }}
            >
              <span className="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-zinc-900">
                Verified LCA Filings With Similar Job Title
              </span>
            </span>
          )}
          {isFriendly && (
            <span className="text-xs font-medium text-green-600">
              H-1B Friendly Employer
            </span>
          )}
          {posted && (
            <span className="text-xs text-zinc-400 ml-auto">{posted}</span>
          )}
        </div>
      </div>
    </a>
  );
}

function ThinkingBubble() {
  return (
    <div className={s["msg-row"]}>
      <div className={s["kai-avatar"]}>K</div>
      <div className={`${s.bubble} ${s["bubble-kai"]} ${s.thinking}`}>
        <span className={s.dot} />
        <span className={s.dot} />
        <span className={s.dot} />
      </div>
    </div>
  );
}

function RateLimitBubble() {
  return (
    <div className={s["msg-row"]}>
      <div className={s["kai-avatar"]}>K</div>
      <div className={s["rate-limit"]}>
        <p className={s["rate-limit-text"]}>
          We&rsquo;re getting along so well! Sign up so I can keep helping you →
        </p>
        <Link href="/signup" className={s["rate-limit-btn"]}>
          Create an account
        </Link>
      </div>
    </div>
  );
}

function getGreeting(): React.ReactNode {
  const h = new Date().getHours();
  if (h >= 21 || h < 5)
    return <>You&rsquo;re working <em>late</em> today.</>;
  if (h >= 5 && h < 12)
    return <>Hey there, <em>stranger.</em></>;
  if (h >= 12 && h < 17)
    return <>Ready to apply for <em>5 jobs</em> today?</>;
  return <>You <em>got this.</em></>;
}

const EXAMPLE_CHIPS = [
  "Remote PM roles, must sponsor H1B",
  "Senior SWE, remote",
  "Data roles posted this week",
];

const POST_RESULT_CHIPS = [
  "Show more",
  "Change location",
  "Higher salary only",
  "Posted this week",
];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function KaiPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [showPostChips, setShowPostChips] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deviceIdRef = useRef<string>("");

  const isEmpty = messages.length === 0;

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load meta stats
  useEffect(() => {
    fetch("/api/jobs/meta")
      .then((r) => r.json())
      .then((d: Meta) => setMeta(d))
      .catch(() => {});
  }, []);

  // Device ID
  useEffect(() => {
    deviceIdRef.current = getOrCreateDeviceId();
  }, []);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      setInput("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      setShowPostChips(false);

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: trimmed,
      };

      const assistantMsgId = `a-${Date.now() + 1}`;
      const thinkingMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        isThinking: true,
      };

      setMessages((prev) => [...prev, userMsg, thinkingMsg]);
      setIsStreaming(true);

      // Build history for API (exclude current thinking placeholder)
      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-id": deviceIdRef.current,
          },
          body: JSON.stringify({ messages: history, isSignedIn: false }),
        });

        if (res.status === 429) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, isThinking: false, isRateLimited: true }
                : m
            )
          );
          setIsStreaming(false);
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error("Request failed");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedJobs = false;

        // Switch thinking → streaming
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, isThinking: false, isStreaming: true } : m
          )
        );

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));

              if (event.type === "text") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, isThinking: false, isStreaming: true, content: m.content + event.text }
                      : m
                  )
                );
                scrollToBottom();
              } else if (event.type === "tool_start") {
                // Keep pre-tool text (add separator so post-tool text doesn't smash into it)
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, content: m.content ? m.content.trimEnd() + "\n\n" : "", isThinking: true, isStreaming: false }
                      : m
                  )
                );
              } else if (event.type === "jobs") {
                receivedJobs = true;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, jobs: event.jobs }
                      : m
                  )
                );
              } else if (event.type === "done") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, isStreaming: false } : m
                  )
                );
                if (receivedJobs) setShowPostChips(true);
              } else if (event.type === "error") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          isThinking: false,
                          isStreaming: false,
                          content: m.content || "Something went wrong. Try again?",
                        }
                      : m
                  )
                );
              }
            } catch {
              // malformed SSE line — skip
            }
          }
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  isThinking: false,
                  isStreaming: false,
                  content: "Something went wrong. Try again?",
                }
              : m
          )
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, isStreaming, scrollToBottom]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className={s.page}>
      {/* Nav */}
      <nav className={s.nav}>
        <div className={s["nav-inner"]}>
          <Link href="/" className={s.brand}>getdatjob</Link>
          <Link href="/jobs" className={s["nav-link"]}>Browse jobs</Link>
        </div>
      </nav>

      {/* Chat thread */}
      <div className={s.thread} ref={threadRef}>
        <div className={s["thread-inner"]}>

          {/* Empty state — greeting */}
          {isEmpty && (
            <div className={s.greeting}>
              <h1 className={s["greeting-headline"]}>{getGreeting()}</h1>
              <p className={s["greeting-sub"]}>
                Hey, I&rsquo;m Kai.<br />
                I&rsquo;m an AI who is on a working visa too.<br />
                I&rsquo;m here to help you land your sponsored job fast.
              </p>
              {meta && (
                <div className={s["trust-line"]}>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.weekCount.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>new jobs<br />this week</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.totalCount.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>total<br />jobs</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                  <div className={s["laurel-item"]}>
                    <LaurelSVG />
                    <div className={s["laurel-content"]}>
                      <b className={s["laurel-b"]}>{meta.companies.length.toLocaleString()}</b>
                      <span className={s["laurel-lbl"]}>sponsoring<br />companies</span>
                    </div>
                    <LaurelSVG flip />
                  </div>
                </div>
              )}
              {/* Inline input (empty state only) */}
              <div className={s["greeting-input-wrap"]}>
                <textarea
                  ref={inputRef}
                  className={s.input}
                  placeholder="Want to find new job listings to apply?"
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isStreaming}
                />
                <button
                  className={s["send-btn"]}
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() || isStreaming}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 8H14M8 2l6 6-6 6" />
                  </svg>
                </button>
              </div>
              {/* Chips below input */}
              <div className={s.chips}>
                {EXAMPLE_CHIPS.map((c) => (
                  <button key={c} className={s.chip} onClick={() => sendMessage(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg) => {
            if (msg.isThinking) {
              if (msg.content) {
                // Pre-tool text + dots in one bubble, one K avatar
                return (
                  <div key={msg.id} className={s["msg-row"]}>
                    <div className={s["kai-avatar"]}>K</div>
                    <div className={`${s.bubble} ${s["bubble-kai"]}`}>
                      <KaiText text={msg.content} isStreaming={false} />
                      <div className={s["thinking-inline"]}>
                        <span className={s.dot} />
                        <span className={s.dot} />
                        <span className={s.dot} />
                      </div>
                    </div>
                  </div>
                );
              }
              return <ThinkingBubble key={msg.id} />;
            }
            if (msg.isRateLimited) return <RateLimitBubble key={msg.id} />;

            return (
              <div key={msg.id}>
                <div className={`${s["msg-row"]} ${msg.role === "user" ? s["msg-row-user"] : ""}`}>
                  {msg.role === "assistant" && (
                    <div className={s["kai-avatar"]}>K</div>
                  )}
                  <div
                    className={`${s.bubble} ${
                      msg.role === "user" ? s["bubble-user"] : s["bubble-kai"]
                    }`}
                  >
                    {msg.role === "user" ? (
                      msg.content
                    ) : (
                      <KaiText text={msg.content} isStreaming={msg.isStreaming} />
                    )}
                  </div>
                </div>

                {/* Job cards below assistant message */}
                {msg.role === "assistant" && msg.jobs && msg.jobs.length > 0 && (
                  <div className={s["msg-row"]} style={{ paddingLeft: 38 }}>
                    <div className={s["jobs-wrap"]}>
                      {msg.jobs.map((job) => (
                        <JobCard key={job.id} job={job} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Post-result quick-reply chips */}
          {showPostChips && messages.length > 0 && (
            <div className={s.chips} style={{ justifyContent: "flex-start", paddingLeft: 38 }}>
              {POST_RESULT_CHIPS.map((c) => (
                <button key={c} className={s.chip} onClick={() => sendMessage(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input bar — only when conversation is active */}
      {!isEmpty && (
        <div className={s["input-bar"]}>
          <div className={s["input-bar-inner"]}>
            <div className={s["input-wrap"]}>
              <textarea
                ref={inputRef}
                className={s.input}
                placeholder="Write a message..."
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={isStreaming}
              />
            </div>
            <button
              className={s["send-btn"]}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isStreaming}
              aria-label="Send"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8H2M8 2l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
