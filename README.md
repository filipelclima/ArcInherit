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

| Network | Address |
|---|---|
| Arc Testnet | `0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818` |

[View on Blockscout](https://testnet.arcscan.app/address/0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818)

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

## Development

Requires Node.js and npm.

```bash
npm install
npm run compile   # compile the contracts
npm test          # run the Hardhat test suite
```

The tests live in `test/`. They use `contracts/mocks/MockERC20.sol` and `contracts/mocks/BlockableERC20.sol` (a token that can block chosen addresses, like USDC's blocklist). They also use `time.increase()` to fast-forward through the timelock and grace period.

### Deploying

The contract has no constructor arguments and no admin, so anyone can deploy their own copy. This repo doesn't include a deploy script yet. One way to deploy is with Hardhat Ignition, which is already installed through `@nomicfoundation/hardhat-toolbox`:

1. Add Arc Testnet to `hardhat.config.ts`, reading the deployer key from an environment variable (never commit it):

   ```ts
   networks: {
     arcTestnet: {
       url: "https://rpc.testnet.arc.io",
       chainId: 5042002,
       accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
     },
   },
   ```

2. Create `ignition/modules/ArcInherit.ts`:

   ```ts
   import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

   export default buildModule("ArcInheritModule", (m) => {
     const arcInherit = m.contract("ArcInherit");
     return { arcInherit };
   });
   ```

3. Fund the deployer with testnet USDC (Arc's gas token) and deploy:

   ```bash
   npx hardhat ignition deploy ignition/modules/ArcInherit.ts --network arcTestnet
   ```

## Integrate it in your app

Here is a minimal [viem](https://viem.sh) example against the Arc Testnet deployment. It reads a vault and lets a heir claim. The ABI below covers only the functions used here.

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
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
});

const HEIRLOOM: Address = "0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818";

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

The `FINDING:` tests in `test/ArcInherit.extended.test.ts` document how the contract behaves today. The contract is immutable, so fixing any of these means deploying a new contract.

- **The owner keeps full control after the deadline.** Once the timelock and grace period have passed and `canClaim()` is true, the owner can still `withdraw`, `updateHeirs` and `cancelVault`. That stays true even after some heirs have claimed, so the owner can take the share of a heir who hasn't claimed yet. Anyone holding the owner's key can do the same.
- **Later claimers get less than their percentage.** With 2 or more heirs, each heir gets their percentage of the balance *remaining* in the vault when they claim, not of the original deposit. Example: with a 40/60 split of 1000, the first heir gets 400 and the second gets 60% of 600, which is 360 instead of 600. The leftover (240 here) can only be withdrawn by the owner.
- **Duplicate heirs are paid once.** The same wallet can be listed twice (for example 30% + 70%). `claimInheritance` pays only the first matching entry's percentage, and the rest of that wallet's share can never be claimed.
- **No zero-address check.** `createVault` and `updateHeirs` accept `0x0000…0000` as a heir wallet. No one can claim that share, so it stays locked in the vault unless the owner withdraws it.
- **Blocklisted transfers revert and stay retryable.** If the token refuses the transfer (for example a USDC-blocklisted heir), `claimInheritance` reverts with the token's own error, not `TransferFailed`. The claim is not marked as done, so the heir can retry once unblocked, and other heirs can still claim normally in the meantime.

## Built on Arc

- **Chain:** Arc Testnet (Chain ID: 5042002)
- **Language:** Solidity (`pragma ^0.8.20`). Compiled and tested with 0.8.24 (`hardhat.config.ts`). The Arc Testnet deployment above was compiled with 0.8.34.
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
