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

    it("FINDING: with 2+ heirs, later claimers get their percentage of the REMAINING balance, not of the original deposit (ArcInherit.sol:295-296) -- the leftover can only be withdrawn by the owner", async () => {
      const { vault, token, owner, heir1, heir2 } = await deployFixture();
      const tokenAddr = await token.getAddress();
      await createVault(vault, owner, [
        { wallet: heir1.address, percentage: 40 },
        { wallet: heir2.address, percentage: 60 },
      ]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      // heir1 claims first and gets 40% of the full deposit (400).
      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      const heir1Share = (DEPOSIT_AMOUNT * 40n) / 100n;
      expect(await token.balanceOf(heir1.address)).to.equal(heir1Share);

      // heir2 then gets 60% of the remaining 600 (360), not 60% of 1000 (600).
      await vault.connect(heir2).claimInheritance(owner.address, tokenAddr);
      const heir2Share = ((DEPOSIT_AMOUNT - heir1Share) * 60n) / 100n;
      expect(await token.balanceOf(heir2.address)).to.equal(heir2Share);
      expect(heir2Share).to.be.lessThan((DEPOSIT_AMOUNT * 60n) / 100n);

      // The leftover (240) stays in the vault: both heirs have already claimed, so only the owner
      // can get it out.
      const leftover = DEPOSIT_AMOUNT - heir1Share - heir2Share;
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(leftover);
      await expect(
        vault.connect(heir2).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
      await vault.connect(owner).withdraw(tokenAddr, leftover);
      expect(await token.balanceOf(owner.address)).to.equal(leftover);
    });

    it("FINDING: accepts the zero address as a heir wallet (no zero-address check, ArcInherit.sol:115-143) -- nobody can ever claim that share, so it stays in the vault for the owner only", async () => {
      const { vault, token, owner, heir1, stranger } = await deployFixture();
      const tokenAddr = await token.getAddress();
      await expect(
        createVault(vault, owner, [
          { wallet: heir1.address, percentage: 50 },
          { wallet: ethers.ZeroAddress, percentage: 50 },
        ])
      ).to.not.be.reverted;
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(tokenAddr, DEPOSIT_AMOUNT);
      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await vault.connect(heir1).claimInheritance(owner.address, tokenAddr);
      const remaining = DEPOSIT_AMOUNT / 2n;

      // No signer can be msg.sender == address(0), so the zero-address share is unclaimable;
      // any other caller is simply NotAnHeir.
      await expect(
        vault.connect(stranger).claimInheritance(owner.address, tokenAddr)
      ).to.be.revertedWithCustomError(vault, "NotAnHeir");
      expect((await vault.getBalances(owner.address))[0].amount).to.equal(remaining);

      // updateHeirs accepts it too.
      await expect(
        vault.connect(owner).updateHeirs([{ wallet: ethers.ZeroAddress, percentage: 100 }])
      ).to.emit(vault, "HeirsUpdated");
    });
  });
});
