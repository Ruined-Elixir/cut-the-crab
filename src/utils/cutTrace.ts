export function cutTraceEnabled() {
  try {
    return localStorage.getItem("ctcCutTrace") === "1";
  } catch {
    return false;
  }
}

export function traceCut(label: string, data: Record<string, unknown>) {
  if (!cutTraceEnabled()) return;
  console.log(`[cut ${performance.now().toFixed(1)}ms] ${label}`, data);
}

