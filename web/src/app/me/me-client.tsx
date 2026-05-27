"use client";

import { useState, useRef, useCallback } from "react";
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

// ── Chat Tab ──────────────────────────────────────────────────────────────────

const RETURN_CHIPS = [
  "Pull fresh matches",
  "Remote only",
  "Higher salary",
  "Posted this week",
];

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

function MatchesTab({ isSupporter }: { isSupporter: boolean }) {
  if (isSupporter) {
    return (
      <div className={s["matches-scroll"]}>
        <div style={{ padding: "32px 20px", maxWidth: 800, margin: "0 auto" }}>
          <p style={{ fontSize: 14, color: "var(--ink-3)" }}>
            Your personalized matches —{" "}
            <Link href="/jobs" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              browse all jobs
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={s["matches-scroll"]}>
      <div className={s["lock-screen"]}>
        <div className={s["lock-icon-wrap"]}>
          <LockIcon />
        </div>
        <h2 className={s["lock-title"]}>Job Matches</h2>
        <p className={s["lock-desc"]}>
          Kai filters the full job board down to roles that match your visa status, location, and target level.{" "}
          <span className={s["lock-count"]}>Support getdatjob for $10</span>{" "}
          to unlock daily matches and keep this project running.
        </p>
        <a
          href="venmo://paycharge?txn=pay&recipients=letiendat&amount=10&note=getdatjob"
          className={s["venmo-btn"]}
        >
          <VenmoIcon />
          Support on Venmo — $10 👊
        </a>
        <p className={s["lock-skip"]}>
          Kai job search still works — this just unlocks the filtered view.
        </p>
      </div>
    </div>
  );
}

// ── Profile Tab ───────────────────────────────────────────────────────────────

function ProfileTab({ profile, onGoToChat }: { profile: Profile; onGoToChat: () => void }) {
  const name = firstName(profile.full_name);
  return (
    <div className={s["profile-scroll"]}>
      <div className={s["profile-inner"]}>
        {/* Personal info */}
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

        {/* Preferences */}
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

        {/* Work experience */}
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
      </div>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

function SettingsTab({ profile, onSignOut }: { profile: Profile; onSignOut: () => void }) {
  return (
    <div className={s["settings-scroll"]}>
      <div className={s["settings-inner"]}>
        {/* Connected accounts */}
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

        {/* Supporter status */}
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

        {/* Notifications */}
        <div className={s["settings-card"]}>
          <div className={s["settings-card-head"]}>
            <h3 className={s["settings-card-title"]}>Notifications</h3>
          </div>
          <p className={s["notifications-placeholder"]}>
            Daily email alerts are coming soon. Kai will ping you when new matches drop.
          </p>
        </div>

        {/* Sign out */}
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

// ── SVG icons ─────────────────────────────────────────────────────────────────

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function LockIconSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

function VenmoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.5 3C20.9 5.4 21.5 7.8 21.5 10.8c0 6-5.1 13.8-9.2 13.8-3.9 0-5-4.5-7.4-9.6L7 13c1.3 2.8 2.1 4.8 3.3 4.8 1.5 0 3.3-3 3.3-6.5 0-2.3-.8-3.5-2.5-3.5-.9 0-1.7.3-2.5.6L10.1 3c1.8-.7 9.4-2.7 9.4 0z" />
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

  return (
    <div className={s.page}>
      {/* Nav */}
      <nav className={s.nav}>
        <div className={s["nav-inner"]}>
          <Link href="/" className={s.brand}>getdatjob</Link>
          <div className={s["nav-right"]}>
            <Link href="/jobs" className={s["nav-link"]}>Browse jobs</Link>
          </div>
        </div>
      </nav>

      {/* Me header */}
      <div className={s["me-header-wrap"]}>
        <div className={s["me-header"]}>
          <div className={s["me-avatar"]}>
            {profile.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatar_url} alt={profile.full_name ?? ""} />
            ) : (
              (name ?? "?")[0].toUpperCase()
            )}
          </div>
          <div className={s["me-greeting"]}>
            <span className={s["me-greeting-name"]}>
              Hey {name ?? "there"},
            </span>
            <span className={s["me-greeting-sub"]}>
              land your next role, visa-sponsored.
            </span>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className={s["tabs-wrap"]}>
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${activeTab === "chat" ? s["tab-active"] : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat with Kai
          </button>
          <button
            className={`${s.tab} ${activeTab === "matches" ? s["tab-active"] : ""}`}
            onClick={() => setActiveTab("matches")}
          >
            Job Matches
            {!profile.is_supporter && (
              <span className={s["tab-lock"]}>
                <LockIconSmall />
              </span>
            )}
          </button>
          <button
            className={`${s.tab} ${activeTab === "profile" ? s["tab-active"] : ""}`}
            onClick={() => setActiveTab("profile")}
          >
            Profile
          </button>
          <button
            className={`${s.tab} ${s["tab-settings"]} ${activeTab === "settings" ? s["tab-active"] : ""}`}
            onClick={() => setActiveTab("settings")}
            aria-label="Settings"
          >
            <GearIcon />
            <span className="sr-only">Settings</span>
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className={s["tab-content"]}>
        {activeTab === "chat" && (
          <ChatTab
            profile={profile}
            onGoToMatches={() => setActiveTab("matches")}
          />
        )}
        {activeTab === "matches" && (
          <MatchesTab isSupporter={profile.is_supporter} />
        )}
        {activeTab === "profile" && (
          <ProfileTab
            profile={profile}
            onGoToChat={() => setActiveTab("chat")}
          />
        )}
        {activeTab === "settings" && (
          <SettingsTab profile={profile} onSignOut={handleSignOut} />
        )}
      </div>
    </div>
  );
}
