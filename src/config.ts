import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOODPOCKET_HOME } from "./keystore.js";

export interface TierPolicy {
  enabled: boolean;
  /** Max USD value of a single trade in this tier. */
  maxPerTradeUsd: number;
}

export interface CommercePolicy {
  enabled: boolean;
  /** Max USD price of a single x402 paid request. */
  maxPerRequestUsd: number;
  /** Total USD the agent may spend on x402 requests across any rolling 24h. */
  dailyBudgetUsd: number;
  /** Hosts the agent may pay. Probing (discovery) is never restricted. */
  allowedHosts: string[];
}

export interface AcpPolicy {
  /** Off by default: hiring other agents moves funds, so it is opt-in. */
  enabled: boolean;
  /** Max USD to fund a single Virtuals ACP job. */
  maxPerJobUsd: number;
  /** Total USD the agent may spend hiring agents across any rolling 24h. */
  dailyBudgetUsd: number;
}

export interface TransfersPolicy {
  /**
   * Off by default: outbound transfers are the riskiest tool (a prompt-
   * injected agent could drain the wallet), so withdrawals are opt-in.
   */
  enabled: boolean;
  /** Max USD value of a single outbound transfer. */
  maxPerTransferUsd: number;
  /** Total USD the agent may send externally across any rolling 24h. */
  dailyBudgetUsd: number;
  /**
   * Recipient addresses the agent may send to. Empty means any address;
   * populate it to restrict withdrawals to known-good destinations.
   */
  allowlist: string[];
}

export interface TrustedIssuer {
  /** Display name, e.g. "Backed Finance". Shown in tier reasons. */
  name: string;
  /** Deployer address of the issuer's token contracts (cross-checked via the explorer). */
  deployer?: string;
  /** keccak256 of the runtime bytecode shared by the issuer's tokens. */
  codehash?: string;
}

export interface StocksPolicy {
  /**
   * Stock tokens trade 24/7 but the underlying market does not; off-hours pool
   * prices can drift from the last NYSE close. Set true to block official
   * stock-token trades while the US market is closed (default: warn only).
   */
  blockOffHoursTrades: boolean;
}

export interface Policy {
  /** Total USD turnover the agent may generate across any rolling 24h. */
  dailyBudgetUsd: number;
  tiers: {
    /** Official Robinhood stock tokens (verified by on-chain codehash). */
    official: TierPolicy;
    /** RWA tokens matching an entry in trustedIssuers (empty by default). */
    issuer: TierPolicy;
    /** Tokens with real liquidity, 1000+ holders, and an indexed price feed. */
    established: TierPolicy;
    /** Everything else. Off by default; this is where the scams live. */
    unknown: TierPolicy;
  };
  /** Established-tier threshold: minimum holder count. */
  minHolders: number;
  /** Token addresses the agent may never trade, regardless of tier. */
  denylist: string[];
  /**
   * Non-Robinhood RWA issuers the owner trusts. Tokens matching an entry's
   * codehash and/or deployer (all provided criteria must pass, plus a live
   * quote pool) classify into the "issuer" tier instead of falling to
   * "established"/"unknown".
   */
  trustedIssuers: TrustedIssuer[];
  /** Off-hours behavior for official stock tokens. */
  stocks: StocksPolicy;
  /** x402 paid-request (agentic commerce) limits. */
  commerce: CommercePolicy;
  /** Virtuals ACP agent-to-agent hiring limits. */
  acp: AcpPolicy;
  /** Outbound transfer (withdrawal) limits. */
  transfers: TransfersPolicy;
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
    issuer: { enabled: true, maxPerTradeUsd: 250 },
    established: { enabled: true, maxPerTradeUsd: 100 },
    unknown: { enabled: false, maxPerTradeUsd: 0 },
  },
  minHolders: 1000,
  denylist: [],
  trustedIssuers: [],
  stocks: { blockOffHoursTrades: false },
  commerce: {
    enabled: true,
    maxPerRequestUsd: 0.25,
    dailyBudgetUsd: 5,
    allowedHosts: ["api.naven.network", "x402.hoodpocket.com"],
  },
  acp: {
    enabled: false,
    maxPerJobUsd: 5,
    dailyBudgetUsd: 25,
  },
  transfers: {
    enabled: false,
    maxPerTransferUsd: 100,
    dailyBudgetUsd: 250,
    allowlist: [],
  },
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
      trustedIssuers: (raw.policy?.trustedIssuers ?? []).map((i) => ({
        name: i.name,
        deployer: i.deployer?.toLowerCase(),
        codehash: i.codehash?.toLowerCase(),
      })),
      stocks: { ...DEFAULT_POLICY.stocks, ...raw.policy?.stocks },
      commerce: { ...DEFAULT_POLICY.commerce, ...raw.policy?.commerce },
      acp: { ...DEFAULT_POLICY.acp, ...raw.policy?.acp },
      transfers: {
        ...DEFAULT_POLICY.transfers,
        ...raw.policy?.transfers,
        allowlist: (raw.policy?.transfers?.allowlist ?? []).map((a) => a.toLowerCase()),
      },
    },
  };
}

export const config = loadConfig();
