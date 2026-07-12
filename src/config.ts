import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";

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
  /** Minimum USDG-side pool liquidity (in USDG) for a pool to count as real. */
  minPoolUsdg: number;
  /** Token addresses the agent may never trade, regardless of tier. */
  denylist: string[];
}

export interface PocketConfig {
  rpcUrl?: string;
  policy: Policy;
  /** Where trade history / spend tracking is stored. Default: .hoodpocket/state.json */
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
  minPoolUsdg: 10_000,
  denylist: [],
};

function loadConfig(): PocketConfig {
  const path = resolve(process.env.HOODPOCKET_CONFIG ?? "hoodpocket.config.json");
  if (!existsSync(path)) return { policy: DEFAULT_POLICY };
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

const pk = process.env.HOODPOCKET_PRIVATE_KEY;
if (!pk) {
  throw new Error(
    "HOODPOCKET_PRIVATE_KEY is not set. Generate a fresh key for the pocket wallet. Never reuse your main wallet's key."
  );
}

export const config = { ...loadConfig(), privateKey: pk as Hex };
