// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const hre = require("hardhat");

const ethers = hre.ethers;

async function main() {
  // Hardhat always runs the compile task when running scripts with its command
  // line interface.
  //
  // If this script is run directly using `node` you may want to call compile
  // manually to make sure everything is compiled
  // await hre.run('compile');

  // We get the contract to deploy
  const SynapseBridgeFactory = await hre.ethers.getContractFactory("SynapseBridge");
  const SynapseERC20Factory = await hre.ethers.getContractFactory("SynapseERC20");
  const L2ZapFactory = await hre.ethers.getContractFactory("L2BridgeZap");

  await network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
          blockNumber: 6633052,
        },
      },
    ],
  });

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: ["0xd7aDA77aa0f82E6B3CF5bF9208b0E5E1826CD79C"],
  });
  const multisig = await ethers.getSigner("0xd7aDA77aa0f82E6B3CF5bF9208b0E5E1826CD79C")

  await network.provider.send("hardhat_setBalance", [
    "0xd7aDA77aa0f82E6B3CF5bF9208b0E5E1826CD79C",
    "0x9900000000000000",
  ]);
  

  const bridge = await SynapseBridgeFactory.attach("0xC05e61d0E7a63D27546389B7aD62FdFf5A91aACE")

  await bridge.connect(multisig).unpause()
  


  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: ["0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE"],
  })

  await network.provider.send("hardhat_setBalance", [
    "0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE",
    "0x990000000000000000",
  ]);
  

  const signer = await ethers.getSigner("0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE")


  const L2Zap = await L2ZapFactory.attach("0x997108791D5e7c0ce2a9A4AAC89427C68E345173")
  const USDC = await SynapseERC20Factory.attach("0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664")

  console.log((await USDC.balanceOf("0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE")).toString())
  await L2Zap.connect(signer).swapAndRedeem("0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE", "43114", "0xCFc37A6AB183dd4aED08C204D1c2773c0b1BDf46", "2", "0", "10000000000", "0", "1636362829")
  console.log((await USDC.balanceOf("0x3168082c31Dc4B03AC752Fb43d1C3Bf8AE6EE9AE")).toString())
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });