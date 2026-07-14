# hoodpocket

[![npm version](https://img.shields.io/npm/v/hoodpocket?color=%23fafafa&labelColor=%23060607)](https://www.npmjs.com/package/hoodpocket)
[![license](https://img.shields.io/npm/l/hoodpocket?color=%23a1a1aa&labelColor=%23060607)](LICENSE)

**A pocket trading wallet for AI agents on Robinhood Chain.**

Give your AI agent a small, separate wallet it can trade from 24/7, with guardrails you set. hoodpocket is an [MCP](https://modelcontextprotocol.io) server, so any MCP-capable agent (Claude, ChatGPT, Cursor, and others) can trade memecoins, utility tokens, and tokenized stocks on [Robinhood Chain](https://robinhoodchain.blockscout.com) through it. Self-custodial: the key is yours, the funds are yours.

```
┌─────────────────┐    MCP     ┌──────────────────────────────┐   txs    ┌───────────────────┐
│    AI agent     │ ─────────► │          hoodpocket          │ ───────► │  Robinhood Chain  │
│  (Claude, ...)  │            │ classify → guardrails → sign │          │    Uniswap V4     │
└─────────────────┘            └──────────────────────────────┘          └───────────────────┘
```

## No hardcoded token list

Robinhood Chain is an open chain: memecoins from launchpads like Noxa, utility tokens from Virtuals, the ~95 official stock tokens, and thousands of fakes right next to them. The explorer lists a token with the symbol `USDC` whose real name is "UpSide Down Cat", several fake "Apple" tokens, a counterfeit "Global Dollar", and four copycat CASHCATs. Names are free to fake, so hoodpocket never trusts them.

Instead, the agent discovers tokens dynamically (`search_tokens`) and every address is classified into a **trust tier** using signals that cost money to fake:

| Tier | Signals | Default policy |
|---|---|---|
| **official** | runtime bytecode matches the official Robinhood stock-token fingerprint (identical across AAPL, NVDA, TSLA, GOOGL, and the rest) + deployer cross-check + live quote pool | $500/trade |
| **established** | 1000+ holders, indexed price feed, live Uniswap V4 liquidity against ETH or USDG | $100/trade |
| **unknown** | everything else | blocked |

On top of tiers sits one **rolling 24h USD budget** for total turnover, valued at trade time via the Uniswap V4 quoter. All thresholds are yours to change in `hoodpocket.config.json`.

## Quote currencies: ETH and USDG

Trades route through the two currencies that actually hold the chain's liquidity:

- **Native ETH**: where memecoins and utility tokens live. CASHCAT alone has ~96 ETH pools and zero USDG pools.
- **USDG** (Global Dollar): where the official stock tokens trade.

USD guardrail valuation for ETH pairs goes through the deep native-ETH/USDG pools (57 of them), so budgets stay dollar-denominated no matter which side the agent trades.

## How it stays safe

- **Separate pocket.** A fresh key funded only with what you're willing to let the agent trade. Worst case is the pocket, nothing more. (Same philosophy as Robinhood's own agentic accounts: isolation + limits.)
- **Guardrails before signatures.** Tier policy, per-trade USD limit, and daily budget are checked before anything is signed. Blocked trades cost nothing and return a readable reason the agent can adapt to.
- **No withdrawals.** There is deliberately no "send to address" tool: funds can rotate between currencies inside the wallet but can't leave it, with one narrow exception: x402 payments to allowlisted API hosts, capped by their own per-request and daily limits. Only you can move funds out, with the key.
- **Names are never identity.** Trades reference contract addresses; the fake-USDC problem can't bite.
- **Full history.** Every trade is recorded locally with explorer links (`get_trade_history`).

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `search_tokens` | Find tokens by name/symbol (memes, utility tokens, stocks) |
| `get_token_info` | Classify an address into a trust tier, with reasons |
| `quote` | Executable price for a swap vs ETH or USDG (best V4 pool) |
| `swap` | Exact-input swap via Uniswap V4 Universal Router, guardrails enforced |
| `get_portfolio` | ETH (with live USD value), USDG, and previously traded positions |
| `get_limits` | Current policy + how much of the daily budget is used |
| `get_trade_history` | Recent trades and x402 payments with tx links |
| `x402_discover` | Browse the pay-per-request API catalog, or probe any endpoint's live price for free |
| `x402_execute` | Pay for an API call in USDG via x402, guardrails enforced |
| `acp_browse` | Discover agents to hire on the Virtuals ACP network (opt-in) |
| `acp_hire` | Hire and pay a Virtuals agent for a job in USDG, guardrails enforced |

## Agentic commerce: x402 paid APIs

Beyond trading, the pocket can pay for data. hoodpocket speaks [x402](https://docs.naven.network/getting-started/how-x402-payments-work), the HTTP 402 payment standard: an endpoint quotes its price in a 402 challenge, hoodpocket signs a USDG payment (EIP-3009, gasless for the wallet; the facilitator settles on-chain), retries the request, and returns the data.

Out of the box the catalog covers the [Naven Marketplace](https://naven.network/marketplace) on Robinhood Chain: CoinGecko and CoinMarketCap market data, Nansen wallet intelligence, FX rates, flight search, place search, and IP lookup, at $0.001 to $0.05 per call. Any other x402 endpoint works too once its host is allowed.

Commerce has its own guardrails, separate from the trading budget:

```json
"commerce": {
  "enabled": true,
  "maxPerRequestUsd": 0.25,
  "dailyBudgetUsd": 5,
  "allowedHosts": ["api.naven.network"]
}
```

Discovery (probing an endpoint's price) is free and unrestricted; paying requires the host to be allowlisted, the price to fit both the per-request cap and the rolling 24h commerce budget, and the agent's own `max_usd` bound. The challenge must settle in USDG on Robinhood Chain; anything else is refused. Every payment lands in `get_trade_history` with its settlement tx.

Try: *"Check what the Naven marketplace offers, then pull the trending pools on Robinhood Chain (it costs a cent)."*

## Agent-to-agent commerce: Virtuals ACP

The pocket can also hire *other agents*. hoodpocket integrates the [Virtuals Agent Commerce Protocol](https://whitepaper.virtuals.io/about-virtuals/commerce-layer) (ACP), which runs natively on Robinhood Chain (chain id 4663) and connects the ~18k-agent Virtuals economy. Your agent can discover a provider agent, buy one of its offerings, and pay in USDG, all from the same pocket.

This is **off by default** (hiring moves funds) and has its own guardrails:

```json
"acp": {
  "enabled": false,
  "maxPerJobUsd": 5,
  "dailyBudgetUsd": 25
}
```

The Virtuals SDK is heavy and still beta, so it is an **optional** dependency, loaded only when you enable ACP. Install it once when you want it:

```bash
npm i -g @virtuals-protocol/acp-node-v2
```

`acp_browse` is free discovery; `acp_hire` runs the guardrails (ACP enabled, price within the per-job cap and rolling 24h ACP budget, the agent's own `max_usd`) before creating and funding the job. Hires land in `get_trade_history`.

## Verified chain constants

All pinned in [src/chain.ts](src/chain.ts), verified on-chain and cross-checked against the Uniswap deployment docs and Blockscout (2026-07-11):

| What | Address |
|---|---|
| RPC | `https://rpc.mainnet.chain.robinhood.com` (chain id 4663) |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDG (Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Native ETH (V4 currency) | `0x0000000000000000000000000000000000000000` |

All liquidity lives on **Uniswap V4** (the PoolManager is the largest holder of the official stock tokens). Memecoins pair against native ETH; stock tokens pair against USDG.

## Setup

Two commands, no keys to manage:

```bash
# 1. Connect your agent. On first run hoodpocket generates a fresh pocket
#    wallet automatically (stored at ~/.hoodpocket/wallet.json, chmod 600).
claude mcp add hoodpocket -- npx -y hoodpocket

# 2. See the wallet address and fund it with ETH (gas + trading):
npx -y hoodpocket address
```

Or just ask your agent for the portfolio: it will tell you the address and that it needs funding. Back up the key anytime with `npx -y hoodpocket export-key` (human-run only; the key is never exposed through MCP tools, so a prompt-injected agent cannot exfiltrate it).

Sensible default guardrails apply out of the box ($1000/day budget, $500 official, $100 established, unknown blocked). To tune them, put a config ([example](hoodpocket.config.example.json)) at `~/.hoodpocket/config.json`, or point `HOODPOCKET_CONFIG` at one.

Bring your own key instead by setting `HOODPOCKET_PRIVATE_KEY` (it takes precedence over the keystore). From source: `git clone`, `npm install && npm run build`, then `claude mcp add hoodpocket -- node /path/to/pocket-wallet/dist/index.js`.

Then try: *"Search for CASHCAT, verify which one is real, and buy $10 worth with ETH if the price looks fair."*

## Trust model (honest version)

Guardrails are enforced by this server's code before signing, not by the blockchain. If the machine running hoodpocket is compromised, the key is only as safe as that machine: keep the pocket small. Tier classification makes scams expensive, not impossible. Copied bytecode plus real seeded liquidity could still fool the "official" tier when the explorer's creator-check is unavailable. Treat tiers as a strong filter, not a guarantee.

## Roadmap

- [x] Native ETH pairs (memecoins, Virtuals utility tokens)
- [x] x402 agentic commerce: pay-per-request APIs settled in USDG (Naven Marketplace)
- [ ] Multi-hop routing for token-to-token trades
- [ ] Batched pool-liquidity reads (multicall) for tokens with 100+ pools
- [ ] Position tracking with cost basis and P&L
- [ ] Optional hosted key management (Privy / Turnkey)
- [ ] Vault mode: on-chain enforcement via an ERC-4337 smart account for larger balances

## Disclaimer

Experimental software, not audited, not financial advice. Fund the pocket only with what you can afford to lose. hoodpocket is an independent project, not affiliated with or endorsed by Robinhood.
