# ArcInherit — Contrato

> Nome do produto agora é **Heirloom** (antes ArcInherit). O contrato Solidity continua se chamando `ArcInherit`.

Vault de herança onchain para tokens ERC-20 na Arc Network. Owner deposita tokens e designa herdeiros com percentuais; se parar de fazer check-in (prova de vida), os herdeiros podem reivindicar sua parte após o timelock + grace period expirarem.

- **GitHub:** https://github.com/filipelclima/ArcInherit
- **Deploy atual (v2):** Arc Testnet, `0x31C6962393e002845a647bB22e21c6B219eF7F16` — código verificado ([explorer](https://explorer.testnet.arc.io/address/0x31C6962393e002845a647bB22e21c6B219eF7F16#code)). Fonte idêntica a `contracts/ArcInherit.sol` no commit `0770499`
- **Legado (v1):** Arc Testnet, `0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818` ([explorer](https://explorer.testnet.arc.io/address/0xdb7875DBfDe3A5C4763C11eF15f972C26E3D8818)) — ainda tem o bug da ordem dos claims e aceita herdeiro `address(0)`; vaults antigos continuam lá
- **Explorer:** https://explorer.testnet.arc.io (Blockscout; `testnet.arcscan.app` agora redireciona para lá)
- **Frontend:** https://github.com/filipelclima/arcinherit-app

## Stack

- Solidity `^0.8.20` — v2 compilado com `0.8.24` (o mesmo do `hardhat.config.ts`); v1 foi compilado com `0.8.34`
- Contrato único e imutável (`contracts/ArcInherit.sol`) — sem owner, sem proxy, sem admin functions

## Estrutura

- `contracts/ArcInherit.sol` — todo o contrato: `createVault`, `deposit`, `withdraw`, `checkIn`, `updateHeirs`, `cancelVault`, `claimInheritance` + view functions (`getVault`, `getBalances`, `canClaim`, `timeUntilClaim`, `isTimelockExpired`, `hasClaimed`, `claimSnapshot`, `claimRound`)

## Invariantes importantes (cuidado ao alterar)

- Percentuais de herdeiros devem somar exatamente 100 (`InvalidPercentages`)
- `timelockDuration` mínimo 30 dias (`MIN_TIMELOCK`), `gracePeriod` mínimo 7 dias (`MIN_GRACE`)
- Claim só é possível após `lastCheckIn + timelockDuration + gracePeriod` expirar
- Share de cada herdeiro = `pct` do `_claimSnapshot[owner][round][token]` (saldo no primeiro claim bem-sucedido daquele token na rodada), limitado ao saldo restante — o pagamento não depende da ordem dos claims. Snapshot `0` significa "ainda sem claim"
- **Rodadas de claim:** snapshot e `_claimed` são indexados por `_claimRound[owner]`. Um `checkIn` depois de pelo menos um claim bem-sucedido na rodada atual (`_roundHasClaims`) inicia uma nova rodada (`ClaimRoundStarted`) — caso "alarme falso". `checkIn` sem claim prévio não muda a rodada. `hasClaimed`/`claimSnapshot` olham a rodada atual; `claimRound(owner)` expõe o número
- Herdeiro com `wallet == address(0)` é rejeitado (`ZeroAddressHeir`) em `createVault` e `updateHeirs`
- Snapshot, rodadas de claim e `ZeroAddressHeir` estão no v2 (`0x31C6…7F16`), não no v1 legado (`0xdb78…8818`). Qualquer mudança no `.sol` a partir daqui deixa o código-fonte diferente do v2 deployado — registrar isso aqui e no README até o próximo deploy
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
- `contracts/mocks/BlockableERC20.sol` — ERC-20 que pode bloquear endereços (simula a blocklist do USDC).
- `test/ArcInherit.extended.test.ts` — cenários extras e testes `FINDING:` que documentam limitações do contrato atual (controle total do owner após o prazo, herdeiro duplicado pago uma vez, transfer bloqueada reverte e pode ser refeita). Essas limitações estão listadas na seção "Known limits" do README. O bloco `claim snapshot` cobre a correção da ordem dos claims: split de 3 herdeiros em todas as 6 ordens, poeira de arredondamento, depósito/saque do owner após o primeiro claim, aumento de % via `updateHeirs`, retry de herdeiro bloqueado e snapshot por token. O bloco `claim rounds` cobre o alarme falso (claim → check-in → depósito → novo prazo → todos recebem % do novo saldo), check-in sem claim prévio não iniciar rodada, um claim por herdeiro por rodada e claim revertido não contar como claim.

## Comandos

```bash
npm test          # roda a suíte de testes (hardhat test)
npm run compile   # compila os contratos
```

## Deploy (Arc Testnet)

- Rede `arcTestnet` no `hardhat.config.ts` (RPC `https://rpc.testnet.arc.io`, chainId `5042002`). Chave do deployer **só** via env var `DEPLOYER_PRIVATE_KEY` — nunca hardcoded, nunca em arquivo commitado (`.env` está no `.gitignore`). Sem a env var a rede fica sem contas, e testes/compile continuam funcionando.
- Módulo Ignition: `ignition/modules/ArcInherit.ts`. Registros de deploy ficam em `ignition/deployments/chain-5042002/` (commitar — é informação pública).
- Verificação: Blockscout do explorer da Arc (`https://explorer.testnet.arc.io/api`) via `blockscout.customChains` no config (Etherscan e Sourcify desabilitados, sem API key). Não usar `testnet.arcscan.app` — ele responde com redirect e o POST de verificação recebe HTML.
- `npx hardhat verify` não precisa da chave privada.
- Depois de um deploy novo: atualizar o endereço e a versão do compilador aqui e no README, commitar o registro em `ignition/deployments/`, e atualizar endereço/ABI no frontend.

```powershell
$env:DEPLOYER_PRIVATE_KEY = Read-Host "Deployer private key" -MaskInput
npx hardhat ignition deploy ignition/modules/ArcInherit.ts --network arcTestnet
npx hardhat verify --network arcTestnet <endereço>
Remove-Item Env:DEPLOYER_PRIVATE_KEY
```
