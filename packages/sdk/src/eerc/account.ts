// The SDK's package.json "main" points to a dist/index.cjs that isn't published; the ESM build is the real entry.
import { EERC } from "@avalabs/eerc-sdk/dist/index.js";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  erc20Abi,
  isAddressEqual,
  parseEventLogs,
} from "viem";
import { encryptedErcAbi, registrarAbi } from "../generated/abis.js";
import type { HushContracts } from "../types.js";
import { type EercTransfer, auditorPct, readEercTransfer, receiverPct } from "./calldata.js";

/** Groth16 artifacts. In Node pass file paths; in the browser pass URLs. mint/burn are unused in converter mode. */
export interface CircuitURLs {
  register: { wasm: string; zkey: string };
  transfer: { wasm: string; zkey: string };
  withdraw: { wasm: string; zkey: string };
  mint: { wasm: string; zkey: string };
  burn: { wasm: string; zkey: string };
}

export interface EercAccountOptions {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  contracts: HushContracts;
  circuits: CircuitURLs;
  /**
   * Previously derived key (hex). Omit to derive it from a wallet signature over the eERC registration message —
   * deterministic, so the wallet itself is the backup. Losing both wallet and key = losing the encrypted balance.
   */
  decryptionKey?: string;
}

export interface EncryptedBalance {
  /** ElGamal ciphertext [c1.x, c1.y, c2.x, c2.y] — all anyone else can see. */
  encrypted: bigint[];
  /** Plaintext balance in eERC units, decrypted locally with this account's key. */
  decrypted: bigint;
  /** Unspent incoming transfers; eERC reverts new incoming transfers at 300 until the account spends. */
  pendingIncoming: number;
}

type RawBalance = readonly [
  { c1: { x: bigint; y: bigint }; c2: { x: bigint; y: bigint } },
  bigint,
  readonly { pct: readonly bigint[]; index: bigint }[],
  readonly bigint[],
  bigint,
];

/**
 * One wallet's view of the eERC converter: register, deposit, private transfers, and local decryption.
 * Wraps the official `@avalabs/eerc-sdk` EERC class.
 */
export class EercAccount {
  readonly address: Address;
  readonly contracts: HushContracts;
  /** Underlying official SDK instance (escape hatch). */
  readonly eerc: EERC;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private key: string | undefined;
  /**
   * Outgoing eERC operations must be sequential: each proof commits to the current encrypted balance, and the
   * contract rejects a proof whose balance was already spent by a concurrent transaction.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: EercAccountOptions) {
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.contracts = opts.contracts;
    this.address = opts.walletClient.account.address;
    this.key = opts.decryptionKey;
    // Converter mode (isConverter = true): hUSDC wraps an existing ERC-20.
    this.eerc = new EERC(
      opts.publicClient as never,
      opts.walletClient as never,
      opts.contracts.encryptedErc,
      opts.contracts.registrar,
      true,
      opts.circuits,
      opts.decryptionKey,
    );
  }

  /** Derives the decryption key (one wallet signature) unless one was supplied. Idempotent. */
  async init(): Promise<this> {
    if (!this.key) this.key = await this.eerc.generateDecryptionKey();
    return this;
  }

  /** The eERC decryption key, for owner-encrypted backups. Treat like a private key. */
  exportDecryptionKey(): string {
    if (!this.key) throw new Error("call init() first");
    return this.key;
  }

  get publicKey(): bigint[] {
    return this.eerc.publicKey;
  }

  async isRegistered(address: Address = this.address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.contracts.registrar,
      abi: registrarAbi,
      functionName: "isUserRegistered",
      args: [address],
    });
  }

  /** Registers this wallet's eERC key (Groth16 registration proof). Returns null if already registered. */
  async register(): Promise<Hex | null> {
    if (await this.isRegistered()) {
      await this.init();
      return null;
    }
    const { key, transactionHash } = await this.eerc.register();
    this.key = key;
    await this.waitOk(transactionHash as Hex, "eERC registration");
    return transactionHash as Hex;
  }

  async auditorPublicKey(): Promise<bigint[]> {
    const [x, y] = await this.publicClient.readContract({
      address: this.contracts.encryptedErc,
      abi: encryptedErcAbi,
      functionName: "auditorPublicKey",
    });
    if (x === 0n && y === 0n) throw new Error("eERC auditor is not set — no private transfers are possible yet");
    return [x, y];
  }

  /**
   * Reads the on-chain ciphertext and decrypts it locally. `token` = which wrapped ERC-20 (default USDC); the
   * converter keeps a separate encrypted balance per token.
   */
  async balance(address: Address = this.address, token: Address = this.contracts.usdc): Promise<EncryptedBalance> {
    await this.init();
    const [eGCT, , amountPCTs, balancePCT] = (await this.publicClient.readContract({
      address: this.contracts.encryptedErc,
      abi: encryptedErcAbi,
      functionName: "getBalanceFromTokenAddress",
      args: [address, token],
    })) as unknown as RawBalance;
    const decrypted = this.eerc.calculateTotalBalance(
      eGCT,
      amountPCTs.map((p) => ({ index: p.index, pct: [...p.pct] })),
      [...balancePCT],
    );
    if (decrypted < 0n) throw new Error("balance PCTs are out of sync with the ElGamal ciphertext");
    return { encrypted: [eGCT.c1.x, eGCT.c1.y, eGCT.c2.x, eGCT.c2.y], decrypted, pendingIncoming: amountPCTs.length };
  }

  /**
   * ERC-20 → encrypted balance. `atomic` is in the token's own units (USDC 6 dp by default; 18 dp for mock stocks,
   * where the converter keeps 0.01-share precision and returns the dust). Amount and token are public.
   */
  deposit(atomic: bigint, memo?: string, token: Address = this.contracts.usdc): Promise<Hex> {
    return this.serialize(async () => {
      await this.init();
      const allowance = await this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.address, this.contracts.encryptedErc],
      });
      if (allowance < atomic) {
        const approveHash = await this.walletClient.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.contracts.encryptedErc, atomic],
        });
        await this.waitOk(approveHash, "approve");
      }
      // The SDK reads the token's decimals() and scales the amount PCT to the eERC's 2 decimals itself.
      const { transactionHash } = await this.eerc.deposit(atomic, token, BigInt(this.contracts.eercDecimals), memo);
      await this.waitOk(transactionHash, "eERC deposit");
      return transactionHash;
    });
  }

  /**
   * Private transfer of `units` eERC units (0.01 hUSDC — or 0.01 share of a stock — each with 2 decimals). Generates
   * a Groth16 transfer proof client-side (~5 s in Node). `memo` is sent as eERC encrypted metadata, readable only by
   * the receiver. The amount is hidden; `to` and the token (tokenId in calldata) are public.
   */
  transfer(to: Address, units: bigint, memo?: string, token: Address = this.contracts.usdc): Promise<{ txHash: Hex; blockNumber: bigint }> {
    return this.serialize(async () => {
      const bal = await this.balance(this.address, token);
      if (bal.decrypted < units) throw new Error(`insufficient private balance: have ${bal.decrypted}, need ${units} eERC units`);
      const auditorPK = await this.auditorPublicKey();
      const { transactionHash } = await this.eerc.transfer(to, units, bal.encrypted, bal.decrypted, auditorPK, token, memo);
      const receipt = await this.waitOk(transactionHash, "eERC private transfer");
      return { txHash: transactionHash, blockNumber: receipt.blockNumber };
    });
  }

  /** Encrypted balance → ERC-20 (public amount). */
  withdraw(units: bigint, token: Address = this.contracts.usdc): Promise<Hex> {
    return this.serialize(async () => {
      const bal = await this.balance(this.address, token);
      const auditorPK = await this.auditorPublicKey();
      const { transactionHash } = await this.eerc.withdraw(units, bal.encrypted, bal.decrypted, auditorPK, token);
      await this.waitOk(transactionHash, "eERC withdraw");
      return transactionHash;
    });
  }

  decryptPCT(pct: readonly bigint[]): bigint {
    if (!this.key) throw new Error("call init() first");
    return this.eerc.decryptPCT([...pct]);
  }

  /**
   * Poseidon-ECDH-encrypt one field element to any BabyJubJub public key — the same PCT construction eERC uses for
   * encrypted amounts, so `decryptPCT` on the recipient's account opens it. Needs no key of our own.
   */
  async encryptPCT(value: bigint, publicKey: readonly bigint[]): Promise<bigint[]> {
    const [x, y] = publicKey;
    if (x === undefined || y === undefined) throw new Error("publicKey must be [x, y]");
    const { cipher, authKey, nonce } = await this.eerc.poseidon.processPoseidonEncryption({ inputs: [value], publicKey: [x, y] });
    return [...cipher, ...authKey, nonce];
  }

  /** Registered eERC public key of any address ([0n, 0n] when unregistered). */
  async publicKeyOf(address: Address): Promise<bigint[]> {
    const pk = await this.publicClient.readContract({
      address: this.contracts.registrar,
      abi: registrarAbi,
      functionName: "getUserPublicKey",
      args: [address],
    });
    return [...pk];
  }

  /**
   * This account's private transfers, decrypted locally: outgoing via the official SDK (historical balance diff),
   * incoming from calldata. Scans PrivateTransfer logs from the eERC deployment block in `chunk`-sized ranges.
   */
  async history(opts: { fromBlock?: bigint; chunk?: bigint } = {}): Promise<
    { txHash: Hex; blockNumber: bigint; direction: "in" | "out"; counterparty: Address; units?: bigint; memo?: string; error?: string }[]
  > {
    await this.init();
    const latest = await this.publicClient.getBlockNumber();
    const chunk = opts.chunk ?? 2_000n;
    const out: Awaited<ReturnType<EercAccount["history"]>> = [];
    for (let from = opts.fromBlock ?? BigInt(this.contracts.startBlock); from <= latest; from += chunk) {
      const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
      const [sent, received] = await Promise.all(
        [{ from: this.address }, { to: this.address }].map((args) =>
          this.publicClient.getContractEvents({
            address: this.contracts.encryptedErc,
            abi: encryptedErcAbi,
            eventName: "PrivateTransfer",
            args,
            fromBlock: from,
            toBlock: to,
          }),
        ),
      );
      for (const log of sent ?? []) {
        const { to: counterparty } = log.args as { to: Address };
        const base = { txHash: log.transactionHash, blockNumber: log.blockNumber, direction: "out" as const, counterparty };
        try {
          out.push({ ...base, units: await this.decryptOutgoing(log.transactionHash) });
        } catch (err) {
          out.push({ ...base, error: (err as Error).message });
        }
      }
      for (const log of received ?? []) {
        const { from: counterparty } = log.args as { from: Address };
        if (isAddressEqual(counterparty, this.address)) continue; // self-transfer already listed as outgoing
        const base = { txHash: log.transactionHash, blockNumber: log.blockNumber, direction: "in" as const, counterparty };
        try {
          const { units, memo } = await this.decryptIncoming(log.transactionHash);
          out.push({ ...base, units, memo });
        } catch (err) {
          out.push({ ...base, error: (err as Error).message });
        }
      }
    }
    return out.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  }

  readTransfer(txHash: Hex): Promise<EercTransfer> {
    return readEercTransfer(this.publicClient, this.contracts, txHash);
  }

  /**
   * Receiver side: decrypt an incoming transfer's amount straight from calldata (the circuit-constrained receiver
   * PCT) — no archive node, no discrete log. Also decrypts the encrypted memo when present.
   */
  async decryptIncoming(txHash: Hex): Promise<{ transfer: EercTransfer; units: bigint; memo?: string }> {
    await this.init();
    const transfer = await this.readTransfer(txHash);
    if (!isAddressEqual(transfer.to, this.address)) throw new Error(`${txHash} was not sent to ${this.address}`);
    const units = this.decryptPCT(receiverPct(transfer));
    return { transfer, units, memo: await this.decryptMemo(transfer) };
  }

  /** Sender side (owner reveal): the official SDK diff of historical balances around the transaction. */
  async decryptOutgoing(txHash: Hex, token: Address = this.contracts.usdc): Promise<bigint> {
    await this.init();
    const [event] = await this.eerc.decryptTransaction(txHash, token);
    if (!event?.decryptedAmount) throw new Error(event?.decryptError ?? `could not decrypt ${txHash}`);
    return BigInt(event.decryptedAmount);
  }

  /** Auditor side: decrypt the auditor PCT of any private transfer (this account must be the auditor). */
  async auditorDecrypt(txHash: Hex): Promise<{ from: Address; to: Address; units: bigint }> {
    await this.init();
    const transfer = await this.readTransfer(txHash);
    return { from: transfer.from, to: transfer.to, units: this.decryptPCT(auditorPct(transfer)) };
  }

  /**
   * eERC metadata decryption via the official SDK. Its decryptMessage reads the first PrivateMessage in the block,
   * so we only trust the result when it matches this transaction's sender and receiver.
   */
  private async decryptMemo(transfer: EercTransfer): Promise<string | undefined> {
    const messages = parseEventLogs({ abi: encryptedErcAbi, eventName: "PrivateMessage", logs: [...transfer.logs] });
    if (messages.length === 0) return undefined;
    try {
      const m = await this.eerc.decryptMessage(transfer.txHash);
      if (isAddressEqual(m.messageFrom, transfer.from) && isAddressEqual(m.messageTo, this.address)) return m.decryptedMessage;
    } catch {
      // not decryptable by this key
    }
    return undefined;
  }

  private async waitOk(hash: Hex, label: string) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return receipt;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
