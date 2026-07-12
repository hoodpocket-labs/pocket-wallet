# hoodpocket

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
- **No withdrawals.** There is deliberately no "send to address" tool: funds can rotate between currencies inside the wallet but can't leave it. Only you can move them out, with the key.
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
| `get_trade_history` | Recent trades with tx links |

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

The quick way (npm package):

```bash
# 1. Create the pocket wallet: a FRESH key (cast wallet new, or any wallet app).
#    Never reuse a key that guards real savings.

# 2. Fund it: ETH (gas + trading) and optionally USDG, sent to the wallet address.

# 3. Connect your agent
claude mcp add hoodpocket --env HOODPOCKET_PRIVATE_KEY=0xYourPocketKey -- npx -y hoodpocket
```

Sensible default guardrails apply out of the box ($1000/day budget, $500 official, $100 established, unknown blocked). To tune them, drop a `hoodpocket.config.json` ([example](hoodpocket.config.example.json)) in the directory the server runs from, or point `HOODPOCKET_CONFIG` at one.

From source instead:

```bash
git clone https://github.com/hoodpocket/pocket-wallet && cd pocket-wallet
npm install && npm run build
cp .env.example .env                                       # put the pocket key here
claude mcp add hoodpocket -- node /path/to/pocket-wallet/dist/index.js
```

Then try: *"Search for CASHCAT, verify which one is real, and buy $10 worth with ETH if the price looks fair."*

## Trust model (honest version)

Guardrails are enforced by this server's code before signing, not by the blockchain. If the machine running hoodpocket is compromised, the key is only as safe as that machine: keep the pocket small. Tier classification makes scams expensive, not impossible. Copied bytecode plus real seeded liquidity could still fool the "official" tier when the explorer's creator-check is unavailable. Treat tiers as a strong filter, not a guarantee.

## Roadmap

- [x] Native ETH pairs (memecoins, Virtuals utility tokens)
- [ ] Multi-hop routing for token-to-token trades
- [ ] Batched pool-liquidity reads (multicall) for tokens with 100+ pools
- [ ] Position tracking with cost basis and P&L
- [ ] Optional hosted key management (Privy / Turnkey)
- [ ] Vault mode: on-chain enforcement via an ERC-4337 smart account for larger balances

## Disclaimer

Experimental software, not audited, not financial advice. Fund the pocket only with what you can afford to lose. hoodpocket is an independent project, not affiliated with or endorsed by Robinhood.
