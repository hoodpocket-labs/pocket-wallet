#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, getAddress, parseUnits } from "viem";
import { BLOCKSCOUT, USDG, USDG_DECIMALS, account, erc20Abi, publicClient } from "./chain.js";
import { config } from "./config.js";
import { profileToken, searchTokens } from "./discovery.js";
import { checkTradeAllowed, recordTrade, spentUsdLast24h, tradeHistory } from "./guardrails.js";
import { bestQuote, swapV4, usdValue } from "./v4.js";

const server = new McpServer({ name: "hoodpocket", version: "0.2.0" });

function isUsdg(address: string): boolean {
  return address.toLowerCase() === USDG.toLowerCase();
}

server.registerTool(
  "search_tokens",
  {
    description:
      "Search tokens on Robinhood Chain by name or symbol (stock tokens, memecoins, utility tokens). Returns candidates with basic stats. IMPORTANT: names and symbols are freely fakeable on-chain — before trading, always run get_token_info on the address to see its trust tier.",
    inputSchema: {
      query: z.string().describe("Name or symbol, e.g. 'AAPL', 'Apple', 'HOODIE'"),
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
      "Classify a token address into a trust tier (official / established / unknown) using on-chain signals: bytecode fingerprint vs official Robinhood stock tokens, deployer identity, live Uniswap V4 USDG liquidity, holders, and price feed. Trading policy depends on the tier.",
    inputSchema: {
      address: z.string().describe("The token contract address (0x...)"),
    },
  },
  async ({ address }) => {
    const p = await profileToken(address);
    const livePools = p.pools.filter((pool) => pool.liquidity > 0n);
    const lines = [
      `${p.symbol} — ${p.name}`,
      `address: ${p.address}`,
      `decimals: ${p.decimals}`,
      `tier: ${p.tier.toUpperCase()}`,
      `reasons: ${p.tierReasons.join("; ")}`,
      `holders: ${p.holders ?? "unknown"}`,
      `price: ${p.priceUsd !== null ? `~$${p.priceUsd}` : "no feed"}`,
      `USDG pools (Uniswap V4): ${livePools.length} live / ${p.pools.length} total`,
      ...livePools
        .slice(0, 3)
        .map((pool) => `  fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`),
      `policy for this tier: ${JSON.stringify(config.policy.tiers[p.tier])}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "quote",
  {
    description:
      "Get the current executable price for swapping a token to/from USDG on Uniswap V4 (exact input, best pool). Use before swap to set expectations and detect thin liquidity.",
    inputSchema: {
      token_in: z.string().describe("Address of the token to sell, or 'USDG'"),
      token_out: z.string().describe("Address of the token to buy, or 'USDG'"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '100'"),
    },
  },
  async ({ token_in, token_out, amount_in }) => {
    const inAddr = token_in.toUpperCase() === "USDG" ? USDG : getAddress(token_in);
    const outAddr = token_out.toUpperCase() === "USDG" ? USDG : getAddress(token_out);
    if (isUsdg(inAddr) === isUsdg(outAddr)) {
      throw new Error("One side of the pair must be USDG (v0.2 routes all trades through USDG).");
    }
    const other = isUsdg(inAddr) ? outAddr : inAddr;
    const p = await profileToken(other);
    const inDecimals = isUsdg(inAddr) ? USDG_DECIMALS : p.decimals;
    const outDecimals = isUsdg(outAddr) ? USDG_DECIMALS : p.decimals;
    const amountIn = parseUnits(amount_in, inDecimals);
    const { pool, amountOut } = await bestQuote(p.pools, inAddr, amountIn);
    return {
      content: [
        {
          type: "text",
          text: [
            `${amount_in} ${isUsdg(inAddr) ? "USDG" : p.symbol} -> ~${formatUnits(amountOut, outDecimals)} ${isUsdg(outAddr) ? "USDG" : p.symbol}`,
            `pool: fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`,
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
      "Swap between USDG and another token on Uniswap V4 (exact input). Guardrails run before signing: the token's trust tier must be enabled, the trade's USD value must fit the per-trade limit for that tier, and the rolling 24h USD budget must not be exceeded. Blocked trades cost nothing.",
    inputSchema: {
      token_in: z.string().describe("Address of the token to sell, or 'USDG'"),
      token_out: z.string().describe("Address of the token to buy, or 'USDG'"),
      amount_in: z.string().describe("Human-readable amount to sell, e.g. '100'"),
      slippage_bps: z
        .number()
        .optional()
        .describe("Max slippage vs the quoted price, in basis points (default 100 = 1%)"),
    },
  },
  async ({ token_in, token_out, amount_in, slippage_bps }) => {
    const inAddr = token_in.toUpperCase() === "USDG" ? USDG : getAddress(token_in);
    const outAddr = token_out.toUpperCase() === "USDG" ? USDG : getAddress(token_out);
    if (isUsdg(inAddr) === isUsdg(outAddr)) {
      throw new Error("One side of the pair must be USDG (v0.2 routes all trades through USDG).");
    }
    const other = isUsdg(inAddr) ? outAddr : inAddr;
    const p = await profileToken(other);
    const inDecimals = isUsdg(inAddr) ? USDG_DECIMALS : p.decimals;
    const outDecimals = isUsdg(outAddr) ? USDG_DECIMALS : p.decimals;
    const amountIn = parseUnits(amount_in, inDecimals);

    // Value the trade in USD, then run the guardrails — before any signing.
    const tradeUsd = await usdValue(inAddr, amountIn, inDecimals, p.pools);
    checkTradeAllowed(p.tier, tradeUsd, p.tierReasons);

    const { pool, amountOut: quoted } = await bestQuote(p.pools, inAddr, amountIn);
    const minOut = (quoted * BigInt(10_000 - (slippage_bps ?? 100))) / 10_000n;

    const outBefore = await publicClient.readContract({
      address: outAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const txHash = await swapV4(pool, inAddr, outAddr, amountIn, minOut);
    const outAfter = await publicClient.readContract({
      address: outAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const received = formatUnits(outAfter - outBefore, outDecimals);

    const inSymbol = isUsdg(inAddr) ? "USDG" : p.symbol;
    const outSymbol = isUsdg(outAddr) ? "USDG" : p.symbol;
    recordTrade({
      timestamp: Date.now(),
      tokenIn: inSymbol,
      tokenOut: outSymbol,
      amountIn: amount_in,
      amountOut: received,
      usdValue: tradeUsd,
      tier: p.tier,
      txHash,
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Swap executed (~$${tradeUsd.toFixed(2)}, ${p.tier} tier).`,
            `sold: ${amount_in} ${inSymbol}`,
            `received: ${received} ${outSymbol}`,
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
      "Current holdings of the pocket wallet: ETH (gas), USDG, and every token previously traded.",
    inputSchema: {},
  },
  async () => {
    const lines = [`wallet: ${account.address}`];
    const eth = await publicClient.getBalance({ address: account.address });
    lines.push(`ETH (gas): ${formatUnits(eth, 18)}`);
    const usdg = await publicClient.readContract({
      address: USDG,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    lines.push(`USDG: ${formatUnits(usdg, USDG_DECIMALS)}`);

    // Positions discovered from trade history (symbol -> last known address isn't
    // stored, so track distinct non-USDG symbols via history records' tx pages).
    const seen = new Set<string>();
    for (const t of tradeHistory(200)) {
      for (const s of [t.tokenIn, t.tokenOut]) {
        if (s !== "USDG" && !seen.has(s)) seen.add(s);
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
      `There is no withdrawal tool: funds can only rotate between tokens inside this wallet.`,
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
