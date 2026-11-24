import { msg, useGT } from "gt-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { refreshSwarmBoardAccess, useSwarmBoardAccessState } from "~/state/swarmBoard";
import { SwarmWorkerSessionView } from "./SwarmWorkerSessionView";

interface SwarmPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly workspaceRoot: string | undefined;
  readonly onOpenFile: (relativePath: string) => void;
}

function swarmThemeTokens(theme: ReturnType<typeof useHtmlRenderTheme>): Record<string, string> {
  const vars = theme.variables;
  return {
    ...vars,
    ...(vars["--border"] ? { "--card-border": vars["--border"] } : {}),
    ...(vars["--muted-foreground"] ? { "--placeholder": vars["--muted-foreground"] } : {}),
    ...(vars["--destructive"] ? { "--error": vars["--destructive"] } : {}),
    ...(vars["--font-sans"] ? { "--font-family": vars["--font-sans"] } : {}),
    ...(vars["--font-mono"] ? { "--editor-font-family": vars["--font-mono"] } : {}),
  };
}

function relativeWorkspacePathFromFileUri(
  uri: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!workspaceRoot) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(decodedPath)) {
    decodedPath = decodedPath.slice(1);
  }
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedTarget = decodedPath.replace(/\\/g, "/");
  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedRoot);
  const rootPrefix = `${caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot}/`;
  const targetComparable = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  if (!targetComparable.startsWith(rootPrefix)) return null;
  const relativePath = normalizedTarget.slice(rootPrefix.length);
  return relativePath.length > 0 ? relativePath : null;
}

function postThemeToIframe(
  iframe: HTMLIFrameElement | null,
  theme: ReturnType<typeof useHtmlRenderTheme>,
): void {
  const contentWindow = iframe?.contentWindow;
  if (!contentWindow) return;
  contentWindow.postMessage(
    {
      type: "t3-swarm:theme",
      tokens: swarmThemeTokens(theme),
      scheme: theme.appearance,
    },
    "*",
  );
}

export function SwarmPanel(props: SwarmPanelProps) {
  const { threadRef, visible, workspaceRoot, onOpenFile } = props;
  const gt = useGT();
  const { access, isFailure, isWaiting } = useSwarmBoardAccessState(threadRef.environmentId, {
    retry: visible,
  });
  const theme = useHtmlRenderTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [expiredTicket, setExpiredTicket] = useState<string | null>(null);
  const [sessionBaseUrl, setSessionBaseUrl] = useState<string | null>(null);
  const [activeWorkerConversationId, setActiveWorkerConversationId] = useState<string | null>(null);

  const currentTicket = access?.query.wsTicket ?? null;
  const waitingForFreshTicket =
    expiredTicket !== null && currentTicket !== null && expiredTicket === currentTicket;

  const triggerTokenRenewal = () => {
    setSessionBaseUrl(null);
    setActiveWorkerConversationId(null);
    if (currentTicket !== null) {
      setExpiredTicket(currentTicket);
      refreshSwarmBoardAccess(threadRef.environmentId);
    } else {
      setReloadNonce((current) => current + 1);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes active T3 theme tokens into the embedded swarm iframe whenever the theme changes
  useEffect(() => {
    postThemeToIframe(iframeRef.current, theme);
  }, [theme]);

  const handleFrameMessage = useEffectEvent((event: MessageEvent) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || event.source !== frameWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "t3-swarm:ready") {
      if (typeof data.baseUrl === "string" && data.baseUrl.length > 0) {
        setSessionBaseUrl(data.baseUrl);
      }
      postThemeToIframe(iframeRef.current, theme);
      return;
    }
    if (data.type === "t3-swarm:token-expired") {
      triggerTokenRenewal();
      return;
    }
    if (data.type === "t3-swarm:open-file" && typeof data.uri === "string") {
      const relativePath = relativeWorkspacePathFromFileUri(data.uri, workspaceRoot);
      if (relativePath !== null) {
        onOpenFile(relativePath);
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: m(msg("File is outside the active workspace")),
            description: data.uri.replace(/^file:\/\//, ""),
          }),
        );
      }
      return;
    }
    if (data.type === "t3-swarm:open-conversation" && typeof data.conversationId === "string") {
      if (typeof data.baseUrl === "string" && data.baseUrl.length > 0) {
        setSessionBaseUrl(data.baseUrl);
      }
      setActiveWorkerConversationId(data.conversationId);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to postMessage bridge events emitted by the swarm board iframe
  useEffect(() => {
    const listener = (event: MessageEvent) => handleFrameMessage(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  const handleCloseWorkerView = () => {
    setActiveWorkerConversationId(null);
    iframeRef.current?.focus();
  };

  if (access === null || waitingForFreshTicket) {
    if (isFailure && !isWaiting) {
      return (
        <div
          role="alert"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-background px-4 text-center text-xs text-muted-foreground"
        >
          <p className="m-0 text-destructive">{gt("Could not connect to the Swarm board.")}</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => refreshSwarmBoardAccess(threadRef.environmentId)}
          >
            {gt("Retry")}
          </Button>
        </div>
      );
    }
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center bg-background text-muted-foreground"
      >
        <div className="flex items-center gap-2 text-xs">
          <Spinner className="size-3.5" />
          <span>{gt("Connecting to Swarm board…")}</span>
        </div>
      </div>
    );
  }

  const baseUrl = `${access.httpBase.replace(/\/+$/, "")}/t/${encodeURIComponent(threadRef.threadId)}/`;
  const search = new URLSearchParams(access.query);
  if (reloadNonce > 0) {
    search.set("r", String(reloadNonce));
  }
  const queryString = search.toString();
  const src = queryString.length > 0 ? `${baseUrl}?${queryString}` : baseUrl;
  const showingWorker = activeWorkerConversationId !== null && sessionBaseUrl !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {showingWorker ? (
        <SwarmWorkerSessionView
          key={activeWorkerConversationId}
          sessionBaseUrl={sessionBaseUrl}
          conversationId={activeWorkerConversationId}
          visible={visible}
          onBack={handleCloseWorkerView}
          onTokenExpired={triggerTokenRenewal}
        />
      ) : null}
      <iframe
        ref={iframeRef}
        key={`${threadRef.environmentId}:${threadRef.threadId}:${currentTicket ?? "cookie"}:${reloadNonce}`}
        src={src}
        title={gt("Swarm board")}
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        className={cn(
          "h-full min-h-0 w-full flex-1 border-0 bg-background",
          showingWorker && "hidden",
        )}
        onLoad={() => postThemeToIframe(iframeRef.current, theme)}
      />
    </div>
  );
}
