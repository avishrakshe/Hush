# @hush/contracts

Solidity side of Hush: the eERC converter stack (vendored from
[`ava-labs/EncryptedERC@8dc98cd`](https://github.com/ava-labs/EncryptedERC), Ecosystem License — see
`contracts/eerc/LICENSE-eERC.md`), a testnet USDC with EIP-3009, and the two Hush contracts.

| Contract | Purpose |
|---|---|
| `eerc/EncryptedERC` (converter mode, 2 decimals) + `Registrar` + prod Groth16 verifiers | Encrypted hUSDC balances and private transfers |
| `token/MockUSDC` | 6-dp USDC stand-in: open faucet, EIP-2612, EIP-3009 (needed by x402 `exact`) |
| `hush/HushRegistry` | Providers (eERC key cross-checked), agents (EIP-712 consent), owner kill switch, provider flags |
| `hush/HushLedger` | Voucher-batch Merkle roots only (no counts/amounts) + EIP-712 domain/hash helpers for vouchers & receipts |

`circuits/` holds the prebuilt registration/transfer/withdraw circuits. They match the **prod** verifiers
(same trusted setup), which is why SDK-generated proofs verify on-chain.

## Commands (run from the repo root)

```bash
pnpm keys            # create .env with a fresh key per role (prints addresses only)
pnpm test:contracts  # 27 unit tests

# offline dry run (terminal 1: pnpm node)
pnpm fund:local && pnpm deploy:local && pnpm prove:local

# Fuji (fund the DEPLOYER from the faucet first)
pnpm deploy:fuji && pnpm fund:fuji && pnpm prove:fuji
pnpm verify:fuji     # Snowtrace verification via Routescan
```

`prove:*` runs the P2 end-to-end flow with the official `@avalabs/eerc-sdk`: register → set auditor → deposit →
owner→agent private transfer → agent→provider top-up with encrypted metadata → receiver/provider/auditor each
decrypt what they are entitled to see. Measured locally: registration proof ≈ 0.8 s, transfer proof ≈ 5 s (Node).

## Design notes
- **Agent consent** — `registerAgent` needs the agent's EIP-712 signature; otherwise anyone could claim an agent and
  freeze it (facilitators refuse frozen agents).
- **Provider key check** — `registerProvider` requires the advertised BabyJubJub key to equal the one in the eERC
  Registrar, so agents never top up a key nobody can decrypt with.
- **Ledger stores roots only** — counts/amounts would leak call frequency. Facilitators commit on a fixed cadence and
  pad empty batches, so commit timing is uninformative too.
- **Leaves** use OZ `StandardMerkleTree` double hashing over
  `[address,address,uint256,uint64,bytes32,uint64,bytes]` (voucher fields + signature). Prefer
  `verifyVoucherInclusion`, which derives the leaf on-chain.
- **Vouchers/receipts** are EIP-712 with `verifyingContract = HushLedger`, so signatures can't be replayed across
  deployments or chains.
