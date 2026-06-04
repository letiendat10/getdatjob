"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { MatchesPanel } from "./matches-panel";
import { JobChips } from "@/app/components/JobChips";
import { CompanyAvatar } from "@/app/components/CompanyAvatar";
import s from "./me.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

type AlertPrefs = { email_alerts: boolean; frequency: "daily" | "weekly" };

type WorkHistoryItem = {
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
};

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
    job_function: string | null;
    location: string | null;
    posted_within_days: number | null;
  } | null;
  work_history: WorkHistoryItem[] | null;
};

type Job = {
  id: number;
  title: string;
  company: string;
  company_domain: string | null;
  location: string | null;
  url: string | null;
  posted_at: string | null;
  effective_posted_at: string | null;
  department: string | null;
  job_level: string | null;
  is_remote: boolean | null;
  visa_tier: string | null;
  salary_range: string | null;
  lca_count: number | null;
  lca_count_2025: number | null;
  lca_last_filed: string | null;
  e3_lca_count: number | null;
  poc_first_name: string | null;
  poc_last_name: string | null;
  poc_email: string | null;
};

type ChatCta = {
  label: string;
  href: string;
  checkout_session_id?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  jobs?: Job[];
  cta?: ChatCta | null;
  isStreaming?: boolean;
  isThinking?: boolean;
};

type Tab = "chat" | "matches" | "account";

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

function formatLcaDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length < 2) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[month]} ${year}`;
}

function formatPoc(firstName: string | null, lastName: string | null, email: string | null): string | null {
  if (!email) return null;
  const first = firstName ? firstName.split(/[\s/,]+/)[0].trim() : null;
  const lastInitial = lastName ? lastName.trim()[0].toUpperCase() : null;
  if (first && lastInitial) return `${first} ${lastInitial} (${email})`;
  if (first) return `${first} (${email})`;
  return email;
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

// ── Headline rotation ─────────────────────────────────────────────────────────

type Greeting = {
  headline: string;
  line2: { pre?: string; em: string; post?: string };
};

const UNIVERSAL_GREETINGS: Greeting[] = [
  { headline: "It's a numbers game.", line2: { pre: "Let's ", em: "keep going." } },
  { headline: "Sponsored roles get filled every day.", line2: { pre: "Let's get you ", em: "in front." } },
];

const DOW_GREETINGS: Partial<Record<number, Greeting[]>> = {
  1: [{ headline: "New week, new visa-sponsored opportunities.", line2: { pre: "Let's find ", em: "yours." } }],
  5: [{ headline: "Let's end the week strong.", line2: { em: "A few more", post: " to apply." } }],
};

const TIME_POOLS: Record<string, Greeting[]> = {
  late: [
    { headline: "Working late{name}?", line2: { pre: "We love ", em: "the hustle." } },
    { headline: "Late nights build futures.", line2: { pre: "Let's find ", em: "your next role." } },
  ],
  earlyMorning: [
    { headline: "Early bird gets the job", line2: { pre: "Let's find ", em: "yours." } },
    { headline: "Up before everyone.", line2: { pre: "Let's ", em: "stay ahead." } },
  ],
  morning: [
    { headline: "Good morning{name}.", line2: { pre: "Let's ", em: "get to work." } },
    { headline: "Fresh start today.", line2: { pre: "Your next visa-sponsored opportunity is ", em: "waiting." } },
  ],
  afternoon: [
    { headline: "You got this{name}.", line2: { pre: "Let's find ", em: "your next role." } },
  ],
  evening: [
    { headline: "Ready to apply tonight{name}?", line2: { pre: "Let's ", em: "make it count." } },
  ],
};

function getTimeGreeting(name: string | null): { headline: string; line2: Greeting["line2"] } {
  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay();

  let slotKey: string;
  if (hour >= 22 || hour < 6) slotKey = "late";
  else if (hour < 9) slotKey = "earlyMorning";
  else if (hour < 12) slotKey = "morning";
  else if (hour < 17) slotKey = "afternoon";
  else slotKey = "evening";

  const dowExtras = DOW_GREETINGS[dow] ?? [];
  const pool = [...TIME_POOLS[slotKey], ...dowExtras, ...UNIVERSAL_GREETINGS];

  const dateSeed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const slotOffset = slotKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const picked = pool[(dateSeed + slotOffset) % pool.length];

  const nameInsert = name ? `, ${name}` : "";
  return { headline: picked.headline.replace("{name}", nameInsert), line2: picked.line2 };
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

function JobCard({ job }: { job: Job }) {
  const posted = timeAgo(job.effective_posted_at ?? job.posted_at);
  const displayCompany = normalizeCompanyName(job.company);
  return (
    <a
      href={job.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 px-3.5 pt-3 pb-2.5 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors no-underline"
    >
      <CompanyAvatar name={job.company} domain={job.company_domain} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <h3 className="text-sm font-semibold leading-snug text-zinc-900 group-hover:text-blue-600 transition-colors line-clamp-2">
            {job.title}
          </h3>
          {posted && <span className="text-xs text-zinc-400 ml-2 flex-shrink-0">{posted}</span>}
        </div>
        <p className="text-xs text-zinc-500 mb-1.5 truncate">
          {displayCompany}{job.location ? ` · ${job.location}` : ""}
        </p>
        <JobChips
          salary_range={job.salary_range}
          visa_tier={job.visa_tier}
          e3_lca_count={job.e3_lca_count}
          title={job.title}
          lca_last_filed={job.lca_last_filed}
          lca_count_2025={job.lca_count_2025}
          poc_first_name={job.poc_first_name}
          poc_last_name={job.poc_last_name}
          poc_email={job.poc_email}
        />
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showPostChips, setShowPostChips] = useState(false);
  const [timeGreeting, setTimeGreeting] = useState<{ headline: string; line2: Greeting["line2"] } | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setTimeGreeting(getTimeGreeting(name)); }, [name]);

  // Load chat history from Supabase on mount
  useEffect(() => {
    const supabase = createSupabaseBrowser();
    supabase
      .from("kai_messages")
      .select("id, role, content, jobs, cta, created_at")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (!error && data && data.length > 0) {
          setMessages(
            data.map((row) => ({
              id: row.id as string,
              role: row.role as "user" | "assistant",
              content: row.content as string,
              jobs: (row.jobs as Job[] | null) ?? undefined,
              cta: (row.cta as ChatCta | null) ?? undefined,
            }))
          );
        } else {
          // Fall back to /kai localStorage history if Supabase is empty
          let restoredFromLocal = false;
          try {
            const raw = localStorage.getItem("kai_chat_history");
            if (raw) {
              const saved = JSON.parse(raw) as { step: string; messages: ChatMessage[] };
              if (saved.step === "done" && saved.messages?.length > 0) {
                const clean = saved.messages.filter((m) => !m.isThinking && !m.isStreaming);
                if (clean.length > 0) {
                  setMessages(clean);
                  restoredFromLocal = true;
                  // Sync to Supabase so future cross-domain loads work
                  (async () => {
                    for (const m of clean) {
                      await supabase.from("kai_messages").insert({
                        user_id: profile.id, role: m.role,
                        content: m.content, jobs: (m.jobs as Job[] | null) ?? null,
                      });
                    }
                  })();
                }
              }
            }
          } catch { /* ignore */ }
          if (!restoredFromLocal) setMessages([buildReturnGreeting(name)]);
        }
        setHistoryLoaded(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      // Persist user message immediately (fire-and-forget)
      const supabase = createSupabaseBrowser();
      supabase.from("kai_messages").insert({ user_id: profile.id, role: "user", content: trimmed });

      const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

      // Track accumulated assistant response for persisting
      let accContent = "";
      let accJobs: Job[] | undefined;

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
                accContent += event.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, isThinking: false, isStreaming: true, content: m.content + event.text }
                      : m
                  )
                );
                scrollToBottom();
              } else if (event.type === "tool_start") {
                accContent = accContent ? accContent.trimEnd() + "\n\n" : "";
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, content: m.content ? m.content.trimEnd() + "\n\n" : "", isThinking: true, isStreaming: false }
                      : m
                  )
                );
              } else if (event.type === "jobs") {
                receivedJobs = true;
                accJobs = event.jobs;
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
                // Persist completed assistant message to Supabase
                supabase.from("kai_messages").insert({
                  user_id: profile.id,
                  role: "assistant",
                  content: accContent,
                  jobs: accJobs ?? null,
                });
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
    [messages, isStreaming, scrollToBottom, profile.full_name, profile.id]
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
          {timeGreeting && (
            <div className={s["page-greeting"]}>
              <h1 className={s["page-headline"]}>
                {timeGreeting.headline}<br />
                {timeGreeting.line2.pre}<em>{timeGreeting.line2.em}</em>{timeGreeting.line2.post}
              </h1>
            </div>
          )}
          {!historyLoaded ? (
            <ThinkingBubble />
          ) : (
            <>
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
                    {msg.role === "assistant" && msg.cta && (
                      <div className={s["msg-row"]} style={{ paddingLeft: 38, marginTop: 8 }}>
                        <button
                          className={s["cta-chip"]}
                          onClick={() => {
                            if (msg.cta?.href === "/me/job-matches") {
                              onGoToMatches();
                            } else if (msg.cta?.href) {
                              window.location.href = msg.cta.href;
                            }
                          }}
                        >
                          {msg.cta.label}
                        </button>
                      </div>
                    )}
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
            </>
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

// MatchesTab is replaced by MatchesPanel (imported from ./matches-panel)

// ── Account Tab constants ─────────────────────────────────────────────────────

const VISA_OPTIONS = [
  { label: "H-1B", value: "H-1B" },
  { label: "E-3 / TN", value: "E-3/TN" },
  { label: "OPT", value: "OPT" },
  { label: "O-1 / Other", value: "Other" },
];
const DEPT_OPTIONS = [
  "Engineering", "Product", "AI / ML", "Data", "Design",
  "Security", "Platform / DevOps", "Sales", "Marketing",
  "Finance", "Operations", "Legal", "HR / People",
  "Customer Success", "Facilities",
];
const LEVEL_OPTIONS = ["Junior", "Lead", "Senior", "Principal/Staff", "People Manager"];
const SALARY_OPTIONS = [
  { label: "Any", value: "" },
  { label: "$100K+", value: "100000" },
  { label: "$150K+", value: "150000" },
  { label: "$200K+", value: "200000" },
];
const POSTED_OPTIONS = [
  { label: "Any time", value: "" },
  { label: "Last 24h", value: "1" },
  { label: "Last 3 days", value: "3" },
  { label: "Last week", value: "7" },
  { label: "Last month", value: "30" },
];
const LOCATION_PROFILE_OPTIONS = [
  { label: "Any location", value: "" },
  { label: "Remote", value: "Remote" },
  { label: "San Francisco Bay Area", value: "San Francisco Bay Area" },
  { label: "New York City", value: "New York City" },
  { label: "Seattle, WA", value: "Seattle, WA" },
  { label: "Chicago, IL", value: "Chicago, IL" },
  { label: "Los Angeles, CA", value: "Los Angeles, CA" },
  { label: "Austin, TX", value: "Austin, TX" },
  { label: "Boston, MA", value: "Boston, MA" },
  { label: "Denver, CO", value: "Denver, CO" },
  { label: "Washington, DC", value: "Washington, DC" },
  { label: "Atlanta, GA", value: "Atlanta, GA" },
  { label: "Miami, FL", value: "Miami, FL" },
  { label: "Nashville, TN", value: "Nashville, TN" },
  { label: "Portland, OR", value: "Portland, OR" },
  { label: "Salt Lake City, UT", value: "Salt Lake City, UT" },
  { label: "Phoenix, AZ", value: "Phoenix, AZ" },
  { label: "San Diego, CA", value: "San Diego, CA" },
  { label: "Virginia", value: "Virginia" },
  { label: "Pennsylvania", value: "Pennsylvania" },
];
const RAINBOW = "linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#a855f7)";
const TIER_LABELS: Record<string, string> = { free: "Free", passed: "Passed", preferred: "Preferred" };
const TIER_FEATURES: Record<string, string[]> = {
  free:      ["6 job matches/day", "USCIS-verified data", "Sponsorship history", "Verified company contact"],
  passed:    ["Unlimited job listings", "USCIS-verified data", "Sponsorship history", "Verified company contact"],
  preferred: ["Unlimited job listings", "USCIS-verified data", "Sponsorship history", "Verified company contact", "Job alerts to make you first in line", "Lay-off action plan"],
};

// ── Account Tab ───────────────────────────────────────────────────────────────

function formatWorkDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function AccountTab({ profile, alertPrefs: initialAlertPrefs, onSignOut, onPrefsChange }: {
  profile: Profile;
  alertPrefs: AlertPrefs | null;
  onSignOut: () => void;
  onPrefsChange: (p: Profile["preferences"]) => void;
}) {
  const name = firstName(profile.full_name);
  const tier = profile.subscription_tier ?? "free";
  const isPaid = tier !== "free" || profile.is_supporter;
  const isTrialing = profile.subscription_status === "trialing";
  const trialEnd = profile.current_tier_expires_at
    ? new Date(profile.current_tier_expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  // Job preferences state — debounced autosave
  const [prefs, setPrefs] = useState({
    visa_type: profile.preferences?.visa_type ?? "",
    job_function: profile.preferences?.job_function ?? "",
    job_level: profile.preferences?.job_level ?? "",
    salary_floor: profile.preferences?.salary_floor != null ? String(profile.preferences.salary_floor) : "",
    location: profile.preferences?.location ?? "",
    posted_within_days: profile.preferences?.posted_within_days != null ? String(profile.preferences.posted_within_days) : "",
  });
  const [prefsSaved, setPrefsSaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Alert prefs state — immediate autosave
  const [alerts, setAlerts] = useState<AlertPrefs>({
    email_alerts: initialAlertPrefs?.email_alerts ?? false,
    frequency: initialAlertPrefs?.frequency ?? "daily",
  });

  // Delete account UI state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Stripe portal loading
  const [portalLoading, setPortalLoading] = useState(false);

  const savePrefDebounced = (newPrefs: typeof prefs) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setPrefsSaved(false);
    saveTimerRef.current = setTimeout(async () => {
      const supabase = createSupabaseBrowser();
      await supabase.schema("enriched").from("profiles").upsert({
        user_id: profile.id,
        visa_type: newPrefs.visa_type || null,
        job_function: newPrefs.job_function || null,
        job_level: newPrefs.job_level || null,
        salary_floor: newPrefs.salary_floor ? parseInt(newPrefs.salary_floor) : null,
        location: newPrefs.location || null,
        posted_within_days: newPrefs.posted_within_days ? parseInt(newPrefs.posted_within_days) : null,
      }, { onConflict: "user_id" });
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2500);
    }, 600);
  };

  const updatePref = (key: keyof typeof prefs, value: string) => {
    const newPrefs = { ...prefs, [key]: value };
    setPrefs(newPrefs);
    // Cascade to MatchesPanel IMMEDIATELY — no need to wait for the 600ms debounced DB write.
    onPrefsChange({
      visa_type: newPrefs.visa_type || null,
      job_function: newPrefs.job_function || null,
      job_level: newPrefs.job_level || null,
      salary_floor: newPrefs.salary_floor ? parseInt(newPrefs.salary_floor) : null,
      location: newPrefs.location || null,
      posted_within_days: newPrefs.posted_within_days ? parseInt(newPrefs.posted_within_days) : null,
    });
    savePrefDebounced(newPrefs);
  };

  const saveAlerts = async (newAlerts: AlertPrefs) => {
    const supabase = createSupabaseBrowser();
    await supabase.from("user_job_alert_prefs").upsert({
      user_id: profile.id,
      email_alerts: newAlerts.email_alerts,
      frequency: newAlerts.frequency,
    }, { onConflict: "user_id" });
  };

  const handleManage = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const { url } = await res.json() as { url?: string };
      if (url) window.location.href = url;
    } catch { /* graceful */ } finally { setPortalLoading(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetch("/api/account", { method: "DELETE" });
      const supabase = createSupabaseBrowser();
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch { setDeleting(false); }
  };

  return (
    <div className={s["profile-scroll"]}>
      <div className={s["profile-inner"]}>

        {/* 1. Personal Info */}
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
          </div>
        </div>

        {/* 2. Job Preferences */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>
              Job Preferences
              {prefsSaved && <span className={s["pref-saved"]}>Saved ✓</span>}
            </h3>
          </div>
          <div className={s["profile-card-body"]}>
            <div className={s["pref-grid"]}>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Visa type</label>
                <select className={s["pref-select"]} value={prefs.visa_type} onChange={e => updatePref("visa_type", e.target.value)}>
                  <option value="">Select</option>
                  {VISA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Job department</label>
                <select className={s["pref-select"]} value={prefs.job_function} onChange={e => updatePref("job_function", e.target.value)}>
                  <option value="">Select</option>
                  {DEPT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Level</label>
                <select className={s["pref-select"]} value={prefs.job_level} onChange={e => updatePref("job_level", e.target.value)}>
                  <option value="">Select</option>
                  {LEVEL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Salary</label>
                <select className={s["pref-select"]} value={prefs.salary_floor} onChange={e => updatePref("salary_floor", e.target.value)}>
                  {SALARY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Location</label>
                <select className={s["pref-select"]} value={prefs.location} onChange={e => updatePref("location", e.target.value)}>
                  {LOCATION_PROFILE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className={s["pref-field"]}>
                <label className={s["pref-label"]}>Posted within</label>
                <select className={s["pref-select"]} value={prefs.posted_within_days} onChange={e => updatePref("posted_within_days", e.target.value)}>
                  {POSTED_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Work Experience */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Work Experience</h3>
          </div>
          <div className={s["profile-card-body"]}>
            {!profile.work_history || profile.work_history.length === 0 ? (
              <p className={s["profile-empty"]}>No work history imported yet.</p>
            ) : (
              <div className={s["work-exp-list"]}>
                {profile.work_history.map((item, i) => (
                  <div key={i} className={s["work-exp-item"]}>
                    <div className={s["work-exp-title"]}>
                      {item.title}
                      {item.is_current && <span className={s["work-exp-current"]}>Current</span>}
                    </div>
                    <div className={s["work-exp-company"]}>
                      {item.company}{item.location ? ` · ${item.location}` : ""}
                    </div>
                    <div className={s["work-exp-meta"]}>
                      {formatWorkDate(item.start_date)}
                      {" – "}
                      {item.is_current ? "Present" : formatWorkDate(item.end_date)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 4. Subscription */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Subscription</h3>
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
              {isTrialing && trialEnd && <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Trial ends {trialEnd}</span>}
              {!isTrialing && isPaid && trialEnd && <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Expires {trialEnd}</span>}
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 14px", display: "flex", flexDirection: "column", gap: 4 }}>
              {(TIER_FEATURES[tier] ?? TIER_FEATURES.free).map((f) => (
                <li key={f} style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 5 }}>
                  <span style={{ color: "#6bcb77", fontWeight: 700 }}>✓</span> {f}
                </li>
              ))}
            </ul>
            {!isPaid ? (
              <Link href="/kai" style={{ display: "inline-block", background: "var(--accent)", color: "#F4F0E8", padding: "9px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                Upgrade now →
              </Link>
            ) : (
              <button onClick={handleManage} disabled={portalLoading} style={{ background: "none", border: "1px solid var(--line)", color: "var(--ink-3)", padding: "8px 16px", borderRadius: 10, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {portalLoading ? "Loading…" : "Manage subscription"}
              </button>
            )}
          </div>
        </div>

        {/* 5. Job Alert Preferences */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Job Alert Preferences</h3>
          </div>
          <div className={s["profile-card-body"]}>
            <div className={s["alert-row"]}>
              <div>
                <div className={s["alert-row-name"]}>Email alerts</div>
                <div className={s["alert-row-desc"]}>Get notified when new matching jobs drop</div>
              </div>
              <label className={s["toggle"]}>
                <input
                  type="checkbox"
                  checked={alerts.email_alerts}
                  onChange={e => {
                    const next = { ...alerts, email_alerts: e.target.checked };
                    setAlerts(next);
                    saveAlerts(next);
                  }}
                />
                <span className={s["toggle-track"]} />
              </label>
            </div>
            {alerts.email_alerts && (
              <div className={s["pref-field"]} style={{ marginTop: 14 }}>
                <label className={s["pref-label"]}>Frequency</label>
                <select
                  className={s["pref-select"]}
                  value={alerts.frequency}
                  onChange={e => {
                    const next = { ...alerts, frequency: e.target.value as "daily" | "weekly" };
                    setAlerts(next);
                    saveAlerts(next);
                  }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
            )}
          </div>
        </div>

        {/* 6. Sign Out */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-body"]}>
            <button className={s["sign-out-btn"]} onClick={onSignOut}>
              <SignOutIcon />
              Sign out
            </button>
          </div>
        </div>

        {/* 7. Login & Security */}
        <div className={s["profile-card"]}>
          <div className={s["profile-card-head"]}>
            <h3 className={s["profile-card-title"]}>Login & Security</h3>
          </div>
          <div className={s["profile-card-body"]}>
            <div className={s["security-row"]}>
              <div className={s["drawer-linked-icon"]}><LinkedInIcon /></div>
              <div className={s["drawer-linked-info"]}>
                <span className={s["drawer-linked-name"]}>LinkedIn</span>
                <span className={s["drawer-linked-desc"]}>{profile.email ?? "Signed in"}</span>
              </div>
              <span className={s["connected-badge"]}>Connected</span>
            </div>
            {!showDeleteConfirm ? (
              <button className={s["delete-btn"]} onClick={() => setShowDeleteConfirm(true)}>
                Delete my account
              </button>
            ) : (
              <div className={s["delete-confirm"]}>
                <p className={s["delete-confirm-text"]}>This will permanently delete your account and all data. This cannot be undone.</p>
                <div className={s["delete-confirm-actions"]}>
                  <button className={s["delete-confirm-cancel"]} onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                  <button className={s["delete-confirm-ok"]} onClick={handleDelete} disabled={deleting}>
                    {deleting ? "Deleting…" : "Yes, delete my account"}
                  </button>
                </div>
              </div>
            )}
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
];

// ── Main page ─────────────────────────────────────────────────────────────────

const TAB_TO_SLUG: Record<Tab, string> = {
  chat: "/me/chat",
  matches: "/me/job-matches",
  account: "/me/profile",
};

export default function MeClient({ profile, alertPrefs, initialTab }: { profile: Profile; alertPrefs: AlertPrefs | null; initialTab: Tab }) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  // Lifted preferences state — AccountTab edits cascade into MatchesPanel filters
  const [preferences, setPreferences] = useState<Profile["preferences"]>(profile.preferences);
  const router = useRouter();

  function switchTab(tab: Tab) {
    setActiveTab(tab);
    window.history.pushState(null, "", TAB_TO_SLUG[tab]);
  }

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
        <button
          className={s["mobile-avatar"]}
          onClick={() => switchTab("account")}
          aria-label="Account"
        >
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.avatar_url} alt={profile.full_name ?? ""} />
          ) : (
            (name ?? "?")[0].toUpperCase()
          )}
        </button>
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
              onClick={() => switchTab(id)}
            >
              <span className={s["sidebar-tab-icon"]}>{icon}</span>
              <span className={s["sidebar-tab-label"]}>{label}</span>
              <span className={s["sidebar-tab-mobile-label"]}>{mobileLabel}</span>
            </button>
          ))}
        </nav>

        <button
          className={`${s["sidebar-user"]} ${activeTab === "account" ? s["sidebar-user-active"] : ""}`}
          onClick={() => switchTab("account")}
          aria-label="Account"
        >
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
        </button>
      </aside>

      {/* Main content — all panels always mounted for state persistence */}
      <main className={s.main}>
        <div className={`${s["tab-panel"]} ${activeTab !== "chat" ? s["tab-panel-hidden"] : ""}`}>
          <ChatTab
            profile={profile}
            onGoToMatches={() => switchTab("matches")}
          />
        </div>
        <div className={`${s["tab-panel"]} ${activeTab !== "matches" ? s["tab-panel-hidden"] : ""}`}>
          <MatchesPanel
            isUnlocked={profile.is_supporter || (profile.subscription_tier ?? "free") !== "free"}
            preferences={preferences}
          />
        </div>
        <div className={`${s["tab-panel"]} ${activeTab !== "account" ? s["tab-panel-hidden"] : ""}`}>
          <AccountTab
            profile={profile}
            alertPrefs={alertPrefs}
            onSignOut={handleSignOut}
            onPrefsChange={setPreferences}
          />
        </div>
      </main>
    </div>
  );
}
