# Heirloom

*Formerly ArcInherit.*

Decentralized inheritance vault for ERC-20 tokens on Arc Network.

> **Testnet only, not audited.** Heirloom is deployed only on Arc Testnet and has not had a
> security audit. Do not use it to hold real funds. See [Known limits](#known-limits).

- **Live app:** https://arcinherit.com
- **Frontend repo:** https://github.com/filipelclima/arcinherit-app
- **Contract repo:** https://github.com/filipelclima/ArcInherit (this repo)

## What it does

Heirloom lets you name heirs for your onchain assets. If you stop checking in (proof of life), your heirs can claim their share once a timelock and a grace period have both passed.

- **Non-custodial:** no company, not Arc, not Circle, has access to your vault
- **Immutable:** nobody can upgrade or pause the contract
- **Any ERC-20:** USDC, EURC, or any other token on Arc
- **Multiple heirs:** set percentage splits that add up to 100%
- **Timelock and grace period:** the vault owner picks both

The Solidity contract is still named `ArcInherit` (`contracts/ArcInherit.sol`). Only the product name changed.

## Deployed contract

| Version | Network | Address | Status |
|---|---|---|---|
| **v2** | Arc Testnet | [`0x31C6962393e002845a647bB22e21c6B219eF7F16`](https://explorer.testnet.arc.io/address/0x31C6962393e002845a647bB22e21c6B219eF7F16#code) | **Current**, source verified |
| v1 | Arc Testnet | [`0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818`](https://explorer.testnet.arc.io/address/0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818) | Legacy, has the claim-order and zero-address bugs listed in the [v2 changelog](#v2-changelog) |

Both contracts are immutable, so v1 keeps running. Vaults created on v1 stay on v1; they aren't moved to v2. New vaults should use v2.

## How it works

1. **The owner creates a vault.** They set the timelock duration, the grace period, and the heirs with their percentages.
2. **The owner deposits tokens.** Any ERC-20 on Arc works.
3. **The owner checks in from time to time.** A simple onchain transaction resets the countdown.
4. **If the owner stops checking in,** heirs can claim their share after the timelock and the grace period have passed.
5. **The owner can cancel at any time.** All tokens go back to the owner and the vault closes.

## Contract functions

### Owner
- `createVault(timelockDuration, gracePeriod, heirs[])`: create a vault (timelock at least 30 days, grace period at least 7 days)
- `deposit(token, amount)`: deposit ERC-20 tokens (approve the vault first)
- `withdraw(token, amount)`: withdraw tokens
- `checkIn()`: proof of life, resets the countdown
- `updateHeirs(heirs[])`: change heirs and percentages
- `cancelVault()`: cancel the vault and recover all tokens

### Heirs
- `claimInheritance(owner, token)`: claim your share after the timelock and grace period

### View
- `canClaim(owner)`: true if heirs can claim now
- `timeUntilClaim(owner)`: seconds left until a claim is possible
- `isTimelockExpired(owner)`: true once the timelock (without the grace period) has passed
- `getVault(owner)`: vault details
- `getBalances(owner)`: all token balances
- `hasClaimed(owner, heir, token)`: whether a heir has already claimed a token
- `claimSnapshot(owner, token)`: the balance every heir's share of `token` is computed from in the current claim round, or 0 before the round's first claim (v2 only)
- `claimRound(owner)`: the vault's current claim round, starting at 0 (v2 only)

In v2, `hasClaimed` refers to the current claim round. See the [v2 changelog](#v2-changelog).

## Development

Requires Node.js and npm.

```bash
npm install
npm run compile   # compile the contracts
npm test          # run the Hardhat test suite
```

The tests live in `test/`. They use `contracts/mocks/MockERC20.sol` and `contracts/mocks/BlockableERC20.sol` (a token that can block chosen addresses, like USDC's blocklist). They also use `time.increase()` to fast-forward through the timelock and grace period.

### Deploying

The contract has no constructor arguments and no admin, so anyone can deploy their own copy. The repo includes everything needed for Arc Testnet:

- **Network:** `arcTestnet` in `hardhat.config.ts` (RPC `https://rpc.testnet.arc.io`, chain ID 5042002). The deployer key is read from the `DEPLOYER_PRIVATE_KEY` environment variable. It is never stored in the repo, and `.env` is gitignored.
- **Deploy:** the Hardhat Ignition module `ignition/modules/ArcInherit.ts`.
- **Verify:** the Arc Testnet explorer ([explorer.testnet.arc.io](https://explorer.testnet.arc.io)) runs Blockscout, and `hardhat verify` is set up for it in `hardhat.config.ts`. No API key is needed.

Use a fresh wallet that holds only testnet USDC (Arc's gas token). In PowerShell, the key is set for the current session only:

```powershell
$env:DEPLOYER_PRIVATE_KEY = Read-Host "Deployer private key" -MaskInput
npx hardhat ignition deploy ignition/modules/ArcInherit.ts --network arcTestnet
npx hardhat verify --network arcTestnet <deployed address>
Remove-Item Env:DEPLOYER_PRIVATE_KEY
```

Ignition writes the deployment record to `ignition/deployments/chain-5042002/`, including the deployed address in `deployed_addresses.json`.

## Integrate it in your app

Here is a minimal [viem](https://viem.sh) example against the v2 deployment on Arc Testnet. It reads a vault and lets a heir claim. The ABI below covers only the functions used here.

```ts
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseAbi,
  type Address,
} from "viem";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
});

const HEIRLOOM: Address = "0x31C6962393e002845a647bB22e21c6B219eF7F16"; // v2

const abi = parseAbi([
  "struct Heir { address wallet; uint8 percentage; }",
  "struct TokenBalance { address token; uint256 amount; }",
  "function getVault(address owner) view returns (uint256 timelockDuration, uint256 gracePeriod, uint256 lastCheckIn, bool active, Heir[] heirs)",
  "function getBalances(address owner) view returns (TokenBalance[])",
  "function canClaim(address owner) view returns (bool)",
  "function claimInheritance(address owner, address token)",
]);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

export async function readVault(owner: Address) {
  const [timelockDuration, gracePeriod, lastCheckIn, active, heirs] =
    await publicClient.readContract({ address: HEIRLOOM, abi, functionName: "getVault", args: [owner] });
  const balances = await publicClient.readContract({
    address: HEIRLOOM, abi, functionName: "getBalances", args: [owner],
  });
  const claimable = await publicClient.readContract({
    address: HEIRLOOM, abi, functionName: "canClaim", args: [owner],
  });
  return { timelockDuration, gracePeriod, lastCheckIn, active, heirs, balances, claimable };
}

// Called by a heir from a browser wallet such as MetaMask.
export async function claim(owner: Address, token: Address) {
  const walletClient = createWalletClient({ chain: arcTestnet, transport: custom(window.ethereum!) });
  const [account] = await walletClient.requestAddresses();

  const { request } = await publicClient.simulateContract({
    account, address: HEIRLOOM, abi, functionName: "claimInheritance", args: [owner, token],
  });
  const hash = await walletClient.writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}
```

Notes:
- `canClaim` only checks the clock. It does not check whether the vault is still `active`, so check `active` from `getVault` too. A claim on a cancelled vault reverts with `VaultNotActive`.
- A heir claims each token separately, so call `claimInheritance` once for each `token` returned by `getBalances`.
- `simulateContract` surfaces the contract's custom errors (`TimelockNotExpired`, `GracePeriodNotExpired`, `NotAnHeir`, `AlreadyClaimed`, `ZeroAmount`, …) before the user signs.

## Known limits

> **Testnet only, not audited.**

These apply to the current v2 contract. The `FINDING:` tests in `test/ArcInherit.extended.test.ts` document them. The contract is immutable, so fixing any of these means deploying a new contract.

- **The owner keeps full control after the deadline.** Once the timelock and grace period have passed and `canClaim()` is true, the owner can still `withdraw`, `updateHeirs` and `cancelVault`. That stays true even after some heirs have claimed, so the owner can take the share of a heir who hasn't claimed yet. Anyone holding the owner's key can do the same.
- **Duplicate heirs are paid once.** The same wallet can be listed twice (for example 30% + 70%). `claimInheritance` pays only the first matching entry's percentage, and the rest of that wallet's share can never be claimed.
- **Blocklisted transfers revert and stay retryable.** If the token refuses the transfer (for example a USDC-blocklisted heir), `claimInheritance` reverts with the token's own error, not `TransferFailed`. The claim is not marked as done, so the heir can retry once unblocked, and other heirs can still claim normally in the meantime.
- **Deposits while claims are open aren't paid out in that round.** A deposit made after the round's snapshot is only distributed if the owner checks in, which starts a new round. Otherwise only the owner can withdraw it.
- **Rounding dust stays in the vault.** Shares round down, so a few wei can be left over, and only the owner can withdraw them.

## v2 changelog

v2 (`0x31C6962393e002845a647bB22e21c6B219eF7F16`) fixes two bugs that are still present in v1 (`0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818`):

- **Fixed: later claimers got less than their percentage.** In v1, with 2 or more heirs, each heir gets their percentage of the balance *remaining* in the vault when they claim, not of the original deposit. Example: with a 40/60 split of 1000, the first heir gets 400 and the second gets 60% of 600, which is 360 instead of 600. The leftover (240 here) can only be withdrawn by the owner.
  In v2, the first successful claim of a token takes a snapshot of the vault's balance of that token (`claimSnapshot(owner, token)`, event `ClaimSnapshotTaken`). Every heir is paid their percentage of that snapshot, whatever the claim order. If the owner withdraws or raises a heir's percentage after the snapshot, a claim pays at most what is left in the vault.
- **Fixed: zero-address heirs were accepted.** v1's `createVault` and `updateHeirs` accept `0x0000…0000` as a heir wallet, and no one can ever claim that share. In v2 both functions revert with `ZeroAddressHeir`.

v2 also adds **claim rounds** for false alarms. Snapshots and "already claimed" flags belong to a claim round (`claimRound(owner)`). Suppose heirs claim while the owner is presumed gone, and then the owner calls `checkIn()`. That check-in starts a new round (event `ClaimRoundStarted`) and closes claims again. Once the timelock and grace period pass again, every heir gets their percentage of the vault's balance at that point, including anything deposited in between, so nothing gets stuck. Heirs keep what they claimed in the earlier round. A check-in when nobody has claimed, or after a claim that reverted, doesn't start a new round.

Frontends need the v2 ABI for the new events (`ClaimSnapshotTaken`, `ClaimRoundStarted`), the new views (`claimSnapshot`, `claimRound`) and the new error (`ZeroAddressHeir`).

## Built on Arc

- **Chain:** Arc Testnet (Chain ID: 5042002)
- **Explorer:** [explorer.testnet.arc.io](https://explorer.testnet.arc.io)
- **Language:** Solidity (`pragma ^0.8.20`). v2 is compiled with 0.8.24 (`hardhat.config.ts`, also used for the tests). v1 was compiled with 0.8.34.
- **License:** [MIT](LICENSE)

## Future Roadmap

- **Circle Agent Stack for off-chain automation.** Circle shipped auto-update for the Circle Agent
  Stack CLI (`circle update`, requires v0.0.6+; `circle skill update --tool claude-code` for the
  latest Skills patterns, see the [docs](https://developers.circle.com/agent-stack)). Heirloom's
  contract is immutable by design (no admin functions, nothing to upgrade), so any integration here
  would live in an off-chain agent layer, not in the contract itself. Two directions worth
  exploring:
  - **Check-in reminders:** an agent watches `lastCheckIn` for each vault and notifies owners as
    their timelock deadline gets close, so they don't miss a check-in by accident.
  - **Claim automation:** an agent helps heirs submit `claimInheritance` once a vault becomes
    claimable, possibly combined with USDC-native payment and notification flows through Circle's
    stack.

  Not started. Noted here as a candidate for the frontend and tooling side of the project, not a
  contract change.
