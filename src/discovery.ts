import { keccak256, parseAbi, parseAbiItem, getAddress } from "viem";
import type { Address, Hex } from "viem";
import {
  BLOCKSCOUT,
  NATIVE,
  OFFICIAL_ISSUER,
  OFFICIAL_STOCK_CODEHASH,
  POOL_MANAGER,
  QUOTES,
  STATE_VIEW,
  erc20Abi,
  publicClient,
} from "./chain.js";
import { config } from "./config.js";

export type Tier = "official" | "established" | "unknown";

export interface PoolInfo {
  poolId: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  liquidity: bigint;
  /** The quote side of this pool (NATIVE for ETH pairs, USDG for stable pairs). */
  quote: Address;
  quoteSymbol: string;
}

export interface TokenProfile {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  tier: Tier;
  tierReasons: string[];
  holders: number | null;
  priceUsd: number | null;
  pools: PoolInfo[];
}

const stateViewAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);

// ─── Blockscout (indexer — treated as best-effort, never trusted alone) ───────

interface BlockscoutToken {
  address_hash: string;
  symbol: string | null;
  name: string | null;
  decimals: string | null;
  holders_count: string | null;
  exchange_rate: string | null;
  circulating_market_cap: string | null;
}

async function blockscout<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BLOCKSCOUT}/api/v2${path}`, {
      headers: { accept: "application/json" },
    });
    const body = await res.json();
    // This instance sometimes returns a bare "Internal server error" string with HTTP 200.
    if (typeof body === "string" || body === null) return null;
    return body as T;
  } catch {
    return null;
  }
}

export async function searchTokens(query: string): Promise<
  Array<{ address: string; symbol: string; name: string; holders: number; priceUsd: number | null }>
> {
  const data = await blockscout<{ items: BlockscoutToken[] }>(
    `/tokens?q=${encodeURIComponent(query)}`
  );
  if (!data?.items) return [];
  return data.items.slice(0, 15).map((t) => ({
    address: t.address_hash,
    symbol: t.symbol ?? "?",
    name: t.name ?? "?",
    holders: Number(t.holders_count ?? 0),
    priceUsd: t.exchange_rate ? Number(t.exchange_rate) : null,
  }));
}

// ─── V4 pool discovery (pure on-chain: Initialize events + StateView) ─────────

const poolCache = new Map<string, { at: number; pools: PoolInfo[] }>();
const POOL_TTL_MS = 10 * 60 * 1000;

function sortPair(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** All V4 pools between two specific currencies, deepest first. */
export async function findPairPools(tokenA: Address, quote: Address): Promise<PoolInfo[]> {
  const [currency0, currency1] = sortPair(tokenA, quote);
  const key = `${currency0}:${currency1}`.toLowerCase();
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.pools;

  const logs = await publicClient.getLogs({
    address: POOL_MANAGER,
    event: initializeEvent,
    args: { currency0, currency1 },
    fromBlock: 0n,
  });

  const quoteMeta = QUOTES.find((q) => q.address.toLowerCase() === quote.toLowerCase());
  const pools: PoolInfo[] = [];
  for (const log of logs) {
    const { id, fee, tickSpacing, hooks } = log.args;
    if (id === undefined || fee === undefined || tickSpacing === undefined || !hooks) continue;
    const liquidity = await publicClient.readContract({
      address: STATE_VIEW,
      abi: stateViewAbi,
      functionName: "getLiquidity",
      args: [id],
    });
    pools.push({
      poolId: id,
      currency0,
      currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks,
      liquidity,
      quote,
      quoteSymbol: quoteMeta?.symbol ?? quote,
    });
  }

  pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  poolCache.set(key, { at: Date.now(), pools });
  return pools;
}

/** Pools for a token against every supported quote currency (ETH first, then USDG). */
export async function findQuotePools(token: Address): Promise<PoolInfo[]> {
  const perQuote = await Promise.all(
    QUOTES.filter((q) => q.address.toLowerCase() !== token.toLowerCase()).map((q) =>
      findPairPools(token, q.address)
    )
  );
  return perQuote.flat();
}

// ─── Tier classification ──────────────────────────────────────────────────────

const profileCache = new Map<string, { at: number; profile: TokenProfile }>();
const PROFILE_TTL_MS = 10 * 60 * 1000;

/**
 * Classify a token using signals that cost money to fake:
 *  - official:    runtime bytecode hash matches the official Robinhood stock-token
 *                 fingerprint (plus a creator cross-check when the indexer responds,
 *                 and at least one live quote pool)
 *  - established: 1000+ holders, an indexed price feed, and live ETH or USDG liquidity
 *  - unknown:     everything else (blocked by default policy)
 */
export async function profileToken(rawAddress: string): Promise<TokenProfile> {
  const address = getAddress(rawAddress);
  if (address === NATIVE) {
    throw new Error("Native ETH is a quote currency, not a token to profile.");
  }
  const key = address.toLowerCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;

  // On-chain identity — never trust the indexer for these.
  const [symbol, name, decimals, code] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    publicClient.getCode({ address }),
  ]);
  if (!code || code === "0x") throw new Error(`${address} has no contract code`);
  const codehash = keccak256(code);

  const pools = await findQuotePools(address);
  const hasLivePool = pools.some((p) => p.liquidity > 0n);

  const info = await blockscout<BlockscoutToken>(`/tokens/${address}`);
  const holders = info?.holders_count ? Number(info.holders_count) : null;
  const priceUsd = info?.exchange_rate ? Number(info.exchange_rate) : null;

  const reasons: string[] = [];
  let tier: Tier = "unknown";

  if (codehash === OFFICIAL_STOCK_CODEHASH && hasLivePool) {
    tier = "official";
    reasons.push("bytecode matches official Robinhood stock-token fingerprint");
    reasons.push("live quote pool on Uniswap V4");
    // Secondary check: creator address, when the explorer cooperates.
    const meta = await blockscout<{ creator_address_hash?: string }>(`/addresses/${address}`);
    if (meta?.creator_address_hash) {
      if (getAddress(meta.creator_address_hash) !== OFFICIAL_ISSUER) {
        tier = "unknown";
        reasons.push(
          `SPOOF SUSPECTED: deployed by ${meta.creator_address_hash}, not the official issuer`
        );
      } else {
        reasons.push("deployed by the official Robinhood issuer");
      }
    }
  } else if (
    hasLivePool &&
    holders !== null &&
    holders >= config.policy.minHolders &&
    priceUsd !== null
  ) {
    tier = "established";
    reasons.push(`${holders} holders (>= ${config.policy.minHolders})`);
    reasons.push("indexed price feed");
    reasons.push("live ETH or USDG pool on Uniswap V4");
  } else {
    if (!hasLivePool) reasons.push("no live ETH or USDG pool on Uniswap V4");
    if (holders !== null && holders < config.policy.minHolders) {
      reasons.push(`only ${holders} holders`);
    }
    if (priceUsd === null) reasons.push("no indexed price feed");
  }

  if (config.policy.denylist.includes(key)) {
    tier = "unknown";
    reasons.push("on the owner's denylist");
  }

  const profile: TokenProfile = {
    address,
    symbol,
    name,
    decimals,
    tier,
    tierReasons: reasons,
    holders,
    priceUsd,
    pools,
  };
  profileCache.set(key, { at: Date.now(), profile });
  return profile;
}
