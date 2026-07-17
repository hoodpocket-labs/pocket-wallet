#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { BLOCKSCOUT, NATIVE, USDG, USDG_DECIMALS, account, erc20Abi, publicClient, wallet, walletClient } from "./chain.js";
import { config } from "./config.js";
import { findPairPools, profileToken, searchTokens, type PoolInfo, type Tier } from "./discovery.js";
import {
  acpJobHistory,
  acpSpentUsdLast24h,
  checkAcpJobAllowed,
  checkPaymentAllowed,
  checkTradeAllowed,
  checkTransferAllowed,
  commerceSpentUsdLast24h,
  paymentHistory,
  recordAcpJob,
  recordPayment,
  recordTrade,
  recordTransfer,
  spentUsdLast24h,
  tradeHistory,
  transferHistory,
  transfersSpentUsdLast24h,
} from "./guardrails.js";
import { OFF_HOURS_WARNING, usMarketStatus } from "./markets.js";
import { bestQuote, ethUsdPrice, isNative, swapV4, usdValue } from "./v4.js";
import { CATALOG, payAndFetch, probeX402, type RequestSpec } from "./x402.js";
import { browseAcpAgents, hireAcpAgent } from "./acp.js";

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

const server = new McpServer({ name: "hoodpocket", version: "0.9.0" });

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
      isStock: false,
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
    isStock: p.isStock,
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
      ...(p.isStock ? [usMarketStatus().detail] : []),
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
    const lines = [
      `${amount_in} ${pair.inSymbol} -> ~${formatUnits(amountOut, pair.outDecimals)} ${pair.outSymbol} (~$${tradeUsd.toFixed(2)})`,
      `pool: vs ${pool.quoteSymbol} | fee ${pool.fee / 10000}% | liquidity ${pool.liquidity}`,
    ];
    if (pair.isStock) {
      const market = usMarketStatus();
      lines.push(market.detail);
      if (!market.open) lines.push(OFF_HOURS_WARNING);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
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

    // Market-hours guardrail for official stock tokens.
    const market = pair.isStock ? usMarketStatus() : null;
    if (market && !market.open && config.policy.stocks.blockOffHoursTrades) {
      throw new Error(
        `Trade blocked: ${market.detail}. ${OFF_HOURS_WARNING} ` +
          `The owner can allow off-hours stock trades by setting policy.stocks.blockOffHoursTrades to false.`
      );
    }

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
            ...(market && !market.open ? [`note: ${market.detail}. ${OFF_HOURS_WARNING}`] : []),
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "send",
  {
    description:
      "Send funds from the pocket wallet to another address on Robinhood Chain (withdrawal). IRREVERSIBLE: a transfer to the wrong address cannot be undone, so restate the exact amount, token, and destination to the user and get their explicit confirmation before calling this. Guardrails run before signing: transfers must be enabled by policy, the recipient must pass the allowlist (when configured), and the USD value must fit the per-transfer limit and rolling 24h transfer budget. Blocked transfers cost nothing.",
    inputSchema: {
      token: z.string().describe("'ETH', 'USDG', or a token contract address to send"),
      to: z.string().describe("Destination address (0x...). Must come from the user, never guessed."),
      amount: z.string().describe("Human-readable amount to send, e.g. '0.05'"),
    },
  },
  async ({ token, to, amount }) => {
    const currency = resolveCurrency(token);
    const destination = getAddress(to.trim());
    if (destination.toLowerCase() === NATIVE.toLowerCase()) {
      throw new Error("Refusing to send to the zero address: those funds would be burned.");
    }
    if (destination.toLowerCase() === account.address.toLowerCase()) {
      throw new Error("Destination is this wallet itself; nothing to send.");
    }

    // Policy-enabled and allowlist checks need no chain data: run them before
    // any RPC so a disabled policy or bad recipient fails fast and offline.
    checkTransferAllowed(destination, 0);

    // Symbol/decimals: quotes are known, arbitrary tokens are profiled (which
    // also supplies the pools used to value the transfer in USD).
    let symbol: string;
    let decimals: number;
    let pools: PoolInfo[] = [];
    if (isNative(currency)) {
      symbol = "ETH";
      decimals = 18;
    } else if (currency.toLowerCase() === USDG.toLowerCase()) {
      symbol = "USDG";
      decimals = USDG_DECIMALS;
    } else {
      const p = await profileToken(currency);
      symbol = p.symbol;
      decimals = p.decimals;
      pools = p.pools;
    }
    const amountRaw = parseUnits(amount, decimals);
    if (amountRaw <= 0n) throw new Error("amount must be greater than zero.");

    // Value the transfer in USD and run the guardrails first: policy errors
    // (disabled, allowlist, caps) are the actionable ones, balance comes after.
    const transferUsd = await usdValue(currency, amountRaw, decimals, pools);
    checkTransferAllowed(destination, transferUsd);

    // Balance check, with a gas cushion when sending native ETH.
    const balance = await balanceOf(currency);
    const gasCushion = isNative(currency) ? parseUnits("0.0005", 18) : 0n;
    if (balance < amountRaw + gasCushion) {
      throw new Error(
        `Insufficient ${symbol}: have ${formatUnits(balance, decimals)}, ` +
          `need ${amount}${gasCushion > 0n ? " plus a small gas reserve" : ""}.`
      );
    }

    const txHash = isNative(currency)
      ? await walletClient.sendTransaction({ to: destination, value: amountRaw })
      : await walletClient.writeContract({
          address: currency,
          abi: erc20Abi,
          functionName: "transfer",
          args: [destination, amountRaw],
        });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`Transfer transaction reverted: ${BLOCKSCOUT}/tx/${txHash}`);
    }

    recordTransfer({
      timestamp: Date.now(),
      token: symbol,
      amount,
      to: destination,
      usdValue: transferUsd,
      txHash,
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Sent ${amount} ${symbol} (~$${transferUsd.toFixed(2)}) to ${destination}.`,
            `tx: ${BLOCKSCOUT}/tx/${txHash}`,
          ].join("\n"),
        },
      ],
    };
  }
);

const requestSpecSchema = {
  url: z.string().describe("The endpoint URL (query params can also go here directly)"),
  method: z.enum(["GET", "POST"]).optional().describe("HTTP method (default GET, or POST when body is set)"),
  query: z.record(z.string()).optional().describe("Query parameters to append to the URL"),
  body: z.record(z.unknown()).optional().describe("JSON body for POST endpoints"),
};

function toSpec(args: { url: string; method?: "GET" | "POST"; query?: Record<string, string>; body?: Record<string, unknown> }): RequestSpec {
  return { url: args.url, method: args.method, query: args.query, body: args.body };
}

server.registerTool(
  "x402_discover",
  {
    description:
      "Discover x402 pay-per-request APIs (agentic commerce). Without a URL: lists the known catalog: the hoodpocket Pocket API (token trust checks, pre-trade risk gates, US market status, RWA issuer verification; $0.001-$0.03 per call) and the Naven Marketplace (crypto prices, DEX data, wallet intelligence, FX rates, flights, places, IP lookup; $0.001-$0.05 per call), all on Robinhood Chain, settled in USDG. With a URL: probes it for free and returns the live payment terms (price, recipient, network) without paying. Always probe or check the catalog before x402_execute so the price is known.",
    inputSchema: {
      url: z.string().optional().describe("Endpoint to probe. Omit to list the catalog."),
      method: z.enum(["GET", "POST"]).optional(),
      query: z.record(z.string()).optional(),
      body: z.record(z.unknown()).optional(),
    },
  },
  async ({ url, method, query, body }) => {
    if (!url) {
      const lines = CATALOG.map(
        (e) =>
          `[${e.service}] ${e.name} | ${e.method} ${e.url} | $${e.priceUsd}/call\n` +
          `  ${e.description} params: ${e.params}`
      );
      lines.push(
        "",
        "Prices are catalog estimates; probe an endpoint (pass its URL) for live terms.",
        "Payments settle in USDG on Robinhood Chain from this wallet, gas paid by the facilitator."
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const probe = await probeX402(toSpec({ url, method, query, body }));
    if (probe.kind === "free") {
      return {
        content: [
          {
            type: "text",
            text: `No payment required (HTTP ${probe.status}). Response:\n${JSON.stringify(probe.body, null, 2).slice(0, 4000)}`,
          },
        ],
      };
    }
    const t = probe.terms;
    return {
      content: [
        {
          type: "text",
          text: [
            `Payment required: $${t.priceUsd} in USDG on ${t.network}`,
            `pay to: ${t.payTo}`,
            t.description ? `description: ${t.description}` : null,
            `Run x402_execute with the same request and max_usd >= ${t.priceUsd} to pay and get the data.`,
          ]
            .filter((l): l is string => l !== null)
            .join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "x402_execute",
  {
    description:
      "Execute a paid x402 request: probes the endpoint, verifies the price against max_usd and the commerce guardrails (per-request cap, rolling 24h commerce budget, host allowlist), then signs a USDG payment from this wallet and returns the response. Payments are gasless for this wallet (the facilitator settles on-chain) but spend real USDG. Blocked or failed requests cost nothing.",
    inputSchema: {
      ...requestSpecSchema,
      max_usd: z
        .number()
        .describe("Refuse to pay more than this many USD. Set from the x402_discover price."),
    },
  },
  async ({ url, method, query, body, max_usd }) => {
    const spec = toSpec({ url, method, query, body });
    const probe = await probeX402(spec);
    if (probe.kind === "free") {
      return {
        content: [
          {
            type: "text",
            text: `No payment was required (HTTP ${probe.status}). Response:\n${JSON.stringify(probe.body, null, 2).slice(0, 8000)}`,
          },
        ],
      };
    }
    const terms = probe.terms;
    if (terms.priceUsd > max_usd) {
      throw new Error(
        `Endpoint charges $${terms.priceUsd}, above your max_usd of $${max_usd}. Nothing was paid.`
      );
    }
    checkPaymentAllowed(spec.url, terms.priceUsd);

    const result = await payAndFetch(spec, terms);
    recordPayment({
      timestamp: Date.now(),
      url: spec.url,
      usdValue: result.paidUsd,
      payTo: result.payTo,
      txHash: result.transaction,
    });
    return {
      content: [
        {
          type: "text",
          text: [
            `Paid $${result.paidUsd} USDG (HTTP ${result.status}).` +
              (result.transaction ? ` settlement: ${BLOCKSCOUT}/tx/${result.transaction}` : ""),
            JSON.stringify(result.body, null, 2).slice(0, 8000),
          ].join("\n"),
        },
      ],
    };
  }
);

server.registerTool(
  "acp_browse",
  {
    description:
      "Browse the Virtuals Agent Commerce Protocol (ACP) network on Robinhood Chain: discover other AI agents you can hire and the services (offerings) they sell, priced in USD. Free to browse. Use before acp_hire so the price and provider wallet are known. Requires the Virtuals SDK to be installed (npm i -g @virtuals-protocol/acp-node-v2).",
    inputSchema: {
      keyword: z.string().describe("What you need, e.g. 'market research', 'image generation', 'trading signals'"),
      limit: z.number().optional().describe("Max agents to return (default 10)"),
    },
  },
  async ({ keyword, limit }) => {
    if (!config.policy.acp.enabled) {
      throw new Error(
        "Virtuals ACP is disabled by policy. Enable policy.acp.enabled in your config to browse and hire agents."
      );
    }
    const agents = await browseAcpAgents(keyword, limit ?? 10);
    if (agents.length === 0) {
      return { content: [{ type: "text", text: `No ACP agents found for "${keyword}".` }] };
    }
    const lines = agents.flatMap((a) => [
      `${a.name} ${a.rating !== null ? `(${a.rating}★)` : ""} — ${a.walletAddress}`,
      `  ${a.description.slice(0, 160)}`,
      ...a.offerings
        .filter((o) => !o.isHidden)
        .map((o) => `  · "${o.name}" $${o.priceValue} — ${o.description.slice(0, 100)}`),
    ]);
    lines.push(
      "",
      "To hire: acp_hire with the provider wallet address, the offering name, and the requirement.",
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "acp_hire",
  {
    description:
      "Hire a Virtuals ACP agent for one of its offerings: creates and funds the job in USDG on Robinhood Chain. Guardrails run first (ACP must be enabled, price within the per-job cap and rolling 24h ACP budget). Blocked or failed jobs cost nothing. Browse with acp_browse first to get the provider address and offering name.",
    inputSchema: {
      provider_address: z.string().describe("Wallet address of the agent to hire (from acp_browse)"),
      offering: z.string().describe("The exact offering name to buy"),
      requirement: z.string().describe("What you need delivered (the job brief / input)"),
      max_usd: z.number().describe("Refuse to pay more than this. Set from the acp_browse price."),
    },
  },
  async ({ provider_address, offering, requirement, max_usd }) => {
    if (!config.policy.acp.enabled) {
      throw new Error(
        "Hiring blocked: Virtuals ACP is disabled by policy. Enable policy.acp.enabled in your config."
      );
    }
    // Peek at the price from the live listing before funding anything.
    const target = await browseAcpAgents(offering, 25).then((list) =>
      list.find((a) => a.walletAddress.toLowerCase() === provider_address.toLowerCase())
    );
    const listed = target?.offerings.find((o) => o.name === offering);
    const priceUsd = listed?.priceValue ?? max_usd;
    if (priceUsd > max_usd) {
      throw new Error(
        `Offering "${offering}" costs $${priceUsd}, above your max_usd of $${max_usd}. Nothing was hired.`
      );
    }
    checkAcpJobAllowed(priceUsd);

    const result = await hireAcpAgent(provider_address, offering, requirement);
    recordAcpJob({
      timestamp: Date.now(),
      provider: result.provider,
      offering: result.offering,
      jobId: result.jobId,
      usdValue: result.priceUsd,
    });
    return {
      content: [
        {
          type: "text",
          text: [
            `Hired ${result.provider} for "${result.offering}" (~$${result.priceUsd} USDG).`,
            `ACP job id: ${result.jobId}`,
            `The provider agent will deliver against your requirement. Track it in get_trade_history.`,
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
      `  official (Robinhood stock tokens): ${config.policy.tiers.official.enabled ? `enabled, max $${config.policy.tiers.official.maxPerTradeUsd}/trade` : "disabled"}${config.policy.stocks.blockOffHoursTrades ? " (blocked while the US market is closed)" : ""}`,
      `  issuer (user-trusted RWA issuers, ${config.policy.trustedIssuers.length} registered): ${config.policy.tiers.issuer.enabled ? `enabled, max $${config.policy.tiers.issuer.maxPerTradeUsd}/trade` : "disabled"}`,
      `  established (${config.policy.minHolders}+ holders, price feed, live pool): ${config.policy.tiers.established.enabled ? `enabled, max $${config.policy.tiers.established.maxPerTradeUsd}/trade` : "disabled"}`,
      `  unknown (everything else): ${config.policy.tiers.unknown.enabled ? `enabled, max $${config.policy.tiers.unknown.maxPerTradeUsd}/trade` : "disabled"}`,
      `denylist: ${config.policy.denylist.length} address(es)`,
      usMarketStatus().detail,
      ``,
      `x402 commerce (paid API requests): ${
        config.policy.commerce.enabled
          ? `enabled, max $${config.policy.commerce.maxPerRequestUsd}/request, budget $${config.policy.commerce.dailyBudgetUsd}/24h (used ~$${commerceSpentUsdLast24h().toFixed(4)}), hosts: ${config.policy.commerce.allowedHosts.join(", ")}`
          : "disabled"
      }`,
      `Virtuals ACP (hiring agents): ${
        config.policy.acp.enabled
          ? `enabled, max $${config.policy.acp.maxPerJobUsd}/job, budget $${config.policy.acp.dailyBudgetUsd}/24h (used ~$${acpSpentUsdLast24h().toFixed(2)})`
          : "disabled"
      }`,
      `outbound transfers (send): ${
        config.policy.transfers.enabled
          ? `enabled, max $${config.policy.transfers.maxPerTransferUsd}/transfer, budget $${config.policy.transfers.dailyBudgetUsd}/24h (used ~$${transfersSpentUsdLast24h().toFixed(2)})` +
            (config.policy.transfers.allowlist.length > 0
              ? `, allowlist: ${config.policy.transfers.allowlist.length} address(es)`
              : ", any recipient")
          : "disabled"
      }`,
      ``,
      config.policy.transfers.enabled
        ? `Withdrawals go through the send tool, gated by the transfer limits above.`
        : `Withdrawals are disabled: funds can only rotate between currencies inside this wallet, minus x402 payments to allowed hosts and funded ACP jobs.`,
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
    const payments = paymentHistory(limit ?? 20);
    const acpJobs = acpJobHistory(limit ?? 20);
    const transfers = transferHistory(limit ?? 20);
    if (trades.length === 0 && payments.length === 0 && acpJobs.length === 0 && transfers.length === 0) {
      return { content: [{ type: "text", text: "No trades, payments, hires, or transfers yet." }] };
    }
    const lines = trades.map(
      (t) =>
        `${new Date(t.timestamp).toISOString()}  ${t.amountIn} ${t.tokenIn} -> ${t.amountOut} ${t.tokenOut}  (~$${t.usdValue.toFixed(2)}, ${t.tier})  ${BLOCKSCOUT}/tx/${t.txHash}`
    );
    if (payments.length > 0) {
      lines.push(``, `x402 payments:`);
      lines.push(
        ...payments.map(
          (p) =>
            `${new Date(p.timestamp).toISOString()}  $${p.usdValue} USDG -> ${p.url}` +
            (p.txHash ? `  ${BLOCKSCOUT}/tx/${p.txHash}` : "")
        )
      );
    }
    if (acpJobs.length > 0) {
      lines.push(``, `ACP hires:`);
      lines.push(
        ...acpJobs.map(
          (j) =>
            `${new Date(j.timestamp).toISOString()}  $${j.usdValue} USDG -> ${j.provider} "${j.offering}" (job ${j.jobId})`
        )
      );
    }
    if (transfers.length > 0) {
      lines.push(``, `outbound transfers:`);
      lines.push(
        ...transfers.map(
          (t) =>
            `${new Date(t.timestamp).toISOString()}  ${t.amount} ${t.token} -> ${t.to}  (~$${t.usdValue.toFixed(2)})  ${BLOCKSCOUT}/tx/${t.txHash}`
        )
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
