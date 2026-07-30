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

## Comandos

> **Nota:** este repo ainda não tem framework de testes configurado (sem Foundry/Hardhat). Antes de aplicar a regra 1 numa mudança específica, configurar Foundry (`forge init`) ou Hardhat e escrever os testes de unidade para as invariantes acima (percentuais, timelock/grace period, claim único por herdeiro/token, cancelamento devolvendo todos os tokens).
