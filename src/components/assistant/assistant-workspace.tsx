"use client";

import { Bot, Clock, SendHorizontal, User } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AiExplanationExample } from "@/components/shared/ai-explanation-example";
import { DemoBadge } from "@/components/shared/demo";
import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/ui/status";

const EXAMPLE_PROMPTS = [
  "Why is BTC showing a bullish reversal setup?",
  "Which markets have the strongest developing setups?",
  "Explain the current structure on ETH.",
  "Show me today's strongest breakout setups.",
  "Why was this setup scored 87/100?",
];

interface Message {
  id: string;
  role: "user" | "system";
  text: string;
}

const NOT_CONNECTED =
  "Live intelligence will be connected in a later phase. When it is, this question will be answered from scanner results, market structure, zones, liquidity, and historical validation — with the evidence cited. No analysis has been generated for this message.";

export function AssistantWorkspace() {
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const stamp = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: `u-${stamp}`, role: "user", text: trimmed },
      { id: `s-${stamp}`, role: "system", text: NOT_CONNECTED },
    ]);
    setDraft("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  };

  return (
    <section
      aria-label="Market Intelligence Assistant"
      className="flex min-h-[560px] flex-col rounded-lg border border-border bg-surface lg:h-[calc(100dvh-14rem)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-info" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Market Intelligence Assistant</h2>
        </div>
        <ConnectionBadge status="disconnected" />
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-4" aria-live="polite">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <DemoBadge />
            <span className="text-[11px] text-subtle-foreground">
              Example of how answers will look — not generated
            </span>
          </div>
          <AiExplanationExample />
        </div>

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-elevated">
                <User className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="pt-1 text-sm">
                <span className="sr-only">You: </span>
                {message.text}
              </p>
            </div>
          ) : (
            <div key={message.id} className="flex items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning-muted">
                <Clock className="size-3.5 text-warning" aria-hidden="true" />
              </div>
              <p className="rounded-lg border border-dashed border-warning/30 bg-warning-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-warning">Not connected. </span>
                {message.text}
              </p>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      <div className="space-y-3 border-t border-border p-3 sm:p-4">
        <ul
          className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
          aria-label="Example prompts"
        >
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt} className="shrink-0">
              <button
                type="button"
                onClick={() => {
                  setDraft(prompt);
                  inputRef.current?.focus();
                }}
                className="rounded-full border border-border px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            Ask about setups, structure, or scores
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a setup, its score, or market structure…"
            className="min-h-11 flex-1 resize-none rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:outline-none"
          />
          <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Send">
            <SendHorizontal />
          </Button>
        </form>
        <p className="text-[11px] text-subtle-foreground">
          Enter to send · Shift+Enter for a new line. The assistant explains evidence; it does not
          give buy or sell instructions.
        </p>
      </div>
    </section>
  );
}
