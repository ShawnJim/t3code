import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const SWARM_BOARD_BASE_PATH = "/api/swarm-board";
const ACCESS_RETRY_INTERVAL_MS = 10_000;

const swarmBoardAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: SWARM_BOARD_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`swarm-board-access:${environmentId}`)),
);

const retryingSwarmBoardAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const access = swarmBoardAccessAtom(environmentId);
    const result = get(access);
    if (AsyncResult.isFailure(result) && !result.waiting) {
      const timer = setTimeout(() => get.refresh(access), ACCESS_RETRY_INTERVAL_MS);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }),
);

export interface SwarmBoardAccessState {
  readonly access: DeviceHubAccess | null;
  readonly isFailure: boolean;
  readonly isWaiting: boolean;
}

export function useSwarmBoardAccessState(
  environmentId: EnvironmentId,
  options?: { readonly retry: boolean },
): SwarmBoardAccessState {
  const result = useAtomValue(
    options?.retry
      ? retryingSwarmBoardAccessAtom(environmentId)
      : swarmBoardAccessAtom(environmentId),
  );
  return {
    access: AsyncResult.isSuccess(result) ? result.value : null,
    isFailure: AsyncResult.isFailure(result),
    isWaiting: result.waiting,
  };
}

export function refreshSwarmBoardAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(swarmBoardAccessAtom(environmentId));
}
