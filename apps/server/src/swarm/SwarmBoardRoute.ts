import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { authenticateMediaRequest } from "../auth/http.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  dispatchSwarmBoardRequest,
  findSwarmBoardDirectory,
  readSwarmMemberTranscript,
  resolveSwarmAppDataDirectory,
} from "./SwarmBoardHost.ts";
import { renderSwarmBoardUnavailableHtml } from "./SwarmBoardPreload.ts";

export const SWARM_BOARD_ROUTE_PREFIX = "/api/swarm-board";
const SWARM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const SIGNED_URL_ROUTE_OPTIONS = { redactedParams: ["*"] };

const SwarmTokenClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("swarm-board"),
  threadId: ThreadId,
  expiresAt: Schema.Number,
});

const encodeSwarmTokenClaims = Schema.encodeSync(Schema.fromJsonString(SwarmTokenClaimsSchema));
const encodeJsonPayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeSwarmTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(SwarmTokenClaimsSchema),
);

const SIGNED_SESSION_BASE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Signed token routes use no cookies; allow opaque-origin sandboxed iframes to poll and detect 401.
  "access-control-allow-origin": "*",
} as const;

function decodeBase64UrlSafe(input: string): string | null {
  try {
    return base64UrlDecodeUtf8(input);
  } catch {
    return null;
  }
}

function decodeUriSegment(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

const signSwarmToken = Effect.fn("SwarmBoardRoute.signSwarmToken")(function* (threadId: ThreadId) {
  const signer = yield* AssetSigner.AssetSigner;
  const now = yield* Clock.currentTimeMillis;
  const payload = base64UrlEncode(
    encodeSwarmTokenClaims({
      version: 1,
      kind: "swarm-board",
      threadId,
      expiresAt: now + SWARM_TOKEN_TTL_MS,
    }),
  );
  const signature = yield* signer.sign(payload);
  return `${payload}.${signature}`;
});

const verifySwarmToken = Effect.fn("SwarmBoardRoute.verifySwarmToken")(function* (token: string) {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1 || token.indexOf(".", dotIndex + 1) !== -1) {
    return null;
  }
  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const signer = yield* AssetSigner.AssetSigner;
  const valid = yield* signer.verify(payload, signature).pipe(Effect.orElseSucceed(() => false));
  if (!valid) return null;
  const decodedJson = decodeBase64UrlSafe(payload);
  if (decodedJson === null) return null;
  const claims = decodeSwarmTokenClaims(decodedJson);
  if (Option.isNone(claims)) return null;
  const now = yield* Clock.currentTimeMillis;
  if (claims.value.expiresAt <= now) return null;
  return claims.value;
});

const resolveThreadAntigravityContext = Effect.fn("SwarmBoardRoute.resolveThreadContext")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const digest = yield* Digest.Digest;
    const path = yield* Path.Path;

    const records = yield* threads
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.orElseSucceed(() => null));
    if (records === null) {
      return { appDataDir: null, conversationId: null };
    }

    const activeId = records.thread.activeProviderThreadId;
    const antigravityThreads = records.providerThreads.filter(
      (candidate) =>
        candidate.driver === "antigravity" &&
        candidate.nativeThreadRef !== null &&
        candidate.nativeThreadRef.nativeId !== null &&
        candidate.nativeThreadRef.nativeId.length > 0,
    );
    const selected =
      antigravityThreads.find((candidate) => candidate.id === activeId) ??
      antigravityThreads.toSorted((left, right) => {
        const leftTs = String(left.updatedAt ?? "");
        const rightTs = String(right.updatedAt ?? "");
        return rightTs < leftTs ? -1 : rightTs > leftTs ? 1 : 0;
      })[0];

    if (selected === undefined || selected.nativeThreadRef === null) {
      return { appDataDir: null, conversationId: null };
    }

    const directories = yield* resolveAntigravityInstanceDirectories(
      stateDir,
      selected.providerInstanceId,
    ).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => null),
    );
    if (directories === null) {
      return { appDataDir: null, conversationId: null };
    }

    const primaryAppDataDir = path.join(directories.profile, "antigravity-acp");
    const conversationId = selected.nativeThreadRef.nativeId;
    const appDataDir =
      conversationId !== null
        ? yield* Effect.promise(() =>
            resolveSwarmAppDataDirectory({
              stateDir,
              primaryAppDataDir,
              conversationId,
            }),
          )
        : primaryAppDataDir;

    return {
      appDataDir,
      conversationId,
    };
  },
);

const entryRouteLayer = HttpRouter.add(
  "GET",
  `${SWARM_BOARD_ROUTE_PREFIX}/t/*`,
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const prefix = `${SWARM_BOARD_ROUTE_PREFIX}/t/`;
    const suffix = url.value.pathname.slice(prefix.length);
    const trailingSlash = suffix.endsWith("/");
    const rawThreadId = (trailingSlash ? suffix.slice(0, -1) : suffix).trim();
    if (rawThreadId.length === 0 || rawThreadId.includes("/")) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const decodedThreadId = decodeUriSegment(rawThreadId);
    const parsedThreadId =
      decodedThreadId === null ? Option.none() : decodeThreadId(decodedThreadId);
    if (Option.isNone(parsedThreadId)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const token = yield* signSwarmToken(parsedThreadId.value).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (token === null) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    const relativePrefix = trailingSlash ? "../../s/" : "../s/";
    return HttpServerResponse.empty({
      status: 302,
      headers: {
        location: `${relativePrefix}${token}/`,
        "cache-control": "private, no-store",
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

class SwarmBoardHostError extends Schema.TaggedError<SwarmBoardHostError>()("SwarmBoardHostError", {
  cause: Schema.Defect(),
}) {}

const trySwarmPromise = <A>(evaluate: () => Promise<A>): Effect.Effect<A | null> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SwarmBoardHostError({ cause }),
  }).pipe(Effect.orElseSucceed(() => null));

const sessionRouteLayer = HttpRouter.add(
  "GET",
  `${SWARM_BOARD_ROUTE_PREFIX}/s/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const prefix = `${SWARM_BOARD_ROUTE_PREFIX}/s/`;
    const suffix = url.value.pathname.slice(prefix.length);
    const slashIndex = suffix.indexOf("/");
    const token = slashIndex === -1 ? suffix : suffix.slice(0, slashIndex);
    if (token.length === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const claims = yield* verifySwarmToken(token);
    if (claims === null) {
      return HttpServerResponse.text("Unauthorized", {
        status: 401,
        headers: SIGNED_SESSION_BASE_HEADERS,
      });
    }

    if (slashIndex === -1) {
      return HttpServerResponse.empty({
        status: 302,
        headers: {
          location: `./${token}/`,
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }

    const subPath = suffix.slice(slashIndex) || "/";
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const context = yield* resolveThreadAntigravityContext(claims.threadId);

    if (subPath === "/api/member-transcript") {
      const targetConversationId = url.value.searchParams.get("conversationId")?.trim() ?? "";
      if (
        context.appDataDir === null ||
        context.conversationId === null ||
        targetConversationId.length === 0
      ) {
        return HttpServerResponse.text("Not Found", {
          status: 404,
          headers: SIGNED_SESSION_BASE_HEADERS,
        });
      }
      const transcript = yield* trySwarmPromise(() =>
        readSwarmMemberTranscript({
          appDataDir: context.appDataDir!,
          threadConversationId: context.conversationId!,
          targetConversationId,
        }),
      );
      if (transcript === null) {
        return HttpServerResponse.text("Not Found", {
          status: 404,
          headers: SIGNED_SESSION_BASE_HEADERS,
        });
      }
      return HttpServerResponse.text(encodeJsonPayload(transcript), {
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: SIGNED_SESSION_BASE_HEADERS,
      });
    }

    const swarmBoardDir = yield* trySwarmPromise(() =>
      findSwarmBoardDirectory(stateDir, context.appDataDir),
    );

    if (swarmBoardDir === null) {
      if (subPath === "/preload.js") {
        const preload = yield* trySwarmPromise(() =>
          dispatchSwarmBoardRequest({
            swarmBoardDir: "",
            appDataDir: null,
            conversationId: null,
            routePath: "/preload.js",
            searchParams: url.value.searchParams,
          }),
        );
        if (preload === null) {
          return HttpServerResponse.text("Swarm board runtime is unavailable.", {
            status: 503,
            headers: SIGNED_SESSION_BASE_HEADERS,
          });
        }
        return HttpServerResponse.text(String(preload.body), {
          status: preload.status,
          contentType: preload.contentType,
          headers: { ...SIGNED_SESSION_BASE_HEADERS, ...preload.headers },
        });
      }
      if (subPath === "/") {
        return HttpServerResponse.text(renderSwarmBoardUnavailableHtml(), {
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: SIGNED_SESSION_BASE_HEADERS,
        });
      }
      return HttpServerResponse.text("Not Found", {
        status: 404,
        headers: SIGNED_SESSION_BASE_HEADERS,
      });
    }

    const dispatched = yield* trySwarmPromise(() =>
      dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir: context.appDataDir,
        conversationId: context.conversationId,
        routePath: subPath,
        searchParams: url.value.searchParams,
      }),
    );

    if (dispatched === null) {
      return HttpServerResponse.text("Swarm board request failed.", {
        status: 503,
        headers: SIGNED_SESSION_BASE_HEADERS,
      });
    }

    const responseHeaders = {
      ...SIGNED_SESSION_BASE_HEADERS,
      ...dispatched.headers,
    };

    return typeof dispatched.body === "string"
      ? HttpServerResponse.text(dispatched.body, {
          status: dispatched.status,
          contentType: dispatched.contentType,
          headers: responseHeaders,
        })
      : HttpServerResponse.uint8Array(dispatched.body, {
          status: dispatched.status,
          contentType: dispatched.contentType,
          headers: responseHeaders,
        });
  }),
  SIGNED_URL_ROUTE_OPTIONS,
);

export const layer = Layer.mergeAll(entryRouteLayer, sessionRouteLayer);
