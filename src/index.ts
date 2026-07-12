#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { BLOCKSCOUT, NATIVE, USDG, USDG_DECIMALS, account, erc20Abi, publicClient, wallet } from "./chain.js";
import { config } from "./config.js";
import { findPairPools, profileToken, searchTokens, type PoolInfo, type Tier } from "./discovery.js";
import { checkTradeAllowed, recordTrade, spentUsdLast24h, tradeHistory } from "./guardrails.js";
import { bestQuote, ethUsdPrice, isNative, swapV4, usdValue } from "./v4.js";

// ── Human-run CLI subcommands (not part of the MCP surface) ──────────────────
const command = process.argv[2];
if (command === "address") {
  console.log(wallet.address);
  process.exit(0);
}
if (command === "export-key") {
  console.error("WARNING: anyone with this key controls the pocket's funds.");
  console.error("Store it somewhere safe and never paste it into a chat with an AI agent.\n");
  console.log(wallet.privateKey);
  process.exit(0);
}
if (command !== undefined) {
  console.error(`Unknown command "${command}". Usage: hoodpocket [address|export-key]`);
  process.exit(1);
}

// stderr is safe for MCP stdio servers; stdout is reserved for the protocol.
if (wallet.source === "generated") {
  console.error(`hoodpocket: generated a new pocket wallet: ${wallet.address}`);
  console.error(`hoodpocket: key stored at ${wallet.path} (owner-only permissions)`);
  console.error(`hoodpocket: fund it with ETH (gas + trading) to start. Back up the key with: npx hoodpocket export-key`);
} else {
  console.error(`hoodpocket: wallet ${wallet.address} (key from ${wallet.source})`);
}

const server = new McpServer({ name: "hoodpocket", version: "0.4.0" });

function resolveCurrency(input: string): Address {
  const upper = input.trim().toUpperCase();
  if (upper === "ETH") return NATIVE;
  if (upper === "USDG") return USDG;
  return getAddress(input.trim());
}

function isQuoteCurrency(address: Address): boolean {
  return isNative(address) || address.toLowerCase() === USDG.toLowerCase();
}

async function balanceOf(currency: Address): Promise<bigint> {
  if (isNative(currency)) return publicClient.getBalance({ address: account.address });
  return publicClient.readContract({
    address: currency,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
}

/**
 * Resolve a trading pair. Exactly one side must be a quote currency (ETH or
 * USDG), except the ETH/USDG pair itself which is always allowed.
 */
async function resolvePair(tokenInRaw: string, tokenOutRaw: string) {
  const tokenIn = resolveCurrency(tokenInRaw);
  const tokenOut = resolveCurrency(tokenOutRaw);
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error("token_in and token_out are the same currency.");
  }

  // ETH <-> USDG: both sides are quotes, no token to profile.
  if (isQuoteCurrency(tokenIn) && isQuoteCurrency(tokenOut)) {
    const pools = await findPairPools(NATIVE, USDG);
    return {
      tokenIn,
      tokenOut,
      pools,
      tier: "official" as Tier,
      tierReasons: ["native ETH / USDG quote pair"],
      inDecimals: isNative(tokenIn) ? 18 : USDG_DECIMALS,
      outDecimals: isNative(tokenOut) ? 18 : USDG_DECIMALS,
      inSymbol: isNative(tokenIn) ? "ETH" : "USDG",
      outSymbol: isNative(tokenOut) ? "ETH" : "USDG",
      profilePools: pools,
    };
  }

  if (isQuoteCurrency(tokenIn) === isQuoteCurrency(tokenOut)) {
    throw new Error(
      "One side of the pair must be ETH or USDG (token-to-token routing is not supported yet)."
    );
  }

  const quote = isQuoteCurrency(tokenIn) ? tokenIn : tokenOut;
  const other = isQuoteCurrency(tokenIn) ? tokenOut : tokenIn;
  const p = await profileToken(other);
  const pairPools = p.pools.filter((pool) => pool.quote.toLowerCase() === quote.toLowerCase());
  if (!pairPools.some((pool) => pool.liquidity > 0n)) {
    const otherQuote = isNative(quote) ? "USDG" : "ETH";
    const alt = p.pools.filter((pool) => pool.liquidity > 0n).length;
    throw new Error(
      `${p.symbol} has no live pool against ${isNative(quote) ? "ETH" : "USDG"}.` +
        (alt > 0 ? ` Try quoting against ${otherQuote} instead.` : "")
    );
  }

  const quoteDecimals = isNative(quote) ? 18 : USDG_DECIMALS;
  const quoteSymbol = isNative(quote) ? "ETH" : "USDG";
  return {
    tokenIn,
    tokenOut,
    pools: pairPools,
    tier: p.tier,
    tierReasons: p.tierReasons,
    inDecimals: isQuoteCurrency(tokenIn) ? quoteDecimals : p.decimals,
    outDecimals: isQuoteCurrency(tokenOut) ? quoteDecimals : p.decimals,
    inSymbol: isQuoteCurrency(tokenIn) ? quoteSymbol : p.symbol,
    outSymbol: isQuoteCurrency(tokenOut) ? quoteSymbol : p.symbol,
    profilePools: p.pools,
  };
}

server.registerTool(
  "search_tokens",
  {
    description:
      "Search tokens on Robinhood Chain by name or symbol: memecoins (Noxa launches), utility tokens (Virtuals), and tokenized stocks. Returns candidates with basic stats. IMPORTANT: names and symbols are freely fakeable on-chain. Before trading, always run get_token_info on the address to see its trust tier.",
    inputSchema: {
      query: z.string().describe("Name or symbol, e.g. 'CASHCAT', 'HOODIE', 'AAPL'"),
    },
  },
  async ({ query }) => {
    const results = await searchTokens(query);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No tokens found (or the explorer API is down)." }] };
    }
    const lines = results.map(
      (t) =>
        `${t.symbol} | ${t.name} | ${t.address} | holders: ${t.holders}` +
        (t.priceUsd !== null ? ` | ~$${t.priceUsd}` : " | no price feed")
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_token_info",
  {
    description:
      "Classify a token address into a trust tier (official / established / unknown) using on-chain signals: bytecode fingerprint vs official Robinhood stock tokens, deployer identity, live Uniswap V4 liquidity against ETH and USDG, holders, and price feed. Trading policy depends on the tier.",
    inputSchema: {
      address: z.string().describe("The token contract address (0x...)"),
    },
  },
  async ({ address }) => {
    const p = await profileToken(address);
    const livePools = p.pools.filter((pool) => pool.liquidity > 0n);
    const lines = [
      `${p.symbol} · ${p.name}`,
      `address: ${p.address}`,
      `decimals: ${p.decimals}`,
      `tier: ${p.tier.toUpperCase()}`,
      `reasons: ${p.tierReasons.join("; ")}`,
      `holders: ${p.holders ?? "unknown"}`,
      `price: ${p.priceUsd !== null ? `~$${p.priceUsd}` : "no feed"}`,
      `live pools (Uniswap V4): ${livePools.length} of ${p.pools.length}`,
      ...livePools
        .slice(0, 5)
        .map(
          (pool) =>
            `  vs ${pool.quoteSymbol} | fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`
        ),
      `policy for this tier: ${JSON.stringify(config.policy.tiers[p.tier])}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "quote",
  {
    description:
      "Get the current executable price for a swap on Uniswap V4 (exact input, best pool). One side must be ETH or USDG. Use before swap to set expectations and detect thin liquidity.",
    inputSchema: {
      token_in: z.string().describe("'ETH', 'USDG', or a token address to sell"),
      token_out: z.string().describe("'ETH', 'USDG', or a token address to buy"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '0.05'"),
    },
  },
  async ({ token_in, token_out, amount_in }) => {
    const pair = await resolvePair(token_in, token_out);
    const amountIn = parseUnits(amount_in, pair.inDecimals);
    const { pool, amountOut } = await bestQuote(pair.pools, pair.tokenIn, amountIn);
    const tradeUsd = await usdValue(pair.tokenIn, amountIn, pair.inDecimals, pair.profilePools);
    return {
      content: [
        {
          type: "text",
          text: [
            `${amount_in} ${pair.inSymbol} -> ~${formatUnits(amountOut, pair.outDecimals)} ${pair.outSymbol} (~$${tradeUsd.toFixed(2)})`,
            `pool: vs ${pool.quoteSymbol} | fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "swap",
  {
    description:
      "Swap on Uniswap V4 (exact input, best pool). One side must be ETH or USDG; memecoins and utility tokens usually trade against ETH, stock tokens against USDG. Guardrails run before signing: the token's trust tier must be enabled, the trade's USD value must fit the per-trade limit for that tier, and the rolling 24h USD budget must not be exceeded. Blocked trades cost nothing.",
    inputSchema: {
      token_in: z.string().describe("'ETH', 'USDG', or a token address to sell"),
      token_out: z.string().describe("'ETH', 'USDG', or a token address to buy"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '0.05'"),
      slippage_bps: z
        .number()
        .optional()
        .describe("Max slippage vs the quoted price, in basis points (default 100 = 1%)"),
    },
  },
  async ({ token_in, token_out, amount_in, slippage_bps }) => {
    const pair = await resolvePair(token_in, token_out);
    const amountIn = parseUnits(amount_in, pair.inDecimals);

    // Balance check, with a gas cushion when spending native ETH.
    const inBalance = await balanceOf(pair.tokenIn);
    const gasCushion = isNative(pair.tokenIn) ? parseUnits("0.0005", 18) : 0n;
    if (inBalance < amountIn + gasCushion) {
      throw new Error(
        `Insufficient ${pair.inSymbol}: have ${formatUnits(inBalance, pair.inDecimals)}, ` +
          `need ${amount_in}${gasCushion > 0n ? " plus a small gas reserve" : ""}.`
      );
    }

    // Value the trade in USD, then run the guardrails, before any signing.
    const tradeUsd = await usdValue(pair.tokenIn, amountIn, pair.inDecimals, pair.profilePools);
    checkTradeAllowed(pair.tier, tradeUsd, pair.tierReasons);

    const { pool, amountOut: quoted } = await bestQuote(pair.pools, pair.tokenIn, amountIn);
    const minOut = (quoted * BigInt(10_000 - (slippage_bps ?? 100))) / 10_000n;

    const outBefore = await balanceOf(pair.tokenOut);
    const { txHash, gasCostWei } = await swapV4(pool, pair.tokenIn, pair.tokenOut, amountIn, minOut);
    const outAfter = await balanceOf(pair.tokenOut);
    // Native-ETH output is measured net of the gas this tx burned.
    const rawDelta = outAfter - outBefore;
    const received = formatUnits(
      isNative(pair.tokenOut) ? rawDelta + gasCostWei : rawDelta,
      pair.outDecimals
    );

    recordTrade({
      timestamp: Date.now(),
      tokenIn: pair.inSymbol,
      tokenOut: pair.outSymbol,
      amountIn: amount_in,
      amountOut: received,
      usdValue: tradeUsd,
      tier: pair.tier,
      txHash,
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Swap executed (~$${tradeUsd.toFixed(2)}, ${pair.tier} tier).`,
            `sold: ${amount_in} ${pair.inSymbol}`,
            `received: ${received} ${pair.outSymbol}`,
            `tx: ${BLOCKSCOUT}/tx/${txHash}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "get_portfolio",
  {
    description:
      "Current holdings of the pocket wallet: ETH, USDG, and every token previously traded. Includes the live ETH/USD price.",
    inputSchema: {},
  },
  async () => {
    const lines = [`wallet: ${account.address}`];
    const eth = await publicClient.getBalance({ address: account.address });
    try {
      const price = await ethUsdPrice();
      lines.push(`ETH: ${formatUnits(eth, 18)} (~$${(Number(formatUnits(eth, 18)) * price).toFixed(2)} @ $${price.toFixed(0)}/ETH)`);
    } catch {
      lines.push(`ETH: ${formatUnits(eth, 18)}`);
    }
    if (eth === 0n) {
      lines.push(
        `This wallet is unfunded. Ask the user to send ETH (for gas and trading) to ${account.address} on Robinhood Chain (id 4663).`
      );
    }
    const usdg = await publicClient.readContract({
      address: USDG,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    lines.push(`USDG: ${formatUnits(usdg, USDG_DECIMALS)}`);

    const seen = new Set<string>();
    for (const t of tradeHistory(200)) {
      for (const s of [t.tokenIn, t.tokenOut]) {
        if (s !== "USDG" && s !== "ETH" && !seen.has(s)) seen.add(s);
      }
    }
    if (seen.size > 0) {
      lines.push(`previously traded: ${[...seen].join(", ")} (use get_token_info + quote for current value)`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_limits",
  {
    description:
      "The wallet's trading policy: per-tier rules, the rolling 24h USD budget, and how much of it is already used.",
    inputSchema: {},
  },
  async () => {
    const spent = spentUsdLast24h();
    const lines = [
      `daily budget: $${config.policy.dailyBudgetUsd} (used ~$${spent.toFixed(2)}, remaining ~$${Math.max(0, config.policy.dailyBudgetUsd - spent).toFixed(2)})`,
      `tiers:`,
      `  official (Robinhood stock tokens): ${config.policy.tiers.official.enabled ? `enabled, max $${config.policy.tiers.official.maxPerTradeUsd}/trade` : "disabled"}`,
      `  established (${config.policy.minHolders}+ holders, price feed, live pool): ${config.policy.tiers.established.enabled ? `enabled, max $${config.policy.tiers.established.maxPerTradeUsd}/trade` : "disabled"}`,
      `  unknown (everything else): ${config.policy.tiers.unknown.enabled ? `enabled, max $${config.policy.tiers.unknown.maxPerTradeUsd}/trade` : "disabled"}`,
      `denylist: ${config.policy.denylist.length} address(es)`,
      ``,
      `There is no withdrawal tool: funds can only rotate between currencies inside this wallet.`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "get_trade_history",
  {
    description: "Recent trades made from this wallet, newest first, with explorer links.",
    inputSchema: {
      limit: z.number().optional().describe("Max number of trades to return (default 20)"),
    },
  },
  async ({ limit }) => {
    const trades = tradeHistory(limit ?? 20);
    if (trades.length === 0) return { content: [{ type: "text", text: "No trades yet." }] };
    const lines = trades.map(
      (t) =>
        `${new Date(t.timestamp).toISOString()}  ${t.amountIn} ${t.tokenIn} -> ${t.amountOut} ${t.tokenOut}  (~$${t.usdValue.toFixed(2)}, ${t.tier})  ${BLOCKSCOUT}/tx/${t.txHash}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
