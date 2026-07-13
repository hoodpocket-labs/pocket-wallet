import { formatUnits } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { CHAIN_ID, USDG, USDG_DECIMALS, account, publicClient } from "./chain.js";

/** The x402 network identifier for Robinhood Chain mainnet. */
export const X402_NETWORK = `eip155:${CHAIN_ID}`;

/**
 * Known x402-gated services, seeded with the Naven Marketplace catalog
 * (extracted from naven.network/marketplace, 2026-07-13; prices in USD).
 * x402 endpoints are self-describing: the catalog is a starting point, and
 * the live 402 challenge from x402_discover is the source of truth for price
 * and payment terms. All entries settle in USDG on Robinhood Chain.
 */
export interface CatalogEntry {
  service: string;
  name: string;
  method: "GET" | "POST";
  url: string;
  priceUsd: number;
  params: string;
  description: string;
}

const NAVEN_API = "https://api.naven.network";

export const CATALOG: CatalogEntry[] = [
  {
    service: "naven",
    name: "x402 test ping",
    method: "GET",
    url: `${NAVEN_API}/x402-test/ping`,
    priceUsd: 0.0001,
    params: "none",
    description: "Cheapest possible paid request; use to verify the payment flow end to end.",
  },
  {
    service: "coingecko",
    name: "Simple price",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coingecko/simple-price`,
    priceUsd: 0.01,
    params: "query: assets (CoinGecko IDs, e.g. 'bitcoin,ethereum'), quote_currency ('usd')",
    description: "Price and market data for CoinGecko-listed coins.",
  },
  {
    service: "coingecko",
    name: "Token by contract",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coingecko/onchain/networks/{network}/tokens/{address}`,
    priceUsd: 0.01,
    params: "path: network (e.g. 'robinhood'), address (token contract)",
    description: "Price, liquidity, and market data for a token by contract address.",
  },
  {
    service: "coingecko",
    name: "Trending pools",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coingecko/onchain/networks/{network}/trending_pools`,
    priceUsd: 0.01,
    params: "path: network (e.g. 'robinhood')",
    description: "Trending liquidity pools on a specific network.",
  },
  {
    service: "coingecko",
    name: "Search tokens and pools",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coingecko/onchain/search/pools`,
    priceUsd: 0.01,
    params: "query: query (name/symbol/address), network (optional, e.g. 'robinhood')",
    description: "Search pools and tokens across networks.",
  },
  {
    service: "coingecko",
    name: "Token price by contract",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coingecko/onchain/simple/networks/{network}/token_price/{address}`,
    priceUsd: 0.01,
    params: "path: network, address",
    description: "Token price by contract address on a specific network.",
  },
  {
    service: "coinmarketcap",
    name: "DEX search",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coinmarketcap/dex/search`,
    priceUsd: 0.01,
    params: "query: q (name/symbol/address)",
    description: "Search DEX tokens.",
  },
  {
    service: "coinmarketcap",
    name: "Latest cryptocurrency listings",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coinmarketcap/cryptocurrency/listings/latest`,
    priceUsd: 0.01,
    params: "query: start (rank), limit",
    description: "Active cryptocurrencies ranked by market cap.",
  },
  {
    service: "coinmarketcap",
    name: "Latest cryptocurrency quotes",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coinmarketcap/cryptocurrency/quotes/latest`,
    priceUsd: 0.01,
    params: "query: id (CoinMarketCap IDs, e.g. '1,1027')",
    description: "Price, volume, market cap, and percentage changes by CMC ID.",
  },
  {
    service: "coinmarketcap",
    name: "Latest DEX pair quotes",
    method: "GET",
    url: `${NAVEN_API}/marketplace/coinmarketcap/dex/pairs/quotes/latest`,
    priceUsd: 0.01,
    params: "query: pair_address",
    description: "Real-time pricing and trading data for a DEX pair contract.",
  },
  {
    service: "nansen",
    name: "Address token balances",
    method: "POST",
    url: `${NAVEN_API}/marketplace/nansen/address/current-balance`,
    priceUsd: 0.01,
    params: "body: address (wallet), chain (e.g. 'ethereum')",
    description: "Current token holdings and USD values for a wallet.",
  },
  {
    service: "nansen",
    name: "Token holders",
    method: "POST",
    url: `${NAVEN_API}/marketplace/nansen/token-holders`,
    priceUsd: 0.05,
    params: "body: chain, token_address",
    description: "Top token holders including labeled smart-money and fund activity.",
  },
  {
    service: "auor",
    name: "Current exchange rates",
    method: "GET",
    url: `${NAVEN_API}/marketplace/auor/rates`,
    priceUsd: 0.001,
    params: "query: source (e.g. 'USD'), target (e.g. 'EUR')",
    description: "Current fiat exchange rates.",
  },
  {
    service: "auor",
    name: "Historical exchange rates",
    method: "GET",
    url: `${NAVEN_API}/marketplace/auor/rates/historical`,
    priceUsd: 0.001,
    params: "query: source, target, time (ISO 8601)",
    description: "Historical fiat exchange rates.",
  },
  {
    service: "auor",
    name: "Flight offers",
    method: "GET",
    url: `${NAVEN_API}/marketplace/auor/flights/search`,
    priceUsd: 0.03,
    params: "query: see 402 challenge",
    description: "Search Amadeus flight offers.",
  },
  {
    service: "auor",
    name: "Place search",
    method: "GET",
    url: `${NAVEN_API}/marketplace/auor/places/search`,
    priceUsd: 0.04,
    params: "query: see 402 challenge",
    description: "Search places with full details.",
  },
  {
    service: "auor",
    name: "IP lookup",
    method: "GET",
    url: `${NAVEN_API}/marketplace/auor/ip/lookup`,
    priceUsd: 0.001,
    params: "query: see 402 challenge",
    description: "IP geolocation and metadata.",
  },
];

// One client for the process. The exact scheme signs an EIP-3009
// transferWithAuthorization off-chain; the facilitator settles it on-chain
// and pays the gas, so paid requests spend USDG but no ETH.
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(signer));
const http = new x402HTTPClient(client);

/** Payment terms extracted from a 402 challenge, filtered to what we can pay. */
export interface PaymentTerms {
  priceUsd: number;
  /** Atomic USDG units, straight from the challenge. */
  amount: string;
  payTo: string;
  network: string;
  asset: string;
  description: string;
  /** The raw accepts entry, fed back into payload creation on execute. */
  requirements: Record<string, unknown>;
  paymentRequired: Record<string, unknown>;
}

export interface RequestSpec {
  url: string;
  method?: "GET" | "POST";
  /** Query parameters, appended to the URL. */
  query?: Record<string, string>;
  /** JSON body for POST requests. */
  body?: Record<string, unknown>;
}

function buildRequest(spec: RequestSpec): { url: string; init: RequestInit } {
  const url = new URL(spec.url);
  for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v);
  const init: RequestInit = { method: spec.method ?? "GET" };
  if (spec.body !== undefined) {
    init.method = spec.method ?? "POST";
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(spec.body);
  }
  return { url: url.toString(), init };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Parse a 402 response into terms we are willing to pay: the challenge must
 * offer the exact scheme in USDG on Robinhood Chain. Amounts in other tokens
 * or on other networks are reported as errors, never paid.
 */
function extractTerms(res: Response, body: unknown): PaymentTerms {
  const paymentRequired = http.getPaymentRequiredResponse((name) => res.headers.get(name), body);
  const accepts = (paymentRequired.accepts ?? []) as Array<Record<string, unknown>>;
  const match = accepts.find(
    (a) =>
      a.scheme === "exact" &&
      a.network === X402_NETWORK &&
      String(a.asset).toLowerCase() === USDG.toLowerCase()
  );
  if (!match) {
    const offered = accepts
      .map((a) => `${a.scheme} on ${a.network} in ${a.asset}`)
      .join("; ") || "nothing";
    throw new Error(
      `No acceptable payment option: need exact/USDG on ${X402_NETWORK}, endpoint offers ${offered}.`
    );
  }
  // v2 uses `amount`, v1 uses `maxAmountRequired`; both are atomic units.
  const amount = String(match.amount ?? match.maxAmountRequired ?? "0");
  const resource = paymentRequired.resource as { description?: string } | undefined;
  return {
    priceUsd: Number(formatUnits(BigInt(amount), USDG_DECIMALS)),
    amount,
    payTo: String(match.payTo ?? "unknown"),
    network: String(match.network),
    asset: String(match.asset),
    description: resource?.description ?? String(match.description ?? ""),
    requirements: match,
    paymentRequired: paymentRequired as unknown as Record<string, unknown>,
  };
}

export type ProbeResult =
  | { kind: "payment_required"; terms: PaymentTerms }
  | { kind: "free"; status: number; body: unknown };

/** Hit an endpoint without paying. Free endpoints return their response; paid ones their terms. */
export async function probeX402(spec: RequestSpec): Promise<ProbeResult> {
  const { url, init } = buildRequest(spec);
  const res = await fetch(url, init);
  const body = await readBody(res);
  if (res.status !== 402) return { kind: "free", status: res.status, body };
  return { kind: "payment_required", terms: extractTerms(res, body) };
}

export interface PaidResult {
  status: number;
  body: unknown;
  paidUsd: number;
  payTo: string;
  /** Settlement tx hash when the facilitator reports one. */
  transaction: string | null;
}

/**
 * Execute a paid request. The caller has already run the guardrails against
 * `terms`; this signs the payment and retries the request with the signature
 * header. The settlement response is read back so the spend can be recorded
 * against the actual on-chain transaction.
 */
export async function payAndFetch(spec: RequestSpec, terms: PaymentTerms): Promise<PaidResult> {
  // Narrow the challenge to the single accepts entry the guardrails approved,
  // so the library cannot select a different (pricier or wrong-asset) option.
  const narrowed = { ...terms.paymentRequired, accepts: [terms.requirements] };
  const payload = await http.createPaymentPayload(narrowed as Parameters<typeof http.createPaymentPayload>[0]);
  const headers = http.encodePaymentSignatureHeader(payload);
  const { url, init } = buildRequest(spec);
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...headers },
  });
  const body = await readBody(res);
  if (res.status === 402) {
    const reason =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error: string }).error
        : JSON.stringify(body);
    throw new Error(`Payment rejected by the endpoint: ${reason}`);
  }
  let transaction: string | null = null;
  try {
    const settle = http.getPaymentSettleResponse((name) => res.headers.get(name));
    transaction = settle.transaction || null;
  } catch {
    // No settlement header; the payment may still have settled server-side.
  }
  return { status: res.status, body, paidUsd: terms.priceUsd, payTo: terms.payTo, transaction };
}
