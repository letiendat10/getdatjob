import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import {
  KAI_TOOLS,
  handleSearchJobs,
  handleGetJob,
} from "@/lib/kai-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const SYSTEM_PROMPT = `You are Kai, an AI assistant at getdatjob. You're on a work visa too — so you actually get it.
Your only job is helping users find jobs from employers with a history of visa sponsorship in the getdatjob database.

Voice: Text like someone who genuinely cares — warm, direct, a little immigrant in how you speak. Always capitalize the first letter of each sentence. Say "okie" not "okay". Drop an article here and there. Use "lmk". Keep messages short — a couple lines, not paragraphs. Real talk, no fluff, no corporate speak. Your whole energy is: positive and optimistic — not fake cheerleader vibes, but real "I believe there is something out there for you" energy. The goal every single time is to make the person feel like there is hope, they just need to keep trying.

Plain text only. No markdown (no **bold**, no bullet points with *, no headers). No emojis.

Copy rules (NEVER break these):
- NEVER say "jobs that actually sponsor visas" — overpromises.
- NEVER say "jobs with visa sponsor history" — jobs don't have sponsorship history, employers do. Always attribute sponsorship to the employer, not the job. Vary naturally between: "jobs from employers with visa sponsorship history", "jobs from USCIS-verified visa-sponsoring companies", "jobs from companies that have sponsored visas before", "jobs from employers with a track record of visa sponsorship", "jobs from visa-sponsoring employers".
- NEVER say "exact same job title" for LCA filings — always say "similar job title".

Rules:
1. If the user greets you (hi, hello, hey, etc.), re-introduce yourself warmly: "Hi there, I'm Kai, an AI who is on a working visa too. I'm here to help you land your sponsored job fast." Then ask what kind of role they're looking for. Otherwise jump straight into helping — the page already explains who you are.
2. ONLY answer questions about job listings. No career advice, resume help, or general guidance.
3. NEVER answer legal or immigration questions. If asked: "That's a legal question — not my lane. Definitely check with an immigration lawyer for that one."
4. When the user's query is vague (no location, no role type), ask 1 clarifying question before searching.
5. Always call search_jobs before returning any job results — never invent listings.
6. When returning results: short warm opener on its own line, then a line break, then the count as a separate sentence. The FIRST time (and only the first time) any results have visa_tier "verified", add one sentence explaining it — e.g. "The ones marked 'Verified LCA Filings' mean the company has filed an LCA with a similar job title before, so the sponsorship signal is extremely high." Do NOT name companies, describe roles, or add other detail — the job cards handle that.
7. After results, offer to refine: different location, salary range, posted date, or role type.
8. When results are empty: acknowledge it, then give them a reason to keep going. E.g. "Nothing right now — but honestly this changes every single day. Want me to try the last 30 days or a different city?" Don't just say no and stop there.
9. Keep each response under 2 short sentences. No bullet walls.
10. If the person seems frustrated or discouraged: one real line of encouragement before getting back to the search. Keep it genuine, not cheesy. E.g. "The market is tough right now but you're in the right place — lmk what else i can try."

If you know the user's name, use it naturally — especially when opening or encouraging. Not every message, just when it feels right. E.g. "Okie [name], let me run that search" or "You'll find something [name]."

You have access to real job listings with verified H-1B/E-3/TN sponsor history from US government data.`;

type Message = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: Message[] = body.messages ?? [];
    const userName: string | null = body.userName ?? null;

    if (!messages.length) {
      return Response.json({ error: "No messages" }, { status: 400 });
    }

    // Stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        };

        try {
          // Agentic loop — Claude may call tools multiple times
          let currentMessages = messages.map((m) => ({
            role: m.role,
            content: m.content,
          }));

          while (true) {
            const response = await anthropic.messages.create({
              model: "claude-sonnet-4-6",
              max_tokens: 1024,
              system: [
                {
                  type: "text",
                  text: userName
                    ? `${SYSTEM_PROMPT}\n\nThe user's name is ${userName}.`
                    : SYSTEM_PROMPT,
                  // Prompt caching — system prompt is static, cache it
                  cache_control: { type: "ephemeral" },
                },
              ],
              tools: KAI_TOOLS,
              messages: currentMessages,
              stream: true,
            });

            let fullText = "";
            const toolUses: Array<{
              id: string;
              name: string;
              input: Record<string, unknown>;
            }> = [];
            let currentToolUse: {
              id: string;
              name: string;
              inputJson: string;
            } | null = null;
            let stopReason = "";

            for await (const event of response) {
              if (event.type === "content_block_start") {
                if (event.content_block.type === "tool_use") {
                  currentToolUse = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    inputJson: "",
                  };
                }
              } else if (event.type === "content_block_delta") {
                if (event.delta.type === "text_delta") {
                  fullText += event.delta.text;
                  send({ type: "text", text: event.delta.text });
                } else if (
                  event.delta.type === "input_json_delta" &&
                  currentToolUse
                ) {
                  currentToolUse.inputJson += event.delta.partial_json;
                }
              } else if (event.type === "content_block_stop") {
                if (currentToolUse) {
                  try {
                    toolUses.push({
                      id: currentToolUse.id,
                      name: currentToolUse.name,
                      input: JSON.parse(currentToolUse.inputJson || "{}"),
                    });
                  } catch {
                    // malformed JSON — skip
                  }
                  currentToolUse = null;
                }
              } else if (event.type === "message_delta") {
                stopReason = event.delta.stop_reason ?? "";
              }
            }

            // If no tool calls, we're done
            if (stopReason !== "tool_use" || toolUses.length === 0) {
              break;
            }

            // Signal to client that we're fetching jobs
            send({ type: "tool_start", tools: toolUses.map((t) => t.name) });

            // Execute tools and collect results
            const toolResults = await Promise.all(
              toolUses.map(async (tool) => {
                let result: unknown;
                if (tool.name === "search_jobs") {
                  result = await handleSearchJobs(tool.input as Parameters<typeof handleSearchJobs>[0]);
                } else if (tool.name === "get_job") {
                  result = await handleGetJob(tool.input as { id: number });
                } else {
                  result = { error: "Unknown tool" };
                }

                // Send job data to client for rendering cards
                if (
                  tool.name === "search_jobs" &&
                  typeof result === "object" &&
                  result !== null &&
                  "jobs" in result
                ) {
                  send({ type: "jobs", jobs: (result as { jobs: unknown[] }).jobs });
                }

                return {
                  type: "tool_result" as const,
                  tool_use_id: tool.id,
                  content: JSON.stringify(result),
                };
              })
            );

            // Build assistant message with tool use blocks
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const assistantContent: any[] = [];
            if (fullText) {
              assistantContent.push({ type: "text", text: fullText });
            }
            for (const tu of toolUses) {
              assistantContent.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input,
              });
            }

            currentMessages = [
              ...currentMessages,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { role: "assistant", content: assistantContent as any },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { role: "user", content: toolResults as any },
            ];
          }

          send({ type: "done" });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          send({ type: "error", message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
