import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 24 * 60 * 60;
const MIN_TIMELOCK = 30 * DAY;
const MIN_GRACE = 7 * DAY;
const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 18);

async function deployFixture() {
  const [owner, heir1, heir2, stranger] = await ethers.getSigners();

  const ArcInherit = await ethers.getContractFactory("ArcInherit");
  const vault = await ArcInherit.deploy();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy();
  await token.mint(owner.address, DEPOSIT_AMOUNT);

  return { vault, token, owner, heir1, heir2, stranger };
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

describe("ArcInherit", () => {
  describe("createVault", () => {
    it("creates a vault with valid params", async () => {
      const { vault, owner, heir1 } = await deployFixture();

      await expect(createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]))
        .to.emit(vault, "VaultCreated")
        .withArgs(owner.address, MIN_TIMELOCK, MIN_GRACE);

      const [timelockDuration, gracePeriod, , active, heirs] = await vault.getVault(owner.address);
      expect(timelockDuration).to.equal(MIN_TIMELOCK);
      expect(gracePeriod).to.equal(MIN_GRACE);
      expect(active).to.equal(true);
      expect(heirs).to.have.lengthOf(1);
      expect(heirs[0].wallet).to.equal(heir1.address);
      expect(heirs[0].percentage).to.equal(100);
    });

    it("reverts if heir percentages do not sum to 100", async () => {
      const { vault, owner, heir1 } = await deployFixture();

      await expect(
        createVault(vault, owner, [{ wallet: heir1.address, percentage: 50 }])
      ).to.be.revertedWithCustomError(vault, "InvalidPercentages");
    });

    it("reverts if timelockDuration is below the minimum", async () => {
      const { vault, owner, heir1 } = await deployFixture();

      await expect(
        createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }], DAY)
      ).to.be.revertedWithCustomError(vault, "InvalidTimelock");
    });

    it("reverts if a vault already exists for the owner", async () => {
      const { vault, owner, heir1 } = await deployFixture();

      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);

      await expect(
        createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }])
      ).to.be.revertedWithCustomError(vault, "VaultAlreadyExists");
    });
  });

  describe("checkIn", () => {
    it("resets the countdown by updating lastCheckIn", async () => {
      const { vault, owner, heir1 } = await deployFixture();
      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);

      await time.increase(10 * DAY);
      const tx = await vault.connect(owner).checkIn();
      const block = await ethers.provider.getBlock(tx.blockNumber!);

      await expect(tx).to.emit(vault, "CheckIn").withArgs(owner.address, block!.timestamp);

      const [, , lastCheckIn] = await vault.getVault(owner.address);
      expect(lastCheckIn).to.equal(block!.timestamp);
    });

    it("reverts if the caller has no vault", async () => {
      const { vault, stranger } = await deployFixture();
      await expect(vault.connect(stranger).checkIn()).to.be.revertedWithCustomError(
        vault,
        "VaultDoesNotExist"
      );
    });
  });

  describe("timelock and claimInheritance", () => {
    async function setupWithDeposit() {
      const fixture = await deployFixture();
      const { vault, token, owner, heir1 } = fixture;

      await createVault(vault, owner, [{ wallet: heir1.address, percentage: 100 }]);
      await token.connect(owner).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(await token.getAddress(), DEPOSIT_AMOUNT);

      return fixture;
    }

    it("reverts if a heir tries to claim before the timelock expires", async () => {
      const { vault, token, heir1, owner } = await setupWithDeposit();

      await expect(
        vault.connect(heir1).claimInheritance(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "TimelockNotExpired");
    });

    it("reverts if a heir tries to claim during the grace period", async () => {
      const { vault, token, heir1, owner } = await setupWithDeposit();

      await time.increase(MIN_TIMELOCK + 1);

      await expect(
        vault.connect(heir1).claimInheritance(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "GracePeriodNotExpired");
    });

    it("lets the heir claim their share once timelock + grace period have both expired", async () => {
      const { vault, token, heir1, owner } = await setupWithDeposit();

      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await expect(
        vault.connect(heir1).claimInheritance(owner.address, await token.getAddress())
      )
        .to.emit(vault, "InheritanceClaimed")
        .withArgs(owner.address, heir1.address, await token.getAddress(), DEPOSIT_AMOUNT);

      expect(await token.balanceOf(heir1.address)).to.equal(DEPOSIT_AMOUNT);
    });

    it("reverts if a non-heir tries to claim", async () => {
      const { vault, token, stranger, owner } = await setupWithDeposit();

      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);

      await expect(
        vault.connect(stranger).claimInheritance(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "NotAnHeir");
    });

    it("reverts on a second claim of the same token by the same heir", async () => {
      const { vault, token, heir1, owner } = await setupWithDeposit();

      await time.increase(MIN_TIMELOCK + MIN_GRACE + 1);
      await vault.connect(heir1).claimInheritance(owner.address, await token.getAddress());

      await expect(
        vault.connect(heir1).claimInheritance(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    });
  });
});
