import { useGT } from "gt-react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

interface SwarmMemberSummary {
  readonly name: string;
  readonly conversationId: string;
  readonly role: string;
  readonly model: string;
  readonly wakeMode: string;
  readonly killed: boolean;
  readonly lastReadSeq: number;
}

interface SwarmTranscriptToolCall {
  readonly name: string;
  readonly args: unknown;
}

interface SwarmTranscriptStep {
  readonly stepIndex: number;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly thinking: string | null;
  readonly content: string | null;
  readonly error: string | null;
  readonly toolCalls: ReadonlyArray<SwarmTranscriptToolCall>;
}

interface SwarmMemberTranscriptResponse {
  readonly conversationId: string;
  readonly swarmId: string;
  readonly swarmTitle: string;
  readonly member: SwarmMemberSummary;
  readonly truncated: boolean;
  readonly steps: ReadonlyArray<SwarmTranscriptStep>;
}

interface SwarmWorkerSessionViewProps {
  readonly sessionBaseUrl: string;
  readonly conversationId: string;
  readonly visible: boolean;
  readonly onBack: () => void;
  readonly onTokenExpired: () => void;
}

const POLL_INTERVAL_MS = 2_500;
const ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`)
  .join(",");

function formatStepTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
}

function unwrapSystemMessage(content: string): {
  readonly sender: string | null;
  readonly body: string;
} {
  const match = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(content);
  const inner = (match?.[1] ?? content).trim();
  const headerMatch = /^\[Message\][^\n]*?sender=([^\s]+)[^\n]*?content=([\s\S]*)$/i.exec(inner);
  if (headerMatch) {
    return {
      sender: headerMatch[1] ?? null,
      body: (headerMatch[2] ?? "").trim(),
    };
  }
  return { sender: null, body: inner };
}

function summarizeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["toolSummary", "CommandLine", "Path", "Query", "Message", "action", "since"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim().length > 0) {
      const clean = val.trim().replace(/^"|"$/g, "");
      return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
    }
    if (typeof val === "number") {
      return `${key}=${val}`;
    }
  }
  const serialized = JSON.stringify(args);
  return serialized.length > 90 ? `${serialized.slice(0, 87)}…` : serialized;
}

function formatJsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolCallEntriesWithKeys(
  stepIndex: number,
  toolCalls: ReadonlyArray<SwarmTranscriptToolCall>,
): ReadonlyArray<{ readonly key: string; readonly call: SwarmTranscriptToolCall }> {
  const seen = new Map<string, number>();
  return toolCalls.map((call) => {
    const base = `${stepIndex}:${call.name}:${summarizeToolArgs(call.args)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: count === 1 ? base : `${base}#${count}`, call };
  });
}

function CollapsibleBlock(props: {
  readonly title: string;
  readonly preview?: string;
  readonly defaultOpen?: boolean;
  readonly tone?: "default" | "muted" | "error";
  readonly children: string;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const toneClass =
    props.tone === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : props.tone === "muted"
        ? "border-border/60 bg-muted/30 text-muted-foreground"
        : "border-border/70 bg-card/60 text-foreground";

  return (
    <div className={cn("overflow-hidden rounded-md border text-xs", toneClass)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />
        )}
        <span className="shrink-0 font-medium">{props.title}</span>
        {!open && props.preview ? (
          <span className="min-w-0 flex-1 truncate opacity-75">{props.preview}</span>
        ) : null}
      </button>
      {open ? (
        <pre className="m-0 max-h-80 overflow-auto border-t border-border/50 px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words">
          {props.children}
        </pre>
      ) : null}
    </div>
  );
}

function InlineStepError(props: { readonly message: string }) {
  return (
    <pre className="m-0 max-h-48 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-destructive">
      {props.message}
    </pre>
  );
}

function StepCard(props: { readonly step: SwarmTranscriptStep }) {
  const { step } = props;
  const gt = useGT();
  const time = formatStepTime(step.createdAt);
  const isError = step.status === "ERROR" || step.error !== null;

  if (step.type === "SYSTEM_MESSAGE" || step.type === "USER_INPUT") {
    const raw = step.content ?? "";
    const { sender, body } =
      step.type === "SYSTEM_MESSAGE" ? unwrapSystemMessage(raw) : { sender: null, body: raw };
    const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
    const preview = firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {step.type === "USER_INPUT" ? gt("User") : gt("Incoming message")}
          </span>
          {sender ? (
            <span className="font-mono text-3xs opacity-75">{sender.slice(0, 8)}</span>
          ) : null}
          <span className="ml-auto font-mono text-3xs opacity-75">
            #{step.stepIndex}
            {time ? ` · ${time}` : ""}
          </span>
        </div>
        {body.length > 360 ? (
          <CollapsibleBlock title={gt("Message")} preview={preview} tone="muted">
            {body}
          </CollapsibleBlock>
        ) : body.length > 0 ? (
          <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
            {body}
          </div>
        ) : null}
        {step.error ? <InlineStepError message={step.error} /> : null}
      </div>
    );
  }

  if (step.type === "PLANNER_RESPONSE") {
    const thinkingPreview = step.thinking
      ? step.thinking.replace(/\s+/g, " ").trim().slice(0, 90)
      : "";
    const tokenLabel =
      step.inputTokens !== null || step.outputTokens !== null
        ? gt("{inputTokens} in / {outputTokens} out", {
            inputTokens: String(step.inputTokens ?? 0),
            outputTokens: String(step.outputTokens ?? 0),
          })
        : null;
    const keyedToolCalls = toolCallEntriesWithKeys(step.stepIndex, step.toolCalls);
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/50 p-2.5">
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="font-medium text-foreground">{step.model ?? gt("Assistant")}</span>
          {tokenLabel ? <span className="font-mono text-3xs opacity-75">{tokenLabel}</span> : null}
          <span className="ml-auto font-mono text-3xs opacity-75">
            #{step.stepIndex}
            {time ? ` · ${time}` : ""}
          </span>
        </div>

        {step.thinking ? (
          <CollapsibleBlock title={gt("Thinking")} preview={thinkingPreview} tone="muted">
            {step.thinking}
          </CollapsibleBlock>
        ) : null}

        {step.content ? (
          <div className="text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
            {step.content}
          </div>
        ) : null}

        {keyedToolCalls.length > 0 ? (
          <div className="flex flex-col gap-1">
            {keyedToolCalls.map(({ key, call }) => (
              <CollapsibleBlock key={key} title={call.name} preview={summarizeToolArgs(call.args)}>
                {formatJsonPretty(call.args)}
              </CollapsibleBlock>
            ))}
          </div>
        ) : null}

        {step.error ? <InlineStepError message={step.error} /> : null}
      </div>
    );
  }

  if (isError) {
    const message = step.error ?? step.content ?? gt("Step failed");
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
        <div className="flex items-center gap-1.5 text-2xs font-medium text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span>{gt("Tool / step error")}</span>
          <span className="ml-auto font-mono text-3xs opacity-80">
            #{step.stepIndex}
            {time ? ` · ${time}` : ""}
          </span>
        </div>
        <pre className="m-0 max-h-60 overflow-auto font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-destructive">
          {message}
        </pre>
      </div>
    );
  }

  const output = step.content ?? "";
  if (output.length === 0) return null;
  const firstLine = output
    .split(/\r?\n/)
    .find(
      (line) =>
        line.trim().length > 0 &&
        !line.startsWith("Created At:") &&
        !line.startsWith("Completed At:"),
    )
    ?.trim();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <WrenchIcon className="size-3 shrink-0 opacity-70" />
        <span>{gt("Tool output")}</span>
        <span className="ml-auto font-mono text-3xs opacity-75">
          #{step.stepIndex}
          {time ? ` · ${time}` : ""}
        </span>
      </div>
      <CollapsibleBlock
        title={gt("Result")}
        preview={firstLine ? firstLine.slice(0, 96) : output.slice(0, 96)}
        tone="muted"
      >
        {output}
      </CollapsibleBlock>
    </div>
  );
}

type TranscriptFetchResult =
  | { readonly kind: "ok"; readonly data: SwarmMemberTranscriptResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message?: string }
  | { readonly kind: "aborted" };

async function fetchSwarmMemberTranscript(
  baseUrl: string,
  targetConversationId: string,
  signal?: AbortSignal,
): Promise<TranscriptFetchResult> {
  try {
    const endpoint = new URL("api/member-transcript", baseUrl);
    endpoint.searchParams.set("conversationId", targetConversationId);
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401) {
      return { kind: "unauthorized" };
    }
    if (!response.ok) {
      return { kind: "error" };
    }
    const data = (await response.json()) as SwarmMemberTranscriptResponse;
    return { kind: "ok", data };
  } catch (cause) {
    if (signal?.aborted) {
      return { kind: "aborted" };
    }
    return {
      kind: "error",
      ...(cause instanceof Error ? { message: cause.message } : {}),
    };
  }
}

export function SwarmWorkerSessionView(props: SwarmWorkerSessionViewProps) {
  const { sessionBaseUrl, conversationId, visible, onBack, onTokenExpired } = props;
  const gt = useGT();
  const [data, setData] = useState<SwarmMemberTranscriptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestSeqRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const retired = data?.member.killed === true;

  const handleTokenExpired = useEffectEvent(() => {
    onTokenExpired();
  });

  const handleBack = useEffectEvent(() => {
    onBack();
  });

  const loadErrorFallback = useEffectEvent(() => gt("Could not load worker conversation."));

  const applyFetchResult = useEffectEvent((seq: number, result: TranscriptFetchResult) => {
    if (!mountedRef.current || requestSeqRef.current !== seq) return;
    setRefreshing(false);
    if (result.kind === "aborted") return;
    if (result.kind === "unauthorized") {
      handleTokenExpired();
      return;
    }
    if (result.kind === "error") {
      setError(result.message ?? loadErrorFallback());
      setLoading(false);
      return;
    }
    setData(result.data);
    setError(null);
    setLoading(false);
  });

  const handleManualRefresh = () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setRefreshing(true);
    void fetchSwarmMemberTranscript(sessionBaseUrl, conversationId).then((result) => {
      applyFetchResult(seq, result);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount lifecycle and cleans up the copy confirmation timeout
  useEffect(() => {
    mountedRef.current = true;
    backButtonRef.current?.focus();
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads and live-polls the selected worker's transcript while the panel is visible and the worker is active
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const poll = () => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      void fetchSwarmMemberTranscript(sessionBaseUrl, conversationId, controller.signal).then(
        (result) => {
          applyFetchResult(seq, result);
        },
      );
    };
    poll();
    if (retired) {
      return () => controller.abort();
    }
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      poll();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sessionBaseUrl, conversationId, visible, retired]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds Escape to close the worker conversation overlay back to the Swarm board when visible and no overlay owns focus
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(ESCAPE_BLOCKING_OVERLAY_SELECTOR)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      handleBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  const handleCopyId = () => {
    void navigator.clipboard
      ?.writeText(conversationId)
      .then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          if (mountedRef.current) setCopied(false);
        }, 1500);
      })
      .catch(() => undefined);
  };

  const allSteps = data?.steps ?? [];
  const errorCount = allSteps.filter(
    (step) => step.status === "ERROR" || step.error !== null,
  ).length;
  const visibleSteps = errorsOnly
    ? allSteps.filter((step) => step.status === "ERROR" || step.error !== null)
    : allSteps;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          ref={backButtonRef}
          size="xs"
          variant="ghost"
          onClick={onBack}
          aria-label={gt("Back to Swarm")}
        >
          <ArrowLeftIcon className="size-3.5" />
          <span>{gt("Swarm")}</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-foreground">
              {data ? `@${data.member.name}` : conversationId.slice(0, 12)}
            </span>
            {data?.member.role ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                {data.member.role}
              </span>
            ) : null}
            {data?.member.killed ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                {gt("Retired")}
              </span>
            ) : null}
          </div>
          {data?.member.model ? (
            <span className="truncate font-mono text-3xs text-muted-foreground">
              {data.member.model} · {allSteps.length} {gt("steps")}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {errorCount > 0 || errorsOnly ? (
            <Button
              size="xs"
              variant={errorsOnly ? "destructive" : "outline"}
              aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly((current) => !current)}
            >
              {gt("Errors")} ({errorCount})
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={handleCopyId}
            title={copied ? gt("Copied conversation ID") : gt("Copy conversation ID")}
            aria-label={copied ? gt("Copied conversation ID") : gt("Copy conversation ID")}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={refreshing}
            onClick={handleManualRefresh}
            title={gt("Refresh")}
            aria-label={gt("Refresh")}
          >
            <RefreshCwIcon className={cn("size-3.5", refreshing && "opacity-50")} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {loading && data === null ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <Spinner className="size-3.5" />
            <span>{gt("Loading worker conversation…")}</span>
          </div>
        ) : error !== null && data === null ? (
          <div
            role="alert"
            className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground"
          >
            <p className="m-0 text-destructive">{error}</p>
            <Button size="xs" variant="outline" onClick={handleManualRefresh}>
              {gt("Retry")}
            </Button>
          </div>
        ) : (
          <>
            {error !== null ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-2xs text-destructive"
              >
                <span className="truncate">{error}</span>
                <Button size="xs" variant="ghost" onClick={handleManualRefresh}>
                  {gt("Retry")}
                </Button>
              </div>
            ) : null}
            {data?.truncated ? (
              <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-2xs text-muted-foreground">
                {gt("Showing the most recent steps of this worker conversation.")}
              </div>
            ) : null}
            {visibleSteps.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <span>
                  {errorsOnly
                    ? gt("No errors in this worker session.")
                    : gt("No transcript steps yet.")}
                </span>
                {errorsOnly ? (
                  <Button size="xs" variant="outline" onClick={() => setErrorsOnly(false)}>
                    {gt("Show all steps")}
                  </Button>
                ) : null}
              </div>
            ) : (
              visibleSteps.map((step) => (
                <StepCard key={`${step.stepIndex}-${step.type}`} step={step} />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
