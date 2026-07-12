import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.js";
import { HOODPOCKET_HOME } from "./keystore.js";
import type { Tier } from "./discovery.js";

export interface TradeRecord {
  timestamp: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  usdValue: number;
  tier: Tier;
  txHash: string;
}

interface State {
  trades: TradeRecord[];
}

const statePath = config.stateFile
  ? resolve(config.stateFile)
  : join(HOODPOCKET_HOME, "state.json");

function loadState(): State {
  if (!existsSync(statePath)) return { trades: [] };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function recordTrade(trade: TradeRecord): void {
  const state = loadState();
  state.trades.push(trade);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function tradeHistory(limit = 20): TradeRecord[] {
  return loadState().trades.slice(-limit).reverse();
}

/** USD turnover in the rolling 24h window. */
export function spentUsdLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return loadState()
    .trades.filter((t) => t.timestamp >= cutoff)
    .reduce((sum, t) => sum + t.usdValue, 0);
}

/**
 * The guardrail check, run before anything is signed.
 * Throws a descriptive error the agent can read and adapt to.
 */
export function checkTradeAllowed(tier: Tier, tradeUsd: number, tierReasons: string[]): void {
  const tierPolicy = config.policy.tiers[tier];

  if (!tierPolicy.enabled) {
    throw new Error(
      `Trade blocked: "${tier}"-tier tokens are disabled by policy. Classification: ${tierReasons.join("; ")}`
    );
  }
  if (tradeUsd > tierPolicy.maxPerTradeUsd) {
    throw new Error(
      `Trade blocked: ~$${tradeUsd.toFixed(2)} exceeds the $${tierPolicy.maxPerTradeUsd} per-trade limit for ${tier}-tier tokens.`
    );
  }
  const spent = spentUsdLast24h();
  const remaining = config.policy.dailyBudgetUsd - spent;
  if (tradeUsd > remaining) {
    throw new Error(
      `Trade blocked: daily budget is $${config.policy.dailyBudgetUsd}, ~$${spent.toFixed(2)} already used in the last 24h, only ~$${Math.max(0, remaining).toFixed(2)} remaining.`
    );
  }
}
