# ArcInherit — Contrato

Vault de herança onchain para tokens ERC-20 na Arc Network. Owner deposita tokens e designa herdeiros com percentuais; se parar de fazer check-in (prova de vida), os herdeiros podem reivindicar sua parte após o timelock + grace period expirarem.

- **GitHub:** https://github.com/filipelclima/ArcInherit
- **Deploy:** Arc Testnet, `0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818` ([Blockscout](https://testnet.arcscan.app/address/0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818))
- **Frontend:** https://github.com/filipelclima/arcinherit-app

## Stack

- Solidity `^0.8.20` (deployado com `0.8.34`)
- Contrato único e imutável (`contracts/ArcInherit.sol`) — sem owner, sem proxy, sem admin functions

## Estrutura

- `contracts/ArcInherit.sol` — todo o contrato: `createVault`, `deposit`, `withdraw`, `checkIn`, `updateHeirs`, `cancelVault`, `claimInheritance` + view functions (`getVault`, `getBalances`, `canClaim`, `timeUntilClaim`, `isTimelockExpired`, `hasClaimed`)

## Invariantes importantes (cuidado ao alterar)

- Percentuais de herdeiros devem somar exatamente 100 (`InvalidPercentages`)
- `timelockDuration` mínimo 30 dias (`MIN_TIMELOCK`), `gracePeriod` mínimo 7 dias (`MIN_GRACE`)
- Claim só é possível após `lastCheckIn + timelockDuration + gracePeriod` expirar
- Contrato é imutável por design — qualquer mudança de lógica exige um novo deploy, não upgrade

## Regras de trabalho

1. **Sempre rodar os testes unitários existentes antes de fazer commit.**
2. **Sempre escrever testes novos para features novas ou correções de bugs.**
3. **Sempre atualizar este CLAUDE.md após mudanças significativas.**
4. **Manter dependências fixadas em versões exatas** (sem `^` ou `~`) ao adicionar ou atualizar pacotes.
5. **Nunca usar atalhos que escondem erros** (ex.: ignorar warnings do compilador Solidity) — sempre corrigir a causa raiz.

## Testes

- Hardhat `2.29.0` + `@nomicfoundation/hardhat-toolbox` `6.1.2` (ethers v6 + chai matchers + network-helpers), Solidity `0.8.24` no `hardhat.config.ts`.
- **Importante:** o toolbox 6.1.2 é para Hardhat 2, e exige as versões antigas (2.x/3.x/0.15.x/1.x) dos plugins `@nomicfoundation/hardhat-*` — as versões "latest" desses plugins hoje em dia são para Hardhat 3 e quebram a resolução de peer deps. Ao atualizar, sempre checar `npm view @nomicfoundation/hardhat-toolbox@<versão> peerDependencies` antes de atualizar qualquer plugin junto.
- `contracts/mocks/MockERC20.sol` — ERC-20 mínimo só para testes (mint/approve/transfer/transferFrom), usado para simular depósitos e claims sem depender de um token real.
- `test/ArcInherit.test.ts` — cobre `createVault` (sucesso + reverts de percentuais/timelock/vault duplicado), `checkIn` (atualização do `lastCheckIn` + revert sem vault) e o fluxo completo de timelock/grace period/claim (revert antes do timelock, revert durante o grace period, claim bem-sucedido, revert de não-herdeiro, revert de claim duplicado). Usa `time.increase()` do `@nomicfoundation/hardhat-network-helpers` para simular a passagem do tempo.

## Comandos

```bash
npm test          # roda a suíte de testes (hardhat test)
npm run compile   # compila os contratos
```
