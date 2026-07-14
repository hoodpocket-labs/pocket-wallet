import type { Address, Call } from "viem";
import { CHAIN_ID, account, publicClient, walletClient } from "./chain.js";

/**
 * Virtuals Agent Commerce Protocol (ACP) integration.
 *
 * ACP is the agent-to-agent commerce layer of Virtuals Protocol, and it
 * natively supports Robinhood Chain mainnet (chain id 4663). This lets a
 * hoodpocket agent discover the ~18k agents in the Virtuals economy, hire one
 * for a job, and pay it, all from the same guardrailed pocket.
 *
 * The ACP SDK (@virtuals-protocol/acp-node-v2) is heavy (Solana, Privy, and
 * Alchemy deps) and still beta, so it is NOT a hard dependency. It is imported
 * dynamically and only when the owner opts in via policy.commerce.acp. If it
 * is not installed, the tools return a clear install hint instead of failing.
 */

// ── Minimal structural types for the ACP SDK boundary ────────────────────────
// Mirrors @virtuals-protocol/acp-node-v2's public API (v0.1.7). We type only
// what we call so the wallet needs no compile-time dependency on the SDK.

export interface AcpOffering {
  name: string;
  description: string;
  priceType: string;
  priceValue: number;
  slaMinutes: number;
  requirements: Record<string, unknown> | string;
  isHidden: boolean;
}

export interface AcpAgentDetail {
  id: string;
  name: string;
  description: string;
  walletAddress: string;
  role: string;
  rating: number | null;
  lastActiveAt: string;
  offerings: AcpOffering[];
}

interface IEvmProviderAdapter {
  readonly providerName: string;
  getAddress(): Promise<Address>;
  getSupportedChainIds(): Promise<number[]>;
  getNetworkContext(chainId: number): Promise<unknown>;
  sendTransaction(chainId: number, call: Call | Call[]): Promise<Address>;
  sendCalls(chainId: number, calls: Call[]): Promise<Address | Address[]>;
  getTransactionReceipt(chainId: number, hash: Address): Promise<unknown>;
  readContract(chainId: number, params: unknown): Promise<unknown>;
  getLogs(chainId: number, params: unknown): Promise<unknown[]>;
  getBlockNumber(chainId: number): Promise<bigint>;
  signMessage(chainId: number, message: string): Promise<string>;
  signTypedData(chainId: number, typedData: unknown): Promise<string>;
}

interface AcpModule {
  AcpAgent: {
    create(input: { provider: IEvmProviderAdapter }): Promise<AcpAgentInstance>;
  };
  createEvmNetworkContext(chainId: number): unknown;
}

interface AcpAgentInstance {
  browseAgents(keyword: string, params?: { topK?: number }): Promise<AcpAgentDetail[]>;
  getAgentByWalletAddress(walletAddress: string): Promise<AcpAgentDetail | null>;
  createJobFromOffering(
    chainId: number,
    offering: AcpOffering,
    providerAddress: string,
    requirementData: Record<string, unknown> | string,
    opts?: { evaluatorAddress?: string }
  ): Promise<bigint>;
}

// ── Provider adapter: ACP drives the pocket wallet through viem ───────────────

class PocketEvmProviderAdapter implements IEvmProviderAdapter {
  readonly providerName = "hoodpocket";
  constructor(private readonly sdk: AcpModule) {}

  async getAddress(): Promise<Address> {
    return account.address;
  }
  async getSupportedChainIds(): Promise<number[]> {
    return [CHAIN_ID];
  }
  async getNetworkContext(chainId: number): Promise<unknown> {
    return this.sdk.createEvmNetworkContext(chainId);
  }
  async sendTransaction(_chainId: number, call: Call | Call[]): Promise<Address> {
    const one = Array.isArray(call) ? call[0] : call;
    return walletClient.sendTransaction({
      to: one.to ?? undefined,
      data: one.data,
      value: one.value ?? 0n,
    });
  }
  async sendCalls(_chainId: number, calls: Call[]): Promise<Address[]> {
    const hashes: Address[] = [];
    for (const c of calls) {
      const h = await walletClient.sendTransaction({
        to: c.to ?? undefined,
        data: c.data,
        value: c.value ?? 0n,
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      hashes.push(h);
    }
    return hashes;
  }
  async getTransactionReceipt(_chainId: number, hash: Address): Promise<unknown> {
    return publicClient.waitForTransactionReceipt({ hash });
  }
  async readContract(_chainId: number, params: unknown): Promise<unknown> {
    return publicClient.readContract(params as Parameters<typeof publicClient.readContract>[0]);
  }
  async getLogs(_chainId: number, params: unknown): Promise<unknown[]> {
    return publicClient.getLogs(params as Parameters<typeof publicClient.getLogs>[0]);
  }
  async getBlockNumber(_chainId: number): Promise<bigint> {
    return publicClient.getBlockNumber();
  }
  async signMessage(_chainId: number, message: string): Promise<string> {
    return account.signMessage({ message });
  }
  async signTypedData(_chainId: number, typedData: unknown): Promise<string> {
    return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
  }
}

// ── Lazy SDK loader ───────────────────────────────────────────────────────────

let agentPromise: Promise<AcpAgentInstance> | null = null;

async function loadAcpAgent(): Promise<AcpAgentInstance> {
  if (agentPromise) return agentPromise;
  agentPromise = (async () => {
    let sdk: AcpModule;
    try {
      // Dynamic, optional: keeps the heavy beta SDK out of the default install.
      // Non-literal specifier so the compiler treats it as an external module
      // the wallet does not depend on at build time.
      const pkg = "@virtuals-protocol/acp-node-v2";
      sdk = (await import(pkg)) as unknown as AcpModule;
    } catch {
      throw new Error(
        "ACP support needs the Virtuals SDK. Install it once: npm i -g @virtuals-protocol/acp-node-v2"
      );
    }
    const provider = new PocketEvmProviderAdapter(sdk);
    return sdk.AcpAgent.create({ provider });
  })();
  return agentPromise;
}

// ── Public surface used by the MCP tools ──────────────────────────────────────

export async function browseAcpAgents(keyword: string, topK = 10): Promise<AcpAgentDetail[]> {
  const agent = await loadAcpAgent();
  return agent.browseAgents(keyword, { topK });
}

export interface HireResult {
  jobId: string;
  provider: string;
  offering: string;
  priceUsd: number;
}

/**
 * Hire an agent for one of its offerings. The caller runs the guardrails
 * against the offering price first; this creates and funds the job on-chain.
 */
export async function hireAcpAgent(
  providerAddress: string,
  offeringName: string,
  requirement: Record<string, unknown> | string
): Promise<HireResult> {
  const agent = await loadAcpAgent();
  const provider = await agent.getAgentByWalletAddress(providerAddress);
  if (!provider) throw new Error(`No ACP agent found at ${providerAddress}.`);
  const offering = provider.offerings.find((o) => o.name === offeringName);
  if (!offering) {
    const names = provider.offerings.map((o) => o.name).join(", ") || "none";
    throw new Error(`${provider.name} has no offering "${offeringName}". Available: ${names}.`);
  }
  const jobId = await agent.createJobFromOffering(
    CHAIN_ID,
    offering,
    providerAddress,
    requirement
  );
  return {
    jobId: jobId.toString(),
    provider: provider.name,
    offering: offering.name,
    priceUsd: offering.priceValue,
  };
}
