# ArcInherit

Decentralized inheritance vault for ERC-20 tokens on Arc Network.

## What it does

ArcInherit lets you designate heirs for your onchain assets. If you stop checking in (proof of life), your heirs can claim their share after a timelock + grace period expires.

- **Non-custodial** — no company, no Arc, no Circle has access to your vault
- **Immutable** — contract cannot be upgraded or paused by anyone
- **Any ERC-20** — USDC, EURC, or any token on Arc
- **Multiple heirs** — set percentage splits (must sum to 100%)
- **Timelock + grace period** — both chosen by the vault owner

## Deployed contract

| Network | Address |
|---|---|
| Arc Testnet | `0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818` |

[View on Blockscout](https://testnet.arcscan.app/address/0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818)

## How it works

1. **Owner creates a vault** — sets timelock duration, grace period, and heirs with percentages
2. **Owner deposits tokens** — any ERC-20 on Arc
3. **Owner checks in periodically** — a simple onchain transaction that resets the countdown
4. **If owner stops checking in** — after timelock + grace period, heirs can claim their share
5. **Owner can cancel anytime** — all tokens returned, vault closed

## Contract functions

### Owner
- `createVault(timelockDuration, gracePeriod, heirs[])` — create vault (min 30 days timelock, min 7 days grace)
- `deposit(token, amount)` — deposit ERC-20 tokens
- `withdraw(token, amount)` — withdraw tokens while alive
- `checkIn()` — proof of life, resets the countdown
- `updateHeirs(heirs[])` — change heirs and percentages
- `cancelVault()` — cancel and recover all tokens

### Heirs
- `claimInheritance(owner, token)` — claim share after timelock + grace period

### View
- `canClaim(owner)` — returns true if heirs can claim now
- `timeUntilClaim(owner)` — seconds remaining until claim is possible
- `getVault(owner)` — vault details
- `getBalances(owner)` — all token balances

## Built on Arc

- **Chain:** Arc Testnet (Chain ID: 5042002)
- **Language:** Solidity 0.8.34
- **License:** MIT
