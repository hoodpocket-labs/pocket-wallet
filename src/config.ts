import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOODPOCKET_HOME } from "./keystore.js";

export interface TierPolicy {
  enabled: boolean;
  /** Max USD value of a single trade in this tier. */
  maxPerTradeUsd: number;
}

export interface Policy {
  /** Total USD turnover the agent may generate across any rolling 24h. */
  dailyBudgetUsd: number;
  tiers: {
    /** Official Robinhood stock tokens (verified by on-chain codehash). */
    official: TierPolicy;
    /** Tokens with real liquidity, 1000+ holders, and an indexed price feed. */
    established: TierPolicy;
    /** Everything else. Off by default; this is where the scams live. */
    unknown: TierPolicy;
  };
  /** Established-tier threshold: minimum holder count. */
  minHolders: number;
  /** Token addresses the agent may never trade, regardless of tier. */
  denylist: string[];
}

export interface PocketConfig {
  rpcUrl?: string;
  policy: Policy;
  /** Where trade history / spend tracking is stored. Default: ~/.hoodpocket/state.json */
  stateFile?: string;
}

const DEFAULT_POLICY: Policy = {
  dailyBudgetUsd: 1000,
  tiers: {
    official: { enabled: true, maxPerTradeUsd: 500 },
    established: { enabled: true, maxPerTradeUsd: 100 },
    unknown: { enabled: false, maxPerTradeUsd: 0 },
  },
  minHolders: 1000,
  denylist: [],
};

/** Config search order: explicit env path, then cwd, then ~/.hoodpocket/config.json. */
function findConfigPath(): string | null {
  if (process.env.HOODPOCKET_CONFIG) return resolve(process.env.HOODPOCKET_CONFIG);
  const cwdPath = resolve("hoodpocket.config.json");
  if (existsSync(cwdPath)) return cwdPath;
  const homePath = join(HOODPOCKET_HOME, "config.json");
  if (existsSync(homePath)) return homePath;
  return null;
}

function loadConfig(): PocketConfig {
  const path = findConfigPath();
  if (!path) return { policy: DEFAULT_POLICY };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PocketConfig>;
  return {
    ...raw,
    policy: {
      ...DEFAULT_POLICY,
      ...raw.policy,
      tiers: { ...DEFAULT_POLICY.tiers, ...raw.policy?.tiers },
      denylist: (raw.policy?.denylist ?? []).map((a) => a.toLowerCase()),
    },
  };
}

export const config = loadConfig();
