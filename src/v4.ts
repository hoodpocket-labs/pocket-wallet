import { encodeAbiParameters, formatUnits, parseAbi, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import {
  NATIVE,
  PERMIT2,
  UNIVERSAL_ROUTER,
  USDG,
  USDG_DECIMALS,
  V4_QUOTER,
  account,
  erc20Abi,
  publicClient,
  walletClient,
} from "./chain.js";
import { findPairPools, type PoolInfo } from "./discovery.js";

const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

// Universal Router command / V4 action bytes
const CMD_V4_SWAP = "0x10";
const ACTION_SWAP_EXACT_IN_SINGLE = "06";
const ACTION_SETTLE_ALL = "0c";
const ACTION_TAKE_ALL = "0f";

export function isNative(address: Address): boolean {
  return address.toLowerCase() === NATIVE.toLowerCase();
}

function poolKeyOf(pool: PoolInfo) {
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  };
}

/** Simulate the V4 quoter for an exact-input single-pool swap. */
export async function quotePool(pool: PoolInfo, tokenIn: Address, amountIn: bigint): Promise<bigint> {
  const zeroForOne = tokenIn.toLowerCase() === pool.currency0.toLowerCase();
  const { result } = await publicClient.simulateContract({
    address: V4_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: poolKeyOf(pool), zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return result[0];
}

/** Best executable quote across the given pools. */
export async function bestQuote(
  pools: PoolInfo[],
  tokenIn: Address,
  amountIn: bigint
): Promise<{ pool: PoolInfo; amountOut: bigint }> {
  let best: { pool: PoolInfo; amountOut: bigint } | null = null;
  for (const pool of pools.filter((p) => p.liquidity > 0n)) {
    try {
      const amountOut = await quotePool(pool, tokenIn, amountIn);
      if (!best || amountOut > best.amountOut) best = { pool, amountOut };
    } catch {
      // pool can't fill this size, skip
    }
  }
  if (!best) throw new Error("No pool can fill this trade size");
  return best;
}

// ─── ETH/USD pricing (via the deep native-ETH/USDG V4 pools) ─────────────────

let ethUsdCache: { at: number; price: number } | null = null;
const ETH_USD_TTL_MS = 60 * 1000;

export async function ethUsdPrice(): Promise<number> {
  if (ethUsdCache && Date.now() - ethUsdCache.at < ETH_USD_TTL_MS) return ethUsdCache.price;
  const pools = await findPairPools(NATIVE, USDG);
  const { amountOut } = await bestQuote(pools, NATIVE, parseUnits("1", 18));
  const price = Number(formatUnits(amountOut, USDG_DECIMALS));
  ethUsdCache = { at: Date.now(), price };
  return price;
}

/**
 * Rough USD value of an amount of a currency.
 * USDG is identity, native ETH goes through the ETH/USDG pools, and other
 * tokens are quoted against their best pool (USDG directly, or ETH then USD).
 */
export async function usdValue(
  currency: Address,
  amount: bigint,
  decimals: number,
  pools: PoolInfo[]
): Promise<number> {
  if (currency.toLowerCase() === USDG.toLowerCase()) {
    return Number(formatUnits(amount, USDG_DECIMALS));
  }
  if (isNative(currency)) {
    return Number(formatUnits(amount, 18)) * (await ethUsdPrice());
  }
  const usdgPools = pools.filter((p) => p.quote.toLowerCase() === USDG.toLowerCase());
  if (usdgPools.some((p) => p.liquidity > 0n)) {
    const { amountOut } = await bestQuote(usdgPools, currency, amount);
    return Number(formatUnits(amountOut, USDG_DECIMALS));
  }
  const ethPools = pools.filter((p) => isNative(p.quote));
  const { amountOut } = await bestQuote(ethPools, currency, amount);
  return Number(formatUnits(amountOut, 18)) * (await ethUsdPrice());
}

// ─── Execution ────────────────────────────────────────────────────────────────

/** ERC20 -> Permit2 -> UniversalRouter approval chain (skipped for native ETH). */
async function ensureApprovals(token: Address, amount: bigint): Promise<void> {
  if (isNative(token)) return;

  const erc20Allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, PERMIT2],
  });
  if (erc20Allowance < amount) {
    const tx = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }

  const [permitAmount, expiration] = await publicClient.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [account.address, token, UNIVERSAL_ROUTER],
  });
  const now = Math.floor(Date.now() / 1000);
  if (permitAmount < amount || expiration <= now) {
    const tx = await walletClient.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, UNIVERSAL_ROUTER, 2n ** 160n - 1n, now + 30 * 24 * 3600],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }
}

export interface SwapExecution {
  txHash: Hex;
  gasCostWei: bigint;
}

/** Execute an exact-input single-pool V4 swap through the Universal Router. */
export async function swapV4(
  pool: PoolInfo,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<SwapExecution> {
  await ensureApprovals(tokenIn, amountIn);

  const zeroForOne = tokenIn.toLowerCase() === pool.currency0.toLowerCase();
  const actions: Hex = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}`;

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { type: "address", name: "currency0" },
              { type: "address", name: "currency1" },
              { type: "uint24", name: "fee" },
              { type: "int24", name: "tickSpacing" },
              { type: "address", name: "hooks" },
            ],
          },
          { type: "bool", name: "zeroForOne" },
          { type: "uint128", name: "amountIn" },
          { type: "uint128", name: "amountOutMinimum" },
          { type: "bytes", name: "hookData" },
        ],
      },
    ],
    [
      {
        poolKey: poolKeyOf(pool),
        zeroForOne,
        amountIn,
        amountOutMinimum: minAmountOut,
        hookData: "0x",
      },
    ]
  );
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenIn, amountIn]
  );
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenOut, minAmountOut]
  );
  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]]
  );

  const tx = await walletClient.writeContract({
    address: UNIVERSAL_ROUTER,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [CMD_V4_SWAP, [v4Input], BigInt(Math.floor(Date.now() / 1000) + 300)],
    // Native ETH input travels as msg.value; the router settles it into the pool.
    value: isNative(tokenIn) ? amountIn : 0n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`Swap transaction reverted: ${tx}`);
  return { txHash: tx, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice };
}
