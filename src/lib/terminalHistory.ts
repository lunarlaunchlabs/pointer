import { getItem, persistAsync } from "@/lib/persist";

const STORAGE_KEY = "terminalHistory.v1";
const MAX_ENTRIES = 400;
const MAX_CWD_SLOTS = 4;
const MAX_COMMAND_CHARS = 400;
const MAX_TOTAL_COMMAND_CHARS = 32_000;

export type TerminalHistoryCwdHit = {
  cwd: string;
  uses: number;
  lastUsed: number;
};

export type TerminalHistoryEntry = {
  command: string;
  uses: number;
  firstUsed: number;
  lastUsed: number;
  cwdHits: TerminalHistoryCwdHit[];
};

export type TerminalSuggestion = {
  command: string;
  suffix: string;
  score: number;
  uses: number;
  lastUsed: number;
};

let history: TerminalHistoryEntry[] = [];
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let dirtyDuringHydration = false;

export function hydrateTerminalHistory(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydratePromise) {
    hydratePromise = getItem<TerminalHistoryEntry[]>(STORAGE_KEY)
      .then((stored) => {
        const storedHistory = sanitizeHistory(stored);
        history = dirtyDuringHydration ? mergeHistory(storedHistory, history) : storedHistory;
        hydrated = true;
        dirtyDuringHydration = false;
      })
      .catch(() => {
        if (!dirtyDuringHydration) history = [];
        hydrated = true;
        dirtyDuringHydration = false;
      });
  }
  return hydratePromise;
}

export function recordTerminalCommand(
  command: string,
  cwd?: string | null,
  now = Date.now(),
): void {
  void hydrateTerminalHistory();
  const normalized = normalizeCommand(command);
  if (!normalized || !isStorableCommand(normalized)) return;
  if (!hydrated) dirtyDuringHydration = true;

  const existing = history.find((entry) => entry.command === normalized);
  if (existing) {
    existing.uses += 1;
    existing.lastUsed = now;
    noteCwdHit(existing, cwd, now);
  } else {
    history.push({
      command: normalized,
      uses: 1,
      firstUsed: now,
      lastUsed: now,
      cwdHits: [],
    });
    noteCwdHit(history[history.length - 1], cwd, now);
  }

  history = pruneHistory(history);
  persistAsync(STORAGE_KEY, history);
}

export function suggestTerminalCommand(
  prefix: string,
  cwd?: string | null,
  now = Date.now(),
): TerminalSuggestion | null {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix) return null;

  const lowerPrefix = normalizedPrefix.toLowerCase();
  let best: TerminalSuggestion | null = null;

  for (const entry of history) {
    if (entry.command.length <= normalizedPrefix.length) continue;
    if (!entry.command.toLowerCase().startsWith(lowerPrefix)) continue;

    const score = scoreEntry(entry, normalizedPrefix, cwd, now);
    if (!best || score > best.score || (score === best.score && entry.lastUsed > best.lastUsed)) {
      best = {
        command: entry.command,
        suffix: entry.command.slice(normalizedPrefix.length),
        score,
        uses: entry.uses,
        lastUsed: entry.lastUsed,
      };
    }
  }

  return best;
}

export function terminalHistorySnapshot(): TerminalHistoryEntry[] {
  return history.map((entry) => ({
    ...entry,
    cwdHits: entry.cwdHits.map((hit) => ({ ...hit })),
  }));
}

export function __resetTerminalHistoryForTests(entries: TerminalHistoryEntry[] = []): void {
  history = sanitizeHistory(entries);
  hydrated = true;
  hydratePromise = null;
  dirtyDuringHydration = false;
}

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return null;
  if (trimmed.length > MAX_COMMAND_CHARS) return null;
  return trimmed;
}

function normalizePrefix(prefix: string): string | null {
  const leadingTrimmed = prefix.replace(/^\s+/, "");
  if (!leadingTrimmed || leadingTrimmed.includes("\n") || leadingTrimmed.includes("\r")) {
    return null;
  }
  return leadingTrimmed;
}

function isStorableCommand(command: string): boolean {
  if (/^(clear|reset|history|exit|logout)$/.test(command)) return false;
  if (/(password|passwd|token|secret|api[-_]?key|private[-_]?key)\s*[:=]/i.test(command)) {
    return false;
  }
  if (/--(?:password|passwd|token|secret|api[-_]?key)(?:=|\s|$)/i.test(command)) return false;
  if (/^(?:export|set)\s+\w*(?:password|passwd|token|secret|api[-_]?key)/i.test(command)) {
    return false;
  }
  if (/\bsshpass\b/i.test(command)) return false;
  return true;
}

function noteCwdHit(entry: TerminalHistoryEntry, cwd: string | null | undefined, now: number): void {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return;
  const hit = entry.cwdHits.find((candidate) => candidate.cwd === normalized);
  if (hit) {
    hit.uses += 1;
    hit.lastUsed = now;
  } else {
    entry.cwdHits.push({ cwd: normalized, uses: 1, lastUsed: now });
  }
  entry.cwdHits = entry.cwdHits
    .sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed)
    .slice(0, MAX_CWD_SLOTS);
}

function normalizeCwd(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  return trimmed.length <= 220 ? trimmed : trimmed.slice(trimmed.length - 220);
}

function scoreEntry(
  entry: TerminalHistoryEntry,
  prefix: string,
  cwd: string | null | undefined,
  now: number,
): number {
  const ageDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
  const frequency = Math.log2(entry.uses + 1) * 5;
  const recency = 10 / (1 + ageDays / 7);
  const prefixCoverage = Math.min(8, (prefix.length / entry.command.length) * 10);
  const tailLength = entry.command.length - prefix.length;
  const brevity = Math.max(0, 3 - tailLength / 40);
  const caseMatch = entry.command.startsWith(prefix) ? 0.75 : 0;
  const cwdBonus = cwdScore(entry, cwd, now);
  return frequency + recency + prefixCoverage + brevity + caseMatch + cwdBonus;
}

function cwdScore(
  entry: TerminalHistoryEntry,
  cwd: string | null | undefined,
  now: number,
): number {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return 0;
  const hit = entry.cwdHits.find((candidate) => candidate.cwd === normalized);
  if (!hit) return 0;
  const ageDays = Math.max(0, now - hit.lastUsed) / 86_400_000;
  return Math.log2(hit.uses + 1) * 3 + 6 / (1 + ageDays / 14);
}

function sanitizeHistory(stored: unknown): TerminalHistoryEntry[] {
  if (!Array.isArray(stored)) return [];
  const entries: TerminalHistoryEntry[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<TerminalHistoryEntry>;
    const command = typeof item.command === "string" ? normalizeCommand(item.command) : null;
    if (!command || !isStorableCommand(command)) continue;
    const uses = clampInteger(item.uses, 1, 1_000_000);
    const firstUsed = clampInteger(item.firstUsed, 0, Date.now());
    const lastUsed = clampInteger(item.lastUsed, firstUsed, Date.now());
    const cwdHits = Array.isArray(item.cwdHits)
      ? item.cwdHits
          .map((hit) => sanitizeCwdHit(hit, lastUsed))
          .filter((hit): hit is TerminalHistoryCwdHit => Boolean(hit))
          .slice(0, MAX_CWD_SLOTS)
      : [];
    entries.push({ command, uses, firstUsed, lastUsed, cwdHits });
  }
  return pruneHistory(entries);
}

function sanitizeCwdHit(raw: unknown, fallbackTime: number): TerminalHistoryCwdHit | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<TerminalHistoryCwdHit>;
  const cwd = normalizeCwd(item.cwd);
  if (!cwd) return null;
  return {
    cwd,
    uses: clampInteger(item.uses, 1, 1_000_000),
    lastUsed: clampInteger(item.lastUsed, 0, fallbackTime),
  };
}

function clampInteger(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

function pruneHistory(entries: TerminalHistoryEntry[]): TerminalHistoryEntry[] {
  const byCommand = new Map<string, TerminalHistoryEntry>();
  for (const entry of entries) byCommand.set(entry.command, entry);

  const sorted = [...byCommand.values()].sort(
    (a, b) => b.lastUsed - a.lastUsed || b.uses - a.uses || a.command.localeCompare(b.command),
  );

  const kept: TerminalHistoryEntry[] = [];
  let totalChars = 0;
  for (const entry of sorted) {
    if (kept.length >= MAX_ENTRIES) break;
    if (totalChars + entry.command.length > MAX_TOTAL_COMMAND_CHARS) break;
    kept.push({
      ...entry,
      cwdHits: [...entry.cwdHits].sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed),
    });
    totalChars += entry.command.length;
  }
  return kept;
}

function mergeHistory(
  storedEntries: TerminalHistoryEntry[],
  memoryEntries: TerminalHistoryEntry[],
): TerminalHistoryEntry[] {
  const merged = new Map<string, TerminalHistoryEntry>();
  for (const entry of [...storedEntries, ...memoryEntries]) {
    const existing = merged.get(entry.command);
    if (!existing) {
      merged.set(entry.command, {
        ...entry,
        cwdHits: entry.cwdHits.map((hit) => ({ ...hit })),
      });
      continue;
    }
    existing.uses += entry.uses;
    existing.firstUsed = Math.min(existing.firstUsed, entry.firstUsed);
    existing.lastUsed = Math.max(existing.lastUsed, entry.lastUsed);
    for (const hit of entry.cwdHits) {
      const existingHit = existing.cwdHits.find((candidate) => candidate.cwd === hit.cwd);
      if (existingHit) {
        existingHit.uses += hit.uses;
        existingHit.lastUsed = Math.max(existingHit.lastUsed, hit.lastUsed);
      } else {
        existing.cwdHits.push({ ...hit });
      }
    }
    existing.cwdHits = existing.cwdHits
      .sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed)
      .slice(0, MAX_CWD_SLOTS);
  }
  return pruneHistory([...merged.values()]);
}
