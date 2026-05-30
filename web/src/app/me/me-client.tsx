"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import s from "./me.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_supporter: boolean;
  subscription_tier?: string;
  subscription_status?: string | null;
  stripe_customer_id?: string | null;
  current_tier_expires_at?: string | null;
  preferences: {
    visa_type: string | null;
    salary_floor: number | null;
    job_level: string | null;
    location: string | null;
  } | null;
};

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
};

type Tab = "chat" | "matches" | "profile" | "settings";

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

function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  return fullName.split(" ")[0] ?? null;
}

function buildReturnGreeting(name: string | null): ChatMessage {
  const greetings = [
    "You're back on the track! Want me to pull fresh matches, or anything different from last time?",
    "Good to see you again. New matches since yesterday — want me to pull today's batch?",
    "Job market is tough, but you are tougher. Ready to pull fresh matches?",
    "You got this. Back for more matches? I'll pull the latest for you.",
  ];
  const msg = greetings[Math.floor(Math.random() * greetings.length)];
  return {
    id: "kai-return-0",
    role: "assistant",
    content: name ? `Hey ${name}! ${msg}` : msg,
  };
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function MessageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function BriefcaseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

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
            <span className="text-xs font-medium text-[var(--ink-2)]">
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

// ── Chat Tab ──────────────────────────────────────────────────────────────────

const RETURN_CHIPS = [
  "Pull fresh matches",
  "Remote only",
  "Higher salary",
  "Posted this week",
];

function ChatTab({ profile, onGoToMatches }: { profile: Profile; onGoToMatches: () => void }) {
  const name = firstName(profile.full_name);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [buildReturnGreeting(name)]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showPostChips, setShowPostChips] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, []);

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
      if (inputRef.current) inputRef.current.style.height = "auto";
      setShowPostChips(false);

      const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: trimmed };
      const assistantMsgId = `a-${Date.now() + 1}`;
      const thinkingMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        isThinking: true,
      };

      setMessages((prev) => [...prev, userMsg, thinkingMsg]);
      setIsStreaming(true);

      const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, userName: profile.full_name }),
        });

        if (!res.ok || !res.body) throw new Error("Request failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedJobs = false;

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
                    m.id === assistantMsgId ? { ...m, jobs: event.jobs } : m
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
                      ? { ...m, isThinking: false, isStreaming: false, content: m.content || "Something went wrong. Try again?" }
                      : m
                  )
                );
              }
            } catch {
              // malformed SSE line
            }
          }
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, isThinking: false, isStreaming: false, content: "Something went wrong. Try again?" }
              : m
          )
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, isStreaming, scrollToBottom, profile.full_name]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className={s["chat-wrap"]}>
      <div className={s.thread} ref={threadRef}>
        <div className={s["thread-inner"]}>
          {messages.map((msg) => {
            if (msg.isThinking) {
              if (msg.content) {
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

            return (
              <div key={msg.id}>
                <div className={`${s["msg-row"]} ${msg.role === "user" ? s["msg-row-user"] : ""}`}>
                  {msg.role === "assistant" && <div className={s["kai-avatar"]}>K</div>}
                  <div className={`${s.bubble} ${msg.role === "user" ? s["bubble-user"] : s["bubble-kai"]}`}>
                    {msg.role === "user" ? (
                      msg.content
                    ) : (
                      <KaiText text={msg.content} isStreaming={msg.isStreaming} />
                    )}
                  </div>
                </div>
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

          {showPostChips && (
            <div className={s.chips}>
              {RETURN_CHIPS.map((c) => (
                <button key={c} className={s.chip} onClick={() => sendMessage(c)}>
                  {c}
                </button>
              ))}
              {!profile.is_supporter && (
                <button className={s.chip} onClick={onGoToMatches}>
                  View my Job Matches →
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={s["input-bar"]}>
        <div className={s["input-bar-inner"]}>
          <div className={s["input-wrap"]}>
            <textarea
              ref={inputRef}
              className={s["chat-input"]}
              placeholder="Ask Kai anything..."
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
    </div>
  );
}

// ── Matches Tab ───────────────────────────────────────────────────────────────

const VISIBLE_FREE = 5;

function MatchesTab({ isUnlocked, preferences }: {
  isUnlocked: boolean;
  preferences: Profile["preferences"];
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params: Record<string, string | number> = {};
    if (preferences?.visa_type) params.visa = preferences.visa_type;
    if (preferences?.location) params.location = preferences.location;
    if (preferences?.salary_floor) params.salary_min = preferences.salary_floor;

    fetch("/api/onboarding/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, locationMode: preferences?.location ? "local" : "anywhere" }),
    })
      .then((r) => r.json())
      .then((d) => { setJobs((d as { jobs?: Job[] }).jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleJobs = isUnlocked ? jobs : jobs.slice(0, VISIBLE_FREE);
  const hiddenCount = isUnlocked ? 0 : Math.max(0, jobs.length - VISIBLE_FREE);

  return (
    <div className={s["matches-scroll"]}>
      <div style={{ padding: "24px 20px 40px", maxWidth: 640, margin: "0 auto" }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
          Your matches
        </h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 16px" }}>
          Roles verified against USCIS sponsorship data, updated daily.
        </p>

        {preferences && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
            {preferences.visa_type && (
              <span style={{ fontSize: 12, fontWeight: 500, padding: "4px 10px", borderRadius: 100, background: "var(--bg-2)", color: "var(--ink-2)", border: "1px solid var(--line)" }}>
                {preferences.visa_type}
              </span>
            )}
            {preferences.location && (
              <span style={{ fontSize: 12, fontWeight: 500, padding: "4px 10px", borderRadius: 100, background: "var(--bg-2)", color: "var(--ink-2)", border: "1px solid var(--line)" }}>
                {preferences.location}
              </span>
            )}
            {preferences.salary_floor && preferences.salary_floor > 0 && (
              <span style={{ fontSize: 12, fontWeight: 500, padding: "4px 10px", borderRadius: 100, background: "var(--bg-2)", color: "var(--ink-2)", border: "1px solid var(--line)" }}>
                ${Math.round(preferences.salary_floor / 1000)}K+
              </span>
            )}
            {preferences.job_level && (
              <span style={{ fontSize: 12, fontWeight: 500, padding: "4px 10px", borderRadius: 100, background: "var(--bg-2)", color: "var(--ink-2)", border: "1px solid var(--line)" }}>
                {preferences.job_level}
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ height: 80, borderRadius: 12, background: "var(--bg-2)", animation: "pulse 1.5s ease-in-out infinite" }} />
            ))}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {visibleJobs.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>

            {!isUnlocked && hiddenCount > 0 && (
              <>
                <div style={{ position: "relative", marginTop: 10 }}>
                  <div style={{ filter: "blur(5px)", pointerEvents: "none", userSelect: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                    {jobs.slice(VISIBLE_FREE, VISIBLE_FREE + 3).map((job) => (
                      <JobCard key={job.id} job={job} />
                    ))}
                  </div>
                  <div style={{
                    position: "absolute", inset: 0,
                    background: "linear-gradient(to bottom, transparent 0%, var(--bg) 80%)",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
                    paddingBottom: 12,
                  }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", margin: "0 0 10px", textAlign: "center" }}>
                      {hiddenCount} more match{hiddenCount !== 1 ? "es" : ""} — upgrade to apply for more jobs
                    </p>
                    <Link
                      href="/kai-pay"
                      style={{
                        display: "inline-block", background: "var(--accent)", color: "#F4F0E8",
                        padding: "10px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                        textDecoration: "none",
                      }}
                    >
                      Upgrade →
                    </Link>
                  </div>
                </div>
              </>
            )}

            {jobs.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--ink-3)", textAlign: "center", marginTop: 32 }}>
                No matches yet — complete the onboarding to personalize your results.{" "}
                <Link href="/kai-pay" style={{ color: "var(--accent)", textDecoration: "underline" }}>Get started →</Link>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Profile Tab ───────────────────────────────────────────────────────────────

function MembershipSection({ profile }: { profile: Profile }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const tier = profile.subscription_tier ?? "free";
  const isPaid = tier !== "free" || profile.is_supporter;
  const isTrialing = profile.subscription_status === "trialing";
  const trialEnd = profile.current_tier_expires_at
    ? new Date(profile.current_tier_expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  const RAINBOW = "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)";

  const TIER_LABELS: Record<string, string> = { free: "Free", passed: "Passed", preferred: "Preferred" };
  const TIER_FEATURES: Record<string, string[]> = {
    free: ["6 job matches/day", "USCIS-verified sponsorship data", "All visa types"],
    passed: ["Unlimited job matches", "USCIS-verified sponsorship data", "All visa types"],
    preferred: ["Unlimited job matches", "Daily job alerts", "Salary benchmarking"],
  };

  const handleManage = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const { url } = await res.json() as { url?: string };
      if (url) window.location.href = url;
    } catch { /* graceful */ } finally { setPortalLoading(false); }
  };

  return (
    <div className={s["profile-card"]}>
      <div className={s["profile-card-head"]}>
        <h3 className={s["profile-card-title"]}>Membership</h3>
      </div>
      <div className={s["profile-card-body"]}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          {isPaid ? (
            <span style={{ display: "inline-flex", borderRadius: 100, padding: "1px", background: RAINBOW }}>
              <span style={{ background: "var(--card)", borderRadius: 100, padding: "3px 12px", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
                {TIER_LABELS[tier] ?? "Supporter"} plan
              </span>
            </span>
          ) : (
            <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 100, background: "var(--bg-2)", color: "var(--ink-3)", border: "1px solid var(--line)" }}>
              Free plan
            </span>
          )}
          {isTrialing && <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Trial ends {trialEnd}</span>}
        </div>

        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          {(TIER_FEATURES[tier] ?? TIER_FEATURES.free).map((f) => (
            <li key={f} style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 5 }}>
              <span style={{ color: "#6bcb77", fontWeight: 700 }}>✓</span> {f}
            </li>
          ))}
        </ul>

        {!isPaid ? (
          <Link
            href="/kai-pay"
            style={{ display: "inline-block", background: "var(--accent)", color: "#F4F0E8", padding: "9px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            Upgrade →
          </Link>
        ) : (
          <button
            onClick={handleManage}
            disabled={portalLoading}
            style={{ background: "none", border: "1px solid var(--line)", color: "var(--ink-3)", padding: "8px 16px", borderRadius: 10, fontSize: 12, cursor: "pointer" }}
          >
            {portalLoading ? "Loading…" : "Manage subscription"}
          </button>
        )}
      </div>
    </div>
  );
}

function ProfileTab({ profile, onGoToChat }: { profile: Profile; onGoToChat: () => void }) {
  const name = firstName(profile.full_name);
  return (
    <div className={s["profile-scroll"]}>
      <div className={s["profile-inner"]}>
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Personal Info</h3>
          </div>
          <div className={s["profile-card-body"]}>
            <div className={s["profile-hero"]}>
              <div className={s["profile-big-avatar"]}>
                {profile.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatar_url} alt={profile.full_name ?? ""} />
                ) : (
                  (name ?? "?")[0].toUpperCase()
                )}
              </div>
              <div>
                <p className={s["profile-name"]}>{profile.full_name ?? "—"}</p>
                <p className={s["profile-email"]}>{profile.email ?? "—"}</p>
              </div>
            </div>
            <div className={s["profile-row"]}>
              <span className={s["profile-label"]}>Source</span>
              <span className={s["profile-value"]}>LinkedIn</span>
            </div>
          </div>
        </div>

        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Job Preferences</h3>
          </div>
          <div className={s["profile-card-body"]}>
            {profile.preferences && (profile.preferences.visa_type || profile.preferences.location || profile.preferences.salary_floor || profile.preferences.job_level) ? (
              <>
                {profile.preferences.visa_type && (
                  <div className={s["profile-row"]}>
                    <span className={s["profile-label"]}>Visa</span>
                    <span className={s["profile-value"]}>{profile.preferences.visa_type}</span>
                  </div>
                )}
                {profile.preferences.location && (
                  <div className={s["profile-row"]}>
                    <span className={s["profile-label"]}>Location</span>
                    <span className={s["profile-value"]}>{profile.preferences.location}</span>
                  </div>
                )}
                {profile.preferences.salary_floor && (
                  <div className={s["profile-row"]}>
                    <span className={s["profile-label"]}>Salary floor</span>
                    <span className={s["profile-value"]}>${Math.round(profile.preferences.salary_floor / 1000)}K+</span>
                  </div>
                )}
                {profile.preferences.job_level && (
                  <div className={s["profile-row"]}>
                    <span className={s["profile-label"]}>Level</span>
                    <span className={s["profile-value"]}>{profile.preferences.job_level}</span>
                  </div>
                )}
                <button className={s["profile-kai-cta"]} onClick={onGoToChat}>
                  Update via Kai →
                </button>
              </>
            ) : (
              <>
                <p className={s["profile-empty"]}>
                  Tell Kai your visa status, target roles, salary floor, and location to personalize your matches.
                </p>
                <button className={s["profile-kai-cta"]} onClick={onGoToChat}>
                  Update via Kai →
                </button>
              </>
            )}
          </div>
        </div>

        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Work Experience</h3>
          </div>
          <div className={s["profile-card-body"]}>
            <p className={s["profile-empty"]}>
              Kai can read your LinkedIn experience and tailor results to your background.
            </p>
            <button className={s["profile-kai-cta"]} onClick={onGoToChat}>
              Update via Kai →
            </button>
          </div>
        </div>

        <MembershipSection profile={profile} />
      </div>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

function SettingsTab({ profile, onSignOut }: { profile: Profile; onSignOut: () => void }) {
  return (
    <div className={s["settings-scroll"]}>
      <div className={s["settings-inner"]}>
        <div className={s["settings-card"]}>
          <div className={s["settings-card-head"]}>
            <h3 className={s["settings-card-title"]}>Connected Accounts</h3>
          </div>
          <div className={s["settings-row"]}>
            <div className={`${s["settings-row-icon"]} ${s["settings-row-icon-linkedin"]}`}>
              <LinkedInIcon />
            </div>
            <div className={s["settings-row-label"]}>
              <div className={s["settings-row-name"]}>LinkedIn</div>
              <div className={s["settings-row-desc"]}>{profile.email ?? "Signed in"}</div>
            </div>
            <span className={s["connected-badge"]}>Connected</span>
          </div>
        </div>

        <div className={s["settings-card"]}>
          <div className={s["settings-card-head"]}>
            <h3 className={s["settings-card-title"]}>Account</h3>
          </div>
          <div className={s["settings-row"]}>
            <div className={s["settings-row-label"]}>
              <div className={s["settings-row-name"]}>Supporter status</div>
              <div className={s["settings-row-desc"]}>
                {profile.is_supporter
                  ? "Thanks for supporting getdatjob!"
                  : "Tip $10 to unlock Job Matches and unlimited Kai"}
              </div>
            </div>
            {profile.is_supporter ? (
              <span className={s["supporter-badge"]}>Supporter 🙌</span>
            ) : (
              <a
                href="venmo://paycharge?txn=pay&recipients=letiendat&amount=10&note=getdatjob"
                className={s["venmo-btn"]}
                style={{ fontSize: 12, padding: "6px 12px", margin: 0 }}
              >
                $10 on Venmo
              </a>
            )}
          </div>
        </div>

        <div className={s["settings-card"]}>
          <div className={s["settings-card-head"]}>
            <h3 className={s["settings-card-title"]}>Notifications</h3>
          </div>
          <p className={s["notifications-placeholder"]}>
            Daily email alerts are coming soon. Kai will ping you when new matches drop.
          </p>
        </div>

        <div className={s["settings-card"]}>
          <div className={s["settings-footer"]}>
            <button className={s["sign-out-btn"]} onClick={onSignOut}>
              <SignOutIcon />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar tab config ────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; mobileLabel: string; icon: React.ReactNode }[] = [
  { id: "chat", label: "Chat with Kai", mobileLabel: "Kai", icon: <MessageIcon /> },
  { id: "matches", label: "Job Matches", mobileLabel: "Matches", icon: <BriefcaseIcon /> },
  { id: "profile", label: "Profile", mobileLabel: "Profile", icon: <PersonIcon /> },
  { id: "settings", label: "Settings", mobileLabel: "Settings", icon: <GearIcon /> },
];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MeClient({ profile }: { profile: Profile }) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/");
  };

  const name = firstName(profile.full_name);
  const tier = profile.subscription_tier ?? "free";
  const isPaid = tier !== "free" || profile.is_supporter;
  const tierLabel = isPaid
    ? (tier === "passed" ? "Passed" : tier === "preferred" ? "Preferred" : "Supporter")
    : "Free";

  return (
    <div className={s.page}>
      {/* Mobile top header */}
      <header className={s["mobile-header"]}>
        <Link href="/" className={s["mobile-brand"]}>getdatjob</Link>
        <div className={s["mobile-avatar"]}>
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.avatar_url} alt={profile.full_name ?? ""} />
          ) : (
            (name ?? "?")[0].toUpperCase()
          )}
        </div>
      </header>

      {/* Left sidebar */}
      <aside className={s.sidebar}>
        <div className={s["sidebar-top"]}>
          <Link href="/" className={s["sidebar-brand"]}>getdatjob</Link>
        </div>

        <nav className={s["sidebar-nav"]}>
          {TABS.map(({ id, label, mobileLabel, icon }) => (
            <button
              key={id}
              className={`${s["sidebar-tab"]} ${activeTab === id ? s["sidebar-tab-active"] : ""}`}
              onClick={() => setActiveTab(id)}
            >
              <span className={s["sidebar-tab-icon"]}>{icon}</span>
              <span className={s["sidebar-tab-label"]}>{label}</span>
              <span className={s["sidebar-tab-mobile-label"]}>{mobileLabel}</span>
            </button>
          ))}
        </nav>

        <div className={s["sidebar-user"]}>
          <div className={s["sidebar-avatar"]}>
            {profile.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatar_url} alt={profile.full_name ?? ""} />
            ) : (
              (name ?? "?")[0].toUpperCase()
            )}
          </div>
          <div className={s["sidebar-user-info"]}>
            <span className={s["sidebar-user-name"]}>{profile.full_name ?? name ?? "Account"}</span>
            <span className={s["sidebar-user-tier"]}>{tierLabel} plan</span>
          </div>
        </div>
      </aside>

      {/* Main content — all panels always mounted for state persistence */}
      <main className={s.main}>
        <div className={`${s["tab-panel"]} ${activeTab !== "chat" ? s["tab-panel-hidden"] : ""}`}>
          <ChatTab
            profile={profile}
            onGoToMatches={() => setActiveTab("matches")}
          />
        </div>
        <div className={`${s["tab-panel"]} ${activeTab !== "matches" ? s["tab-panel-hidden"] : ""}`}>
          <MatchesTab
            isUnlocked={profile.is_supporter || (profile.subscription_tier ?? "free") !== "free"}
            preferences={profile.preferences}
          />
        </div>
        <div className={`${s["tab-panel"]} ${activeTab !== "profile" ? s["tab-panel-hidden"] : ""}`}>
          <ProfileTab
            profile={profile}
            onGoToChat={() => setActiveTab("chat")}
          />
        </div>
        <div className={`${s["tab-panel"]} ${activeTab !== "settings" ? s["tab-panel-hidden"] : ""}`}>
          <SettingsTab profile={profile} onSignOut={handleSignOut} />
        </div>
      </main>
    </div>
  );
}
