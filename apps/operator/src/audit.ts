/**
 * Auditor export: every eERC movement on the deployment — deposits, private transfers, withdrawals — with amounts.
 *
 * eERC's own `auditorDecrypt` only scans the last 1000 blocks, so the operator keeps its own index: a cursor plus one row
 * per event, persisted under .data. Rows store the auditor ciphertext (PCT), never plaintext: amounts are decrypted with
 * the auditor key at export time, so the index on disk reveals nothing an observer couldn't read from the chain.
 * A transfer's asset (tokenId) is only in calldata, so each transfer costs one transaction read.
 */
import { type HushContracts, type EercAccount, MAX_LOG_RANGE, encryptedErcAbi, getLogsChunked, readEercTransfer } from "@hush/x402";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Address, type Hex, type PublicClient, erc20Abi, formatUnits, isAddressEqual } from "viem";

export interface AuditRow {
  block: string;
  logIndex: number;
  txHash: Hex;
  kind: "deposit" | "transfer" | "withdraw";
  from: Address | null;
  to: Address | null;
  tokenId: string;
  /** Deposits: the public ERC-20 amount that was converted (token decimals). */
  publicAmount?: string;
  /** Withdrawals: the public eERC amount (eERC decimals). */
  publicUnits?: string;
  /** Transfers and withdrawals: the amount encrypted to the auditor key in force at the time. */
  auditorPct?: string[];
  auditor?: Address;
}

interface IndexFile {
  cursor: string;
  rows: AuditRow[];
  times: Record<string, number>;
}

export interface AuditEntry {
  timeUtc: string;
  block: string;
  txHash: Hex;
  kind: AuditRow["kind"];
  asset: string;
  from: string;
  to: string;
  amount: string | null;
  amountSource: string;
}

// The cursor is checkpointed every WINDOW_RANGES getLogs ranges, so a long first scan (Fuji's public RPC: 100 blocks
// per request, ~8 700 requests since deployment) resumes where it stopped.
const WINDOW_RANGES = 50n;

export class AuditIndex {
  private data: IndexFile;
  private scanning?: Promise<void>;
  private assets = new Map<string, Promise<{ symbol: string; decimals: number }>>();

  constructor(
    private readonly opts: {
      file: string;
      publicClient: PublicClient;
      contracts: HushContracts;
      /** Client for the getLogs scan (default: publicClient) and the widest span it accepts (default 100 blocks). */
      logsClient?: PublicClient;
      maxRange?: bigint;
      log: (...a: unknown[]) => void;
    },
  ) {
    this.data = existsSync(opts.file)
      ? (JSON.parse(readFileSync(opts.file, "utf8")) as IndexFile)
      : { cursor: String(opts.contracts.startBlock), rows: [], times: {} };
  }

  get scannedTo() {
    return BigInt(this.data.cursor) - 1n;
  }

  /** Catch up to the chain head (one scan at a time; concurrent callers share it). */
  sync(): Promise<void> {
    this.scanning ??= this.scan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async scan() {
    const { publicClient: pc, contracts } = this.opts;
    const latest = await pc.getBlockNumber();
    const maxRange = this.opts.maxRange ?? MAX_LOG_RANGE;
    const window = maxRange * WINDOW_RANGES;
    let from = BigInt(this.data.cursor);
    const started = from;
    while (from <= latest) {
      const to = from + window - 1n > latest ? latest : from + window - 1n;
      const scanner = this.opts.logsClient ?? pc;
      const logs = await getLogsChunked(from, to, (range) => scanner.getContractEvents({ address: contracts.encryptedErc, abi: encryptedErcAbi, ...range }), { maxRange });
      for (const log of logs) {
        const base = { block: log.blockNumber.toString(), logIndex: log.logIndex, txHash: log.transactionHash };
        const a = log.args as Record<string, unknown>;
        let row: AuditRow | undefined;
        if (log.eventName === "Deposit") {
          const amount = (a.amount as bigint) - (a.dust as bigint);
          row = { ...base, kind: "deposit", from: a.user as Address, to: a.user as Address, tokenId: String(a.tokenId), publicAmount: amount.toString() };
        } else if (log.eventName === "Withdraw") {
          row = { ...base, kind: "withdraw", from: a.user as Address, to: a.user as Address, tokenId: String(a.tokenId), publicUnits: String(a.amount), auditorPct: (a.auditorPCT as bigint[]).map(String), auditor: a.auditorAddress as Address };
        } else if (log.eventName === "PrivateTransfer") {
          const t = await readEercTransfer(pc, contracts, log.transactionHash);
          row = { ...base, kind: "transfer", from: a.from as Address, to: a.to as Address, tokenId: t.tokenId.toString(), auditorPct: (a.auditorPCT as bigint[]).map(String), auditor: a.auditorAddress as Address };
        }
        if (!row) continue;
        if (this.data.times[row.block] === undefined) this.data.times[row.block] = Number((await pc.getBlock({ blockNumber: log.blockNumber })).timestamp);
        if (!this.data.rows.some((r) => r.txHash === row!.txHash && r.logIndex === row!.logIndex)) this.data.rows.push(row);
      }
      from = to + 1n;
      this.data.cursor = from.toString();
      if (to < latest) this.save(); // checkpoint long first scans
    }
    this.save();
    if (from - started > window) this.opts.log(`audit index: scanned to block ${latest} (${this.data.rows.length} eERC events)`);
  }

  private save() {
    mkdirSync(path.dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify(this.data));
  }

  private asset(tokenId: string) {
    let a = this.assets.get(tokenId);
    if (!a) {
      a = (async () => {
        const { publicClient: pc, contracts } = this.opts;
        const token = (await pc.readContract({ address: contracts.encryptedErc, abi: encryptedErcAbi, functionName: "tokenAddresses", args: [BigInt(tokenId)] })) as Address;
        const decimals = await pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
        if (isAddressEqual(token, contracts.usdc)) return { symbol: "hUSDC", decimals };
        const stock = Object.entries(contracts.stocks ?? {}).find(([, addr]) => addr && isAddressEqual(addr, token));
        return { symbol: stock ? `h${stock[0]}` : `token#${tokenId} ${token}`, decimals };
      })();
      this.assets.set(tokenId, a);
    }
    return a;
  }

  /** Every indexed event, amounts decrypted with `auditor` (rows sealed to another auditor key stay null). */
  async entries(auditor: EercAccount): Promise<AuditEntry[]> {
    await this.sync();
    const eercDecimals = this.opts.contracts.eercDecimals;
    const rows = [...this.data.rows].sort((a, b) => Number(BigInt(a.block) - BigInt(b.block)) || a.logIndex - b.logIndex);
    const out: AuditEntry[] = [];
    for (const r of rows) {
      const asset = await this.asset(r.tokenId);
      let amount: string | null = null;
      let amountSource: string;
      if (r.kind === "deposit") {
        amount = formatUnits(BigInt(r.publicAmount!), asset.decimals);
        amountSource = "public (deposit calldata)";
      } else if (r.auditor && isAddressEqual(r.auditor, auditor.address)) {
        amount = formatUnits(auditor.decryptPCT(r.auditorPct!.map(BigInt)), eercDecimals);
        amountSource = r.kind === "withdraw" ? "public + auditor key (match)" : "auditor key";
        if (r.kind === "withdraw" && formatUnits(BigInt(r.publicUnits!), eercDecimals) !== amount) amountSource = "auditor key (≠ public amount!)";
      } else {
        if (r.kind === "withdraw") amount = formatUnits(BigInt(r.publicUnits!), eercDecimals);
        amountSource = r.kind === "withdraw" ? "public (withdraw)" : `sealed to another auditor key (${r.auditor ?? "none"})`;
      }
      out.push({
        timeUtc: new Date((this.data.times[r.block] ?? 0) * 1000).toISOString(),
        block: r.block,
        txHash: r.txHash,
        kind: r.kind,
        asset: asset.symbol,
        from: r.from ?? "",
        to: r.to ?? "",
        amount,
        amountSource,
      });
    }
    return out;
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(entries: AuditEntry[], names: Map<string, string>, txUrl: (h: string) => string): string {
  const header = ["time_utc", "block", "kind", "asset", "amount", "from", "from_name", "to", "to_name", "amount_source", "tx_hash", "explorer"];
  const name = (a: string) => names.get(a.toLowerCase()) ?? "";
  const lines = entries.map((e) =>
    [e.timeUtc, e.block, e.kind, e.asset, e.amount, e.from, name(e.from), e.to, name(e.to), e.amountSource, e.txHash, txUrl(e.txHash)].map(csvCell).join(","),
  );
  return `${[header.join(","), ...lines].join("\n")}\n`;
}
