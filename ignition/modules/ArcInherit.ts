import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// ArcInherit has no constructor arguments and no admin, so the module is just the contract.
export default buildModule("ArcInheritModule", (m) => {
  const arcInherit = m.contract("ArcInherit");
  return { arcInherit };
});
