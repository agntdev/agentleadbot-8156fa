export type LeadIntent = "buy" | "rent" | "sell";
export type LeadStatus = "new" | "done";

export interface Lead {
  id: string;
  name: string;
  phone: string;
  intent: LeadIntent;
  note: string;
  status: LeadStatus;
  submittedAt: string;
  statusUpdatedAt: string;
}

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};
type D1 = { prepare(query: string): D1Statement };

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, end: number): Promise<string[]>;
  llen(key: string): Promise<number>;
};

const INDEX_KEY = "real-estate:leads:index";
const leadKey = (id: string) => `real-estate:lead:${id}`;

/**
 * Persistent lead repository. Workers use their D1 binding; Node uses the
 * toolkit's Redis deployment setting. Both backends retain an explicit index
 * instead of scanning a keyspace.
 */
export class LeadRepository {
  constructor(private readonly env?: Record<string, unknown> | null) {}

  private d1(): D1 | undefined {
    const db = this.env?.DB;
    return db && typeof db === "object" && "prepare" in db ? (db as D1) : undefined;
  }

  private async redis(): Promise<RedisClient | undefined> {
    const url = typeof this.env?.REDIS_URL === "string"
      ? this.env.REDIS_URL
      : typeof process !== "undefined" ? process.env.REDIS_URL : undefined;
    if (!url) return undefined;
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    // ioredis is already the toolkit's Node persistence dependency.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const module: any = require("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Redis: any = module.default ?? module.Redis ?? module;
    return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false }) as RedisClient;
  }

  private async ensureD1(db: D1): Promise<void> {
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS real_estate_leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, intent TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT NOT NULL, status_updated_at TEXT NOT NULL)",
    ).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS real_estate_leads_submitted ON real_estate_leads(submitted_at DESC)").run();
  }

  async create(lead: Lead): Promise<boolean> {
    const db = this.d1();
    if (db) {
      await this.ensureD1(db);
      await db.prepare("INSERT INTO real_estate_leads (id, name, phone, intent, note, status, submitted_at, status_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(lead.id, lead.name, lead.phone, lead.intent, lead.note, lead.status, lead.submittedAt, lead.statusUpdatedAt).run();
      return true;
    }
    const redis = await this.redis();
    if (redis) {
      await redis.set(leadKey(lead.id), JSON.stringify(lead));
      await redis.rpush(INDEX_KEY, lead.id);
      return true;
    }
    return false;
  }

  async page(page: number, perPage: number): Promise<{ leads: Lead[]; total: number }> {
    const db = this.d1();
    const safePage = Math.max(0, Math.floor(page));
    if (db) {
      await this.ensureD1(db);
      const totalRow = await db.prepare("SELECT COUNT(*) AS count FROM real_estate_leads").first<{ count: number }>();
      const rows = await db.prepare("SELECT id, name, phone, intent, note, status, submitted_at AS submittedAt, status_updated_at AS statusUpdatedAt FROM real_estate_leads ORDER BY submitted_at DESC LIMIT ? OFFSET ?")
        .bind(perPage, safePage * perPage).all<Lead>();
      return { leads: rows.results, total: Number(totalRow?.count ?? 0) };
    }
    const redis = await this.redis();
    if (redis) {
      const total = await redis.llen(INDEX_KEY);
      const end = total - safePage * perPage - 1;
      const start = Math.max(0, end - perPage + 1);
      if (end < 0) return { leads: [], total };
      const ids = (await redis.lrange(INDEX_KEY, start, end)).reverse();
      const leads = (await Promise.all(ids.map((id) => redis.get(leadKey(id))))).flatMap((raw) => {
        if (!raw) return [];
        try { return [JSON.parse(raw) as Lead]; } catch { return []; }
      });
      return { leads, total };
    }
    return { leads: [], total: 0 };
  }

  async get(id: string): Promise<Lead | undefined> {
    const db = this.d1();
    if (db) {
      await this.ensureD1(db);
      return (await db.prepare("SELECT id, name, phone, intent, note, status, submitted_at AS submittedAt, status_updated_at AS statusUpdatedAt FROM real_estate_leads WHERE id = ?").bind(id).first<Lead>()) ?? undefined;
    }
    const redis = await this.redis();
    const raw = redis ? await redis.get(leadKey(id)) : null;
    if (!raw) return undefined;
    try { return JSON.parse(raw) as Lead; } catch { return undefined; }
  }

  async setStatus(id: string, status: LeadStatus, changedAt: string): Promise<Lead | undefined> {
    const lead = await this.get(id);
    if (!lead) return undefined;
    const updated = { ...lead, status, statusUpdatedAt: changedAt };
    const db = this.d1();
    if (db) {
      await db.prepare("UPDATE real_estate_leads SET status = ?, status_updated_at = ? WHERE id = ?").bind(status, changedAt, id).run();
      return updated;
    }
    const redis = await this.redis();
    if (!redis) return undefined;
    await redis.set(leadKey(id), JSON.stringify(updated));
    return updated;
  }
}

let clock: () => Date = () => new Date();

/** The sole clock seam for submitted and audit timestamps. */
export function now(): Date {
  return clock();
}

/** Test hook for deterministic timestamp assertions. */
export function setClockForTests(next: (() => Date) | undefined): void {
  clock = next ?? (() => new Date());
}
