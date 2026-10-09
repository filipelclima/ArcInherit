import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Extended coverage for scenarios the original 11-test suite doesn't touch: a wallet the owner
// controls used as sole heir, a token that blocks a specific heir's transfer, the owner's
// unrestricted control before AND after a claim, and characterization tests for undocumented but
// load-bearing behavior (percentage validation, duplicate heirs, cancelVault's refund scope).
// contracts/ArcInherit.sol is never modified.

const DAY = 24 * 60 * 60;
const MIN_TIMELOCK = 30 * DAY;
const MIN_GRACE = 7 * DAY;
const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 18);

async function deployFixture() {
  const [owner, heir1, heir2, backupWallet, stranger] = await ethers.getSigners();

  const ArcInherit = await ethers.getContractFactory("ArcInherit");
  const vault = await ArcInherit.deploy();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy();
  await token.mint(owner.address, DEPOSIT_AMOUNT);

  const BlockableERC20 = await ethers.getContractFactory("BlockableERC20");
  const blockableToken = await BlockableERC20.deploy();
  await blockableToken.mint(owner.address, DEPOSIT_AMOUNT);

  return { vault, token, blockableToken, owner, heir1, heir2, backupWallet, stranger };
}

async function createVault(
  vault: any,
  owner: HardhatEthersSigner,
  heirs: { wallet: string; percentage: number }[],
  timelockDuration = MIN_TIMELOCK,
  gracePeriod = MIN_GRACE
) {
  return vault.connect(owner).createVault(timelockDuration, gracePeriod, heirs);
}

describe("ArcInherit — extended scenarios", () => {
  // ─── 3a: backup wallet as sole heir ────────────────────────────────────────
  describe("backup wallet as sole heir", () => {
    it("lets a second wallet the owner also controls claim the full balance after timelock + grace, with no special-casing needed", async () => {
      const { vault, token, owner, backupWallet } = await deployFixture();

      await createVault(vault, owner, [{ wallet: backupWallet.address, percentage: 100 }]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);

      // Owner never checks in again (lost key scenario) — just let time pass.
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);
      expect(await vault.canClaim(owner.address)).to.equal(true);

      await expect(
        vault.connect(backupWallet).claimInheritance(owner.address, await token.getAddress())
      )
        .to.emit(vault, "InheritanceClaimed")
        .withArgs(owner.address, backupWallet.address, await token.getAddress(), DEPOSIT_AMOUNT);

      expect(await token.balanceOf(backupWallet.address)).to.equal(DEPOSIT_AMOUNT);
    });
  });

  // ─── 3b: a heir's transfer reverting ───────────────────────────────────────
  describe("transfer that reverts for a blocked heir", () => {
    async function setupTwoHeirsBlockable() {
      const fixture = await deployFixture();
      const { vault, blockableToken, owner, heir1, heir2 } = fixture;

      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await blockableToken.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await blockableToken.getAddress(), DEPOSIT_AMOUNT);
      await blockableToken.setBlocked(heir1.address, true);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      return fixture;
    }

    it("FINDING: when the token's transfer() itself reverts (like real USDC's blocklist), claimInheritance bubbles up the token's own revert reason, NOT the TransferFailed custom error", async () => {
      const { vault, blockableToken, heir1, owner } = await setupTwoHeirsBlockable();

      // A plain external call (not a low-level .call()) re-throws the callee's revert as-is; the
      // `if (!ok) revert TransferFailed()` check in ArcInherit.sol (L301-302) is never reached,
      // because execution never returns from a reverting external call in the first place.
      await expect(
        vault.connect(heir1).claimInheritance(owner.address, await blockableToken.getAddress())
      ).to.be.revertedWith("recipient blocked");
    });

    it("the blocked heir's claim does not get marked as claimed, so it can be retried later if unblocked", async () => {
      const { vault, blockableToken, heir1, owner } = await setupTwoHeirsBlockable();
      const tokenAddr = await blockableToken.getAddress();

      await expect(vault.connect(heir1).claimInheritance(owner.address, tokenAddr)).to.be.reverted;
      expect(await vault.hasClaimed(owner.address, heir1.address, tokenAddr)).to.equal(false);

      // Unblock and retry — proves the revert rolled back _claimed along with everything else.
      await blockableToken.setBlocked(heir1.address, false);
      await expect(vault.connect(heir1).claimInheritance(owner.address, tokenAddr)).to.emit(
        vault,
        "InheritanceClaimed"
      );
    });

    it("the other heir's claim is unaffected and pays the correct share, even while heir1 stays blocked", async () => {
      const { vault, blockableToken, heir1, heir2, owner } = await setupTwoHeirsBlockable();
      const tokenAddr = await blockableToken.getAddress();

      await expect(vault.connect(heir1).claimInheritance(owner.address, tokenAddr)).to.be.reverted;

      await expect(vault.connect(heir2).claimInheritance(owner.address, tokenAddr))
        .to.emit(vault, "InheritanceClaimed")
        .withArgs(owner.address, heir2.address, tokenAddr, (DEPOSIT_AMOUNT * 60n) / 100n);
      expect(await blockableToken.balanceOf(heir2.address)).to.equal((DEPOSIT_AMOUNT * 60n) / 100n);
    });
  });

  // ─── 3c: owner control before/after a claim ────────────────────────────────
  describe("owner keeps full control up to (and past) the claim window", () => {
    async function setupOneHeirDeposited() {
      const fixture = await deployFixture();
      const { vault, token, owner, heir1 } = fixture;
      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      return fixture;
    }

    it("owner can still withdraw, updateHeirs and cancelVault after timelock+grace expire and canClaim() is true, as long as no heir has claimed yet", async () => {
      const { vault, token, owner, heir1, heir2 } = await setupOneHeirDeposited();
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);
      expect(await vault.canClaim(owner.address)).to.equal(true);

      await expect(vault.connect(owner).withdraw(await token.getAddress(), DEPOSIT_AMOUNT / 2n)).to
        .not.be.reverted;
      await expect(
        vault.connect(owner).updateHeirs([{ wallet: heir2.address, percentage: 100 }])
      ).to.emit(vault, "HeirsUpdated");
      await expect(vault.connect(owner).cancelVault()).to.emit(vault, "VaultCancelled");

      // Owner already held half back from the withdraw above; cancelVault returns the other half
      // still in the vault, so the owner ends up with the full original amount back in their wallet.
      expect(await token.balanceOf(owner.address)).to.equal(DEPOSIT_AMOUNT);
    });

    it("FINDING: after a heir has already claimed their share, the owner can still withdraw/cancel the REMAINING unclaimed balance out from under any other heir who hasn't claimed yet", async () => {
      const { vault, token, owner, heir1, heir2 } = await deployFixture();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      // heir1 claims their 40% first.
      await vault.connect(heir1).claimInheritance(owner.address, await token.getAddress());
      expect(await token.balanceOf(heir1.address)).to.equal((DEPOSIT_AMOUNT * 40n) / 100n);

      // Nothing stops the owner from then withdrawing heir2's still-unclaimed 60% for themselves.
      const remaining = (DEPOSIT_AMOUNT * 60n) / 100n;
      await expect(vault.connect(owner).withdraw(await token.getAddress(), remaining)).to.not.be
        .reverted;

      // heir2's claim now reverts with ZeroAmount -- their share was computed off a balance the
      // owner had already drained to zero.
      await expect(
        vault.connect(heir2).claimInheritance(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });
  });

  // ─── 3d: characterization ──────────────────────────────────────────────────
  describe("characterization: percentage rules, duplicate heirs, cancelVault refund scope", () => {
    it("createVault requires percentages to sum to exactly 100 (ArcInherit.sol:129)", async () => {
      const { vault, owner, heir1, heir2 } = await deployFixture();
      await expect(
        createVault(vault, owner, [
          { wallet: heir1.address, percentage: 40 },
          { wallet: heir2.address, percentage: 50 },
        ])
      ).to.be.revertedWithCustomError(vault, "InvalidPercentages");
    });

    it("updateHeirs also requires percentages to sum to exactly 100 (ArcInherit.sol:221)", async () => {
      const { vault, owner, heir1, heir2 } = await deployFixture();
      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);
      await expect(
        vault.connect(owner).updateHeirs([
          { wallet: heir1.address, percentage: 30 },
          { wallet: heir2.address, percentage: 30 },
        ])
      ).to.be.revertedWithCustomError(vault, "InvalidPercentages");
    });

    it("accepts a 0% heir as long as the total across all heirs is still 100 (no per-heir minimum is enforced, ArcInherit.sol:126-129)", async () => {
      const { vault, owner, heir1, heir2 } = await deployFixture();
      await expect(
        createVault(vault, owner, [
          { wallet: heir1.address, percentage: 100 },
          { wallet: heir2.address, percentage: 0 },
        ])
      ).to.not.be.reverted;
    });

    it("FINDING: accepts the same wallet listed twice as a heir (no duplicate check, ArcInherit.sol:115-143) -- but claimInheritance only ever pays out the FIRST matching entry's percentage, because the lookup loop breaks on first match (ArcInherit.sol:282-287)", async () => {
      const { vault, token, owner, heir1 } = await deployFixture();
      // Two entries for heir1: 30 + 70 = 100, so createVault accepts it.
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 30 },
        { wallet: heir1.address, percentage: 70 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await vault.connect(heir1).claimInheritance(owner.address, await token.getAddress());
      // Got only the FIRST entry's 30%, not 30+70=100%, even though both list the same wallet.
      expect(await token.balanceOf(heir1.address)).to.equal((DEPOSIT_AMOUNT * 30n) / 100n);
    });

    it("cancelVault returns every deposited token's full remaining balance to the owner, not just one (ArcInherit.sol:236-253)", async () => {
      const { vault, token, blockableToken, owner, heir1 } = await deployFixture();
      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);

      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await blockableToken.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await blockableToken.getAddress(), DEPOSIT_AMOUNT);

      const balancesBeforeToken = await token.balanceOf(owner.address);
      const balancesBeforeBlockable = await blockableToken.balanceOf(owner.address);

      await vault.connect(owner).cancelVault();

      expect(await token.balanceOf(owner.address)).to.equal(balancesBeforeToken + DEPOSIT_AMOUNT);
      expect(await blockableToken.balanceOf(owner.address)).to.equal(
        balancesBeforeBlockable + DEPOSIT_AMOUNT
      );
      const balances = await vault.getBalances(owner.address);
      expect(balances[0].amount).to.equal(0);
      expect(balances[1].amount).to.equal(0);
    });

    it("with 2+ heirs, every heir gets their percentage of the balance when claims opened, not of what is left after earlier claims (fixed: was claim-order dependent)", async () => {
      const { vault, token, owner, heir1, heir2 } = await deployFixture();
      const tokenAddr = await token.getAddress();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      await vault.connect(heir2).claimInheritance(owner.address, tokenAddr);

      // Previously heir2 got 60% of the remaining 600 (360) and 240 was left for the owner only.
      expect(await token.balanceOf(heir1.address)).to.equal((DEPOSIT_AMOUNT * 40n) / 100n);
      expect(await token.balanceOf(heir2.address)).to.equal((DEPOSIT_AMOUNT * 60n) / 100n);
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
    });

    it("rejects the zero address as a heir wallet in createVault and updateHeirs (fixed: was accepted, locking that share)", async () => {
      const { vault, owner, heir1 } = await deployFixture();
      await expect(
        createVault(vault, owner, [
          { wallet: heir1.address, percentage: 50 },
          { wallet: ethers.ZeroAddress, percentage: 50 },
        ])
      ).to.be.revertedWithCustomError(vault, "ZeroAddressHeir");

      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);
      await expect(
        vault.connect(owner).updateHeirs([{ wallet: ethers.ZeroAddress, percentage: 100 }])
      ).to.be.revertedWithCustomError(vault, "ZeroAddressHeir");
      // Rejected even at 0%, since such an entry can never mean anything.
      await expect(
        vault.connect(owner).updateHeirs([
          { wallet: heir1.address, percentage: 100 },
          { wallet: ethers.ZeroAddress, percentage: 0 },
        ])
      ).to.be.revertedWithCustomError(vault, "ZeroAddressHeir");
    });
  });

  // ─── claim snapshot: payout from the balance when claims opened ────────────
  describe("claim snapshot", () => {
    // Every order of three heirs (indexes into the heirs array).
    const PERMUTATIONS = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    async function setupThreeHeirs(percentages: number[], amount: bigint) {
      const fixture = await deployFixture();
      const { vault, token, owner, heir1, heir2, backupWallet: heir3 } = fixture;
      const heirs = [heir1, heir2, heir3];
      await createVault(
        vault,
        owner,
        heirs.map((h, i) => ({ wallet: h.address, percentage: percentages[i] }))
      );
      await token.connect(owner).approve(await vault.getAddress(), amount);
      await vault.connect(owner).deposit(await token.getAddress(), amount);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);
      return { ...fixture, heirs, tokenAddr: await token.getAddress() };
    }

    for (const order of PERMUTATIONS) {
      it(`3-heir 20/30/50 split pays the same amounts when claimed in order ${order.join(",")}`, async () => {
        const percentages = [20, 30, 50];
        const { vault, token, owner, heirs, tokenAddr } = await setupThreeHeirs(
          percentages,
          DEPOSIT_AMOUNT
        );

        for (const i of order) {
          await vault.connect(heirs[i]).claimInheritance(owner.address, tokenAddr);
        }

        for (let i = 0; i < heirs.length; i++) {
          expect(await token.balanceOf(heirs[i].address)).to.equal(
            (DEPOSIT_AMOUNT * BigInt(percentages[i])) / 100n
          );
        }
        expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
        expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(DEPOSIT_AMOUNT);
      });
    }

    for (const order of PERMUTATIONS) {
      it(`rounding dust: 33/33/34 split of 1001 wei pays 330/330/340 in order ${order.join(",")} and leaves 1 wei for the owner`, async () => {
        const amount = 1001n;
        const { vault, token, owner, heirs, tokenAddr } = await setupThreeHeirs([33, 33, 34], amount);

        for (const i of order) {
          await vault.connect(heirs[i]).claimInheritance(owner.address, tokenAddr);
        }

        expect(await token.balanceOf(heirs[0].address)).to.equal(330n);
        expect(await token.balanceOf(heirs[1].address)).to.equal(330n);
        expect(await token.balanceOf(heirs[2].address)).to.equal(340n);
        // Rounding down never over-pays, so the dust stays in the vault and only the owner can
        // withdraw it.
        expect((await vault.getBalances(owner.address))[0].amount).to.equal(1n);
        await expect(vault.connect(owner).withdraw(tokenAddr, 1n)).to.emit(vault, "Withdrawn");
      });
    }

    it("the snapshot is taken once, on the first successful claim, and exposed by claimSnapshot()", async () => {
      const { vault, owner, heirs, tokenAddr } = await setupThreeHeirs([20, 30, 50], DEPOSIT_AMOUNT);

      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(0);
      await expect(vault.connect(heirs[0]).claimInheritance(owner.address, tokenAddr))
        .to.emit(vault, "ClaimSnapshotTaken")
        .withArgs(owner.address, tokenAddr, DEPOSIT_AMOUNT);
      await expect(
        vault.connect(heirs[1]).claimInheritance(owner.address, tokenAddr)
      ).to.not.emit(vault, "ClaimSnapshotTaken");
      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(DEPOSIT_AMOUNT);
    });

    it("a deposit by the owner after the first claim is not added to the snapshot: later heirs still get pct of the original balance, and the extra stays with the owner", async () => {
      const { vault, token, owner, heirs, tokenAddr } = await setupThreeHeirs(
        [20, 30, 50],
        DEPOSIT_AMOUNT
      );
      await vault.connect(heirs[0]).claimInheritance(owner.address, tokenAddr);

      const extra = ethers.parseUnits("500", 18);
      await token.mint(owner.address, extra);
      await token.connect(owner).approve(await vault.getAddress(), extra);
      await vault.connect(owner).deposit(tokenAddr, extra);

      await vault.connect(heirs[1]).claimInheritance(owner.address, tokenAddr);
      await vault.connect(heirs[2]).claimInheritance(owner.address, tokenAddr);

      expect(await token.balanceOf(heirs[1].address)).to.equal((DEPOSIT_AMOUNT * 30n) / 100n);
      expect(await token.balanceOf(heirs[2].address)).to.equal((DEPOSIT_AMOUNT * 50n) / 100n);
      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(DEPOSIT_AMOUNT);
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(extra);
    });

    it("a withdrawal by the owner after the first claim that still leaves enough does not change later heirs' shares", async () => {
      const { vault, token, owner, heirs, tokenAddr } = await setupThreeHeirs(
        [20, 30, 50],
        DEPOSIT_AMOUNT
      );
      await vault.connect(heirs[0]).claimInheritance(owner.address, tokenAddr); // 200 paid, 800 left
      // Heirs 1 and 2 are owed 300 + 500 = 800; deposit 100 more and take it back out.
      const extra = ethers.parseUnits("100", 18);
      await token.mint(owner.address, extra);
      await token.connect(owner).approve(await vault.getAddress(), extra);
      await vault.connect(owner).deposit(tokenAddr, extra);
      await vault.connect(owner).withdraw(tokenAddr, extra);

      await vault.connect(heirs[1]).claimInheritance(owner.address, tokenAddr);
      await vault.connect(heirs[2]).claimInheritance(owner.address, tokenAddr);

      expect(await token.balanceOf(heirs[1].address)).to.equal((DEPOSIT_AMOUNT * 30n) / 100n);
      expect(await token.balanceOf(heirs[2].address)).to.equal((DEPOSIT_AMOUNT * 50n) / 100n);
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
    });

    it("if the owner withdraws below what later heirs are owed, the next claim is capped at the remaining balance and the one after reverts with ZeroAmount", async () => {
      const { vault, owner, heirs, tokenAddr } = await setupThreeHeirs([20, 30, 50], DEPOSIT_AMOUNT);
      await vault.connect(heirs[0]).claimInheritance(owner.address, tokenAddr); // 200 paid, 800 left
      await vault.connect(owner).withdraw(tokenAddr, ethers.parseUnits("600", 18)); // 200 left

      // heirs[2] is owed 500 but only 200 is left.
      await expect(vault.connect(heirs[2]).claimInheritance(owner.address, tokenAddr))
        .to.emit(vault, "InheritanceClaimed")
        .withArgs(owner.address, heirs[2].address, tokenAddr, ethers.parseUnits("200", 18));
      await expect(
        vault.connect(heirs[1]).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("if the owner raises a heir's percentage after the first claim, that heir's payout is capped at the remaining balance", async () => {
      const { vault, token, owner, heir1, heir2, tokenAddr } = await setupThreeHeirs(
        [20, 30, 50],
        DEPOSIT_AMOUNT
      );
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr); // 200 paid, 800 left
      await vault.connect(owner).updateHeirs([
        { wallet: heir1.address, percentage: 10 },
        { wallet: heir2.address, percentage: 90 },
      ]);

      // 90% of the 1000 snapshot is 900, but only 800 is left.
      await vault.connect(heir2).claimInheritance(owner.address, tokenAddr);
      expect(await token.balanceOf(heir2.address)).to.equal(ethers.parseUnits("800", 18));
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
    });

    it("blocked heir retry: a reverted first claim takes no snapshot, and the heir gets pct of the original balance once unblocked, even though another heir claimed in between", async () => {
      const { vault, blockableToken, owner, heir1, heir2 } = await deployFixture();
      const tokenAddr = await blockableToken.getAddress();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await blockableToken.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await blockableToken.setBlocked(heir1.address, true);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await expect(
        vault.connect(heir1).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWith("recipient blocked");
      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(0);

      await vault.connect(heir2).claimInheritance(owner.address, tokenAddr);
      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(DEPOSIT_AMOUNT);

      await blockableToken.setBlocked(heir1.address, false);
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);

      expect(await blockableToken.balanceOf(heir1.address)).to.equal((DEPOSIT_AMOUNT * 40n) / 100n);
      expect(await blockableToken.balanceOf(heir2.address)).to.equal((DEPOSIT_AMOUNT * 60n) / 100n);
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
    });

    it("snapshots are per token: claiming one token does not fix the balance used for another", async () => {
      const { vault, token, blockableToken, owner, heir1, heir2 } = await deployFixture();
      const tokenAddr = await token.getAddress();
      const blockableAddr = await blockableToken.getAddress();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await blockableToken.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(blockableAddr, DEPOSIT_AMOUNT / 2n);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      // blockableToken has no snapshot yet, so a deposit now still counts for its heirs.
      await vault.connect(owner).deposit(blockableAddr, DEPOSIT_AMOUNT / 2n);
      await vault.connect(heir2).claimInheritance(owner.address, blockableAddr);

      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(DEPOSIT_AMOUNT);
      expect(await vault.claimSnapshot(owner.address, blockableAddr)).to.equal(DEPOSIT_AMOUNT);
      expect(await blockableToken.balanceOf(heir2.address)).to.equal((DEPOSIT_AMOUNT * 60n) / 100n);
    });
  });

  // ─── claim rounds: a check-in after a claim (false alarm) starts over ──────
  describe("claim rounds", () => {
    async function setupTwoHeirsDeposited() {
      const fixture = await deployFixture();
      const { vault, token, owner, heir1, heir2 } = fixture;
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);
      return { ...fixture, tokenAddr: await token.getAddress() };
    }

    it("false alarm: claim, owner checks in, deposits more, timelock expires again -- every heir gets their % of the new balance and nothing is stuck", async () => {
      const { vault, token, owner, heir1, heir2, tokenAddr } = await setupTwoHeirsDeposited();

      // Round 0: heir1 claims 40% of 1000 while the owner is presumed gone.
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      const round0Payout = (DEPOSIT_AMOUNT * 40n) / 100n; // 400, 600 left

      // The owner comes back: the check-in starts round 1 and closes claims again.
      await expect(vault.connect(owner).checkIn())
        .to.emit(vault, "ClaimRoundStarted")
        .withArgs(owner.address, 1);
      expect(await vault.claimRound(owner.address)).to.equal(1);
      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(0);
      expect(await vault.hasClaimed(owner.address, heir1.address, tokenAddr)).to.equal(false);
      await expect(
        vault.connect(heir2).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWithCustomError(vault, "TimelockNotExpired");

      // The owner deposits more, then really is gone this time.
      const extra = ethers.parseUnits("500", 18);
      await token.mint(owner.address, extra);
      await token.connect(owner).approve(await vault.getAddress(), extra);
      await vault.connect(owner).deposit(tokenAddr, extra);
      const round1Balance = DEPOSIT_AMOUNT - round0Payout + extra; // 1100
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      // Round 1: heir2 claims first this time; both get their % of 1100.
      await vault.connect(heir2).claimInheritance(owner.address, tokenAddr);
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);

      expect(await vault.claimSnapshot(owner.address, tokenAddr)).to.equal(round1Balance);
      expect(await token.balanceOf(heir1.address)).to.equal(
        round0Payout + (round1Balance * 40n) / 100n
      );
      expect(await token.balanceOf(heir2.address)).to.equal((round1Balance * 60n) / 100n);
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(0);
    });

    it("a check-in with no prior claim does NOT start a new round", async () => {
      const { vault, owner } = await setupTwoHeirsDeposited();

      // Claims are open, but nobody has claimed yet.
      await expect(vault.connect(owner).checkIn()).to.not.emit(vault, "ClaimRoundStarted");
      expect(await vault.claimRound(owner.address)).to.equal(0);
    });

    it("only the first check-in after a claim starts a new round; later check-ins with no new claims don't", async () => {
      const { vault, owner, heir1, tokenAddr } = await setupTwoHeirsDeposited();
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);

      await expect(vault.connect(owner).checkIn()).to.emit(vault, "ClaimRoundStarted");
      await expect(vault.connect(owner).checkIn()).to.not.emit(vault, "ClaimRoundStarted");
      expect(await vault.claimRound(owner.address)).to.equal(1);
    });

    it("a heir can claim once per round, not twice in the same round", async () => {
      const { vault, owner, heir1, tokenAddr } = await setupTwoHeirsDeposited();
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      await vault.connect(owner).checkIn();
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      expect(await vault.hasClaimed(owner.address, heir1.address, tokenAddr)).to.equal(true);
      await expect(
        vault.connect(heir1).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    });

    it("a claim that reverts (blocked heir) does not count as a claim, so a check-in afterwards does not start a new round", async () => {
      const { vault, blockableToken, owner, heir1, heir2 } = await deployFixture();
      const tokenAddr = await blockableToken.getAddress();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await blockableToken.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await blockableToken.setBlocked(heir1.address, true);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await expect(vault.connect(heir1).claimInheritance(owner.address, tokenAddr)).to.be.reverted;
      await expect(vault.connect(owner).checkIn()).to.not.emit(vault, "ClaimRoundStarted");
      expect(await vault.claimRound(owner.address)).to.equal(0);
    });
  });
});
