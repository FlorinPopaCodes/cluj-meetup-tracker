import { parse as parseYaml } from "@std/yaml";
import {
  EntrySchema,
  fetchAllDiscover,
  fetchCalendarBySlug,
  fetchCalendarEvents,
} from "./lib/luma.ts";
import { isClujEvent, CLUJ } from "./lib/filter.ts";
import {
  appendScrapeErrors,
  COLUMNS,
  entryToRow,
  type EventRow,
  readEventsCsv,
  type ScrapeError,
  upsert,
  writeEventsCsv,
} from "./lib/csv.ts";
import { loadFingerprint, saveFingerprint, updateFingerprint } from "./lib/schema.ts";
import { sanitizeSnapshot } from "./lib/sanitize.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PATHS = {
  events: `${REPO_ROOT}data/events.csv`,
  errors: `${REPO_ROOT}data/scrape_errors.csv`,
  schema: `${REPO_ROOT}data/schema.json`,
  snapshots: `${REPO_ROOT}data/snapshots`,
  config: `${REPO_ROOT}config/calendars.yaml`,
};

const SANITY_THRESHOLD = 0.5;

function todayUtcKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

interface FetchResult {
  source: string;
  raw: unknown[];
  error: ScrapeError | null;
}

async function fetchGeo(today: string): Promise<FetchResult> {
  try {
    const raw = await fetchAllDiscover(CLUJ.lat, CLUJ.lng);
    return { source: "geo", raw, error: null };
  } catch (e) {
    return {
      source: "geo",
      raw: [],
      error: { date: today, source: "geo", error_kind: "fetch_failed", message: String(e) },
    };
  }
}

async function fetchCalendar(slug: string, today: string): Promise<FetchResult> {
  const source = `calendar:${slug}`;
  try {
    const meta = await fetchCalendarBySlug(slug);
    const raw = await fetchCalendarEvents(meta.calendar_api_id);
    for (const r of raw) {
      const obj = r as Record<string, unknown>;
      const cal = (obj.calendar as Record<string, unknown> | undefined) ?? {};
      obj.calendar = { ...cal, slug: meta.calendar_slug, name: meta.calendar_name, api_id: meta.calendar_api_id };
    }
    return { source, raw, error: null };
  } catch (e) {
    return {
      source,
      raw: [],
      error: { date: today, source, error_kind: "fetch_failed", message: String(e) },
    };
  }
}

interface SeedConfig {
  seed_calendars: string[];
}

function loadSeedCalendars(): string[] {
  try {
    const text = Deno.readTextFileSync(PATHS.config);
    const cfg = parseYaml(text) as SeedConfig;
    return cfg.seed_calendars ?? [];
  } catch {
    return [];
  }
}

function ensureSnapshotDir() {
  try {
    Deno.mkdirSync(PATHS.snapshots, { recursive: true });
  } catch { /* ignore */ }
}

function writeSnapshot(today: string, payload: unknown) {
  ensureSnapshotDir();
  Deno.writeTextFileSync(`${PATHS.snapshots}/${today}.json`, JSON.stringify(payload, null, 2) + "\n");
}

function countUpcoming(rows: EventRow[]): number {
  const nowIso = new Date().toISOString();
  let n = 0;
  for (const r of rows) if (r.start_at && r.start_at >= nowIso) n++;
  return n;
}

async function main() {
  const today = todayUtcKey();
  console.log(`[scrape] ${today}`);

  const slugs = loadSeedCalendars();
  console.log(`[scrape] seed calendars: ${slugs.join(", ") || "(none)"}`);

  const [geoRes, ...calRes] = await Promise.all([
    fetchGeo(today),
    ...slugs.map((s) => fetchCalendar(s, today)),
  ]);
  const sources: FetchResult[] = [geoRes, ...calRes];

  const errors: ScrapeError[] = sources.map((s) => s.error).filter((e): e is ScrapeError => e !== null);
  const successCount = sources.filter((s) => s.error === null).length;
  if (successCount === 0) {
    console.error("[scrape] ALL sources failed; aborting (no data to write)");
    appendScrapeErrors(PATHS.errors, errors);
    Deno.exit(2);
  }

  const rawPayload: Record<string, unknown[]> = {};
  for (const s of sources) rawPayload[s.source] = s.raw;
  writeSnapshot(today, sanitizeSnapshot(rawPayload));

  const validEntries: { entry: ReturnType<typeof EntrySchema.parse>; source: string }[] = [];
  let parseFailures = 0;
  for (const s of sources) {
    for (const raw of s.raw) {
      const r = EntrySchema.safeParse(raw);
      if (r.success) {
        validEntries.push({ entry: r.data, source: s.source });
      } else {
        parseFailures++;
        const id = (raw as Record<string, unknown>)?.api_id ?? "?";
        console.warn(`[scrape] zod parse failed for entry ${id}: ${r.error.errors[0]?.message ?? "unknown"}`);
      }
    }
  }
  console.log(`[scrape] valid entries: ${validEntries.length}, parse failures: ${parseFailures}`);

  const fp = loadFingerprint(PATHS.schema);
  const fpUpdated = updateFingerprint(
    fp,
    sources.flatMap((s) => s.raw as Record<string, unknown>[]),
    today,
  );
  saveFingerprint(PATHS.schema, fpUpdated);

  const freshById = new Map<string, EventRow>();
  let droppedNonCluj = 0;
  for (const v of validEntries) {
    if (!isClujEvent(v.entry)) {
      droppedNonCluj++;
      continue;
    }
    const row = entryToRow(v.entry, v.source, today);
    const prev = freshById.get(row.event_id);
    if (prev) {
      const merged = { ...prev };
      const set = new Set(prev.sources.split("|").filter(Boolean));
      set.add(v.source);
      merged.sources = [...set].sort().join("|");
      for (const key of Object.keys(row) as (keyof EventRow)[]) {
        if (key === "sources") continue;
        if (!merged[key] && row[key]) (merged as Record<string, string>)[key] = row[key];
      }
      freshById.set(row.event_id, merged);
    } else {
      freshById.set(row.event_id, row);
    }
  }
  const fresh = [...freshById.values()];
  console.log(`[scrape] fresh Cluj events: ${fresh.length} (dropped non-Cluj: ${droppedNonCluj})`);

  const existing = readEventsCsv(PATHS.events);
  const baseline = countUpcoming(existing);
  if (baseline > 0 && fresh.length < baseline * SANITY_THRESHOLD) {
    const msg = `sanity threshold tripped: fresh=${fresh.length} < ${SANITY_THRESHOLD} * baseline=${baseline}`;
    console.error(`[scrape] ${msg}`);
    appendScrapeErrors(PATHS.errors, [
      ...errors,
      { date: today, source: "all", error_kind: "sanity_threshold", message: msg },
    ]);
    Deno.exit(3);
  }

  const merged = upsert(existing, fresh.map((r) => ({ ...r, first_seen: r.first_seen || today })));
  const existingById = new Map(existing.map((r) => [r.event_id, r]));
  for (const r of merged) {
    const prior = existingById.get(r.event_id);
    if (prior) r.first_seen = prior.first_seen;
  }
  writeEventsCsv(PATHS.events, merged);
  console.log(`[scrape] events.csv: ${merged.length} total rows`);

  if (errors.length) appendScrapeErrors(PATHS.errors, errors);
  console.log(`[scrape] done. errors: ${errors.length}`);
  void COLUMNS;
}

if (import.meta.main) {
  await main();
}
