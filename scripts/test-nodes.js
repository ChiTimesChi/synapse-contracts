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

  await network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
          blockNumber: 6632404,
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
    params: ["0x230a1ac45690b9ae1176389434610b9526d2f21b"],
  });
  const nodes = await ethers.getSigner("0x230a1ac45690b9ae1176389434610b9526d2f21b")

  await bridge.connect(nodes).mint("0x3ab92d06f5f2a33d8f45f836607f8da68cab81e8","0xCFc37A6AB183dd4aED08C204D1c2773c0b1BDf46", "8210634000000000000000000", "100000000000000000000", "0x62d14fb0c081bb2ff38f5daccaa3687e065f8e80c4210e8226baf163cd1c09a9")
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });