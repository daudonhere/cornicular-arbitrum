# Cornicular Registry (Arbitrum)

Smart contract for Cornicular file integrity on the Arbitrum blockchain.

## Contract

`CornicularRegistry.sol` registers file hashes on-chain and provides a tamper-proof verification source of truth.

### Roles (AccessControl)

| Role | Powers |
|------|--------|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles, revoke/remove any certificate |
| `ISSUER_ROLE` | Register files, revoke/replace/remove own certificates |
| `PAUSER_ROLE` | Emergency pause/unpause |

### File flow

1. Backend computes `fileHash` (SHA-256 of file) + `metadataHash` (SHA-256 of metadata JSON).
2. Issuer calls `register(fileHash, metadataHash, owner)` -> on-chain `certificateId`. Issuer = caller, owner = the account that owns the file.
3. Public can `verify(fileHash)` -> certificate + status.
4. `revoke` / `replace` / `remove` update status. Status enum: `ACTIVE`, `REPLACED`, `REVOKED`, `REMOVED`.

EIP-712 gasless registration via `registerWithSignature(RegisterRequest, signature)` is also supported. The signed request carries `owner`, so issuer signs off-chain while the file is owned by the given account.

## Networks

| Network | Chain ID | RPC (default) | Explorer |
|---------|----------|---------------|----------|
| Arbitrum mainnet | 42161 | https://arb1.arbitrum.io/rpc | https://arbiscan.io |
| Arbitrum Sepolia | 421614 | https://sepolia-rollup.arbitrum.io/rpc | https://sepolia.arbiscan.io |

## Setup

```bash
cp .env.example .env
# fill PRIVATE_KEY, CONTRACT_ADMIN_ADDRESS, CONTRACT_ISSUER_ADDRESS
npm install
npx hardhat compile
npx hardhat test
```

## Deploy

```bash
npx hardhat run scripts/deploy.ts --network arbitrumSepolia
npx hardhat run scripts/deploy.ts --network arbitrum
```

Verify on Arbiscan:

```bash
npx hardhat verify --network arbitrumSepolia <CONTRACT_ADDRESS> <ADMIN> <ISSUER>
```

Deployer defaults to admin + issuer if `CONTRACT_ADMIN_ADDRESS` / `CONTRACT_ISSUER_ADDRESS` are empty. After deploy, update the backend env with the contract address.

## Backend integration

The backend uses viem to call this contract. Required env (all optional, backend falls back to simulated on-chain):

- `CHAIN_RPC_ARBITRUM` / `CHAIN_RPC_TESTNET` (defaults: `https://arb1.arbitrum.io/rpc` / `https://sepolia-rollup.arbitrum.io/rpc`)
- `CHAIN_CONTRACT_ARBITRUM` / `CHAIN_CONTRACT_TESTNET` (the deployed contract addresses)
- `CHAIN_SIGNER_PRIVATE_KEY` (the deployer or a funded issuer key)
