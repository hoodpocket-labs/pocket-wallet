import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { config } from "./config.js";
import { loadOrCreateWallet } from "./keystore.js";

/**
 * Robinhood Chain mainnet constants.
 * All addresses verified against on-chain code and cross-checked between the
 * Uniswap deployment docs and the chain's Blockscout instance (2026-07-11).
 */
export const CHAIN_ID = 4663;
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

// Uniswap V4 (where stock-token liquidity lives: the PoolManager is the
// largest holder of the official stock tokens)
export const POOL_MANAGER: Address = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
export const UNIVERSAL_ROUTER: Address = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
export const V4_QUOTER: Address = getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
export const STATE_VIEW: Address = getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b");
export const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

// USDG (Global Dollar, Paxos), the canonical stablecoin. 6 decimals, ~12k
// holders. Beware: several scam tokens also use the USDG name.
export const USDG: Address = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const USDG_DECIMALS = 6;

// Native ETH is a first-class V4 currency (address zero). Memecoins (Noxa
// launches) and utility tokens (Virtuals) overwhelmingly pair against it;
// e.g. CASHCAT has ~96 native-ETH pools and zero USDG pools.
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** Quote currencies discovery searches against, in priority order. */
export const QUOTES: Array<{ address: Address; symbol: string; decimals: number }> = [
  { address: NATIVE, symbol: "ETH", decimals: 18 },
  { address: USDG, symbol: "USDG", decimals: USDG_DECIMALS },
];

// Every official "X • Robinhood Token" stock token shares this exact runtime
// bytecode hash (verified across AAPL, NVDA, TSLA, GOOGL). Used as a
// provenance fingerprint during token classification.
export const OFFICIAL_STOCK_CODEHASH: Hex =
  "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";

// Deployer of the official stock tokens (verified via NVDA's creation tx).
// Used as a secondary check when the explorer API is responsive.
export const OFFICIAL_ISSUER: Address = getAddress("0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046");

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl ?? DEFAULT_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: BLOCKSCOUT } },
});

export const wallet = loadOrCreateWallet();
export const account = privateKeyToAccount(wallet.privateKey);
export const publicClient = createPublicClient({ chain, transport: http() });
export const walletClient = createWalletClient({ account, chain, transport: http() });

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
