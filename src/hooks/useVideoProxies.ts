import { useEffect, useMemo, useRef, useState } from "react";

import { cancelVideoProxy, ensureVideoProxy } from "../services/proxyMedia";

export type VideoProxyStatus = "queued" | "generating" | "ready" | "error";

export type VideoProxyState = {
  status: VideoProxyStatus;
  proxyPath?: string;
  error?: string;
};

export type VideoProxyStates = Record<string, VideoProxyState>;

function normalizeSourcePaths(sourcePaths: string[]) {
  return [...new Set(sourcePaths.filter((path) => path.trim().length > 0))];
}

export function useVideoProxies(sourcePaths: string[]) {
  const [proxyStatesBySource, setProxyStatesBySource] =
    useState<VideoProxyStates>({});
  const requestedPathsRef = useRef<Set<string>>(new Set());
  const generationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const activeGenerationPathRef = useRef<string | null>(null);
  const desiredPathsRef = useRef<Set<string>>(new Set());

  const sourceKey = useMemo(
    () => normalizeSourcePaths(sourcePaths).join("\u0000"),
    [sourcePaths],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      const activePath = activeGenerationPathRef.current;
      if (activePath) {
        void cancelVideoProxy(activePath).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const paths = sourceKey ? sourceKey.split("\u0000") : [];
    const desired = new Set(paths);
    desiredPathsRef.current = desired;

    const activePath = activeGenerationPathRef.current;
    if (activePath && !desired.has(activePath)) {
      void cancelVideoProxy(activePath).catch(() => undefined);
    }

    for (const sourcePath of [...requestedPathsRef.current]) {
      if (!desired.has(sourcePath)) {
        requestedPathsRef.current.delete(sourcePath);
      }
    }

    for (const sourcePath of paths) {
      if (requestedPathsRef.current.has(sourcePath)) {
        continue;
      }

      requestedPathsRef.current.add(sourcePath);

      setProxyStatesBySource((current) => ({
        ...current,
        [sourcePath]: { status: "queued" },
      }));

      generationQueueRef.current = generationQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!mountedRef.current || !desiredPathsRef.current.has(sourcePath)) {
            requestedPathsRef.current.delete(sourcePath);
            return;
          }

          activeGenerationPathRef.current = sourcePath;
          setProxyStatesBySource((current) => ({
            ...current,
            [sourcePath]: { status: "generating" },
          }));

          try {
            const proxyPath = await ensureVideoProxy(sourcePath);

            if (!mountedRef.current || !desiredPathsRef.current.has(sourcePath)) return;

            setProxyStatesBySource((current) => ({
              ...current,
              [sourcePath]: {
                status: "ready",
                proxyPath,
              },
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!mountedRef.current || !desiredPathsRef.current.has(sourcePath)) return;
            if (message.includes("PROXY_CANCELLED")) {
              requestedPathsRef.current.delete(sourcePath);
              setProxyStatesBySource((current) => {
                const next = { ...current };
                delete next[sourcePath];
                return next;
              });
              return;
            }

            setProxyStatesBySource((current) => ({
              ...current,
              [sourcePath]: {
                status: "error",
                error: message,
              },
            }));
          } finally {
            if (activeGenerationPathRef.current === sourcePath) {
              activeGenerationPathRef.current = null;
            }
          }
        });
    }
  }, [sourceKey]);

  const proxyPathsBySource = useMemo(() => {
    const result: Record<string, string> = {};

    for (const [sourcePath, state] of Object.entries(proxyStatesBySource)) {
      if (state.status === "ready" && state.proxyPath) {
        result[sourcePath] = state.proxyPath;
      }
    }

    return result;
  }, [proxyStatesBySource]);

  return {
    proxyStatesBySource,
    proxyPathsBySource,
  };
}
