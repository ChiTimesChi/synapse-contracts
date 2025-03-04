import { BigNumber, Signer, Wallet } from "ethers"
import {
  MAX_UINT256,
  asyncForEach,
  deployContractWithLibraries,
  getCurrentBlockTimestamp,
  getUserTokenBalance,
  getUserTokenBalances,
} from "./testUtils"
import { deployContract, solidity } from "ethereum-waffle"
import { deployments, ethers } from "hardhat"

import { GenericERC20 } from "../../build/typechain/GenericERC20"
import GenericERC20Artifact from "../../build/artifacts/contracts/amm/helper/GenericERC20.sol/GenericERC20.json"
import { LPToken } from "../../build/typechain/LPToken"
import LPTokenArtifact from "../../build/artifacts/contracts/amm/LPToken.sol/LPToken.json"
import { Swap } from "../../build/typechain/Swap"
import SwapArtifact from "../../build/artifacts/contracts/amm/Swap.sol/Swap.json"
import { MetaSwap } from "../../build/typechain/MetaSwap"
import MetaSwapArtifact from "../../build/artifacts/contracts/amm/meta/MetaSwap.sol/MetaSwap.json"
import { MetaSwapDeposit } from "../../build/typechain/MetaSwapDeposit"
import MetaSwapDepositArtifact from "../../build/artifacts/contracts/amm/meta/MetaSwapDeposit.sol/MetaSwapDeposit.json"
import chai from "chai"

chai.use(solidity)
const { expect } = chai

describe("Meta-Swap Deposit Contract", async () => {
  let signers: Array<Signer>
  let baseSwap: Swap
  let metaSwap: MetaSwap
  let metaSwapDeposit: MetaSwapDeposit
  let susd: GenericERC20
  let dai: GenericERC20
  let usdc: GenericERC20
  let usdt: GenericERC20
  let allTokens: GenericERC20[]
  let baseLPToken: GenericERC20
  let metaLPToken: LPToken
  let owner: Signer
  let user1: Signer
  let user2: Signer
  let ownerAddress: string
  let user1Address: string
  let user2Address: string

  // Test Values
  const INITIAL_A_VALUE = 50
  const SWAP_FEE = 1e7
  const LP_TOKEN_NAME = "Test LP Token Name"
  const LP_TOKEN_SYMBOL = "TESTLP"

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      const { get } = deployments
      await deployments.fixture() // ensure you start from a fresh deployments

      signers = await ethers.getSigners()
      owner = signers[0]
      user1 = signers[1]
      user2 = signers[2]
      ownerAddress = await owner.getAddress()
      user1Address = await user1.getAddress()
      user2Address = await user2.getAddress()

      // Load contracts from the deployments
      baseSwap = (await ethers.getContractAt(
        SwapArtifact.abi,
        (
          await get("USDPool")
        ).address,
      )) as Swap

      baseLPToken = (await ethers.getContractAt(
        GenericERC20Artifact.abi,
        (
          await get("USDPool-LPToken")
        ).address,
      )) as GenericERC20

      dai = (await ethers.getContractAt(
        GenericERC20Artifact.abi,
        (
          await get("DAI")
        ).address,
      )) as GenericERC20

      usdc = (await ethers.getContractAt(
        GenericERC20Artifact.abi,
        (
          await get("USDC")
        ).address,
      )) as GenericERC20

      usdt = (await ethers.getContractAt(
        GenericERC20Artifact.abi,
        (
          await get("USDT")
        ).address,
      )) as GenericERC20

      // Deploy dummy tokens
      susd = (await deployContract(owner as Wallet, GenericERC20Artifact, [
        "Synthetix USD",
        "sUSD",
        "18",
      ])) as GenericERC20

      // Mint tokens
      await asyncForEach(
        [ownerAddress, user1Address, user2Address],
        async (address) => {
          await dai.mint(address, BigNumber.from(10).pow(18).mul(100000))
          await usdc.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await usdt.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await susd.mint(address, BigNumber.from(10).pow(18).mul(100000))
        },
      )

      // Deploy Swap with SwapUtils library
      metaSwap = (await deployContractWithLibraries(owner, MetaSwapArtifact, {
        SwapUtils: (await get("SwapUtils")).address,
        MetaSwapUtils: (await get("MetaSwapUtils")).address,
        AmplificationUtils: (await get("AmplificationUtils")).address,
      })) as MetaSwap
      await metaSwap.deployed()

      // Set approvals
      await asyncForEach([owner, user1, user2], async (signer) => {
        await susd.connect(signer).approve(metaSwap.address, MAX_UINT256)
        await dai.connect(signer).approve(metaSwap.address, MAX_UINT256)
        await usdc.connect(signer).approve(metaSwap.address, MAX_UINT256)
        await usdt.connect(signer).approve(metaSwap.address, MAX_UINT256)
        await dai.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdc.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdt.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await baseLPToken.connect(signer).approve(metaSwap.address, MAX_UINT256)

        // Add some liquidity to the base pool
        await baseSwap
          .connect(signer)
          .addLiquidity(
            [String(1e20), String(1e8), String(1e8)],
            0,
            MAX_UINT256,
          )
      })

      // Initialize meta swap pool
      await metaSwap.initializeMetaSwap(
        [susd.address, baseLPToken.address],
        [18, 18],
        LP_TOKEN_NAME,
        LP_TOKEN_SYMBOL,
        INITIAL_A_VALUE,
        SWAP_FEE,
        0,
        (
          await get("LPToken")
        ).address,
        baseSwap.address,
      )
      metaLPToken = (await ethers.getContractAt(
        LPTokenArtifact.abi,
        (
          await metaSwap.swapStorage()
        ).lpToken,
      )) as LPToken

      // Add some initial liquidity so that calculations work
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e20), String(1e20)], 0, MAX_UINT256)

      // Deploy MetaSwapDeposit contract
      metaSwapDeposit = (await deployContract(
        signers[0] as Wallet,
        MetaSwapDepositArtifact,
      )) as MetaSwapDeposit

      // Initialize MetaSwapDeposit
      await metaSwapDeposit.initialize(
        baseSwap.address,
        metaSwap.address,
        metaLPToken.address,
      )
      allTokens = [susd, dai, usdc, usdt]

      // Approve token transfers to MetaSwapDeposit
      await asyncForEach([owner, user1, user2], async (signer) => {
        await asyncForEach(
          [susd, dai, usdc, usdt, metaLPToken],
          async (token) => {
            await token
              .connect(signer)
              .approve(metaSwapDeposit.address, MAX_UINT256)
          },
        )
      })
    },
  )

  beforeEach(async () => {
    await setupTest()
  })

  describe("getToken", () => {
    it("Returns correct token addresses", async () => {
      expect(await metaSwapDeposit.getToken(0)).to.be.eq(susd.address)
      expect(await metaSwapDeposit.getToken(1)).to.be.eq(dai.address)
      expect(await metaSwapDeposit.getToken(2)).to.be.eq(usdc.address)
      expect(await metaSwapDeposit.getToken(3)).to.be.eq(usdt.address)
    })

    it("Reverts if out of range", async () => {
      await expect(metaSwapDeposit.getToken(20)).to.be.revertedWith(
        "out of range",
      )
    })
  })

  describe("swap", () => {
    it("From 18 decimal token (meta) to 18 decimal token (base)", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapDeposit.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99878056064760201"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [susd, dai])

      // User 1 successfully initiates swap
      await metaSwapDeposit
        .connect(user1)
        .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [susd, dai])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("From 6 decimal token (base) to 18 decimal token (meta)", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapDeposit.calculateSwap(
        2,
        0,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99898035667013493"))

      // Calculating swapping from a base token to a meta level token
      // does not account for base pool's swap fees
      const minReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(999)
        .div(1000)

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [usdc, susd])

      // User 1 successfully initiates swap
      await metaSwapDeposit
        .connect(user1)
        .swap(2, 0, String(1e5), minReturnWithNegativeSlippage, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [usdc, susd])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e5)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        "99879055412162421",
      )
    })

    it("From 18 decimal token (meta) to 6 decimal token (base)", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapDeposit.calculateSwap(
        0,
        2,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99878"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [susd, usdc])

      // User 1 successfully initiates swap
      await metaSwapDeposit
        .connect(user1)
        .swap(0, 2, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [susd, usdc])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("From 18 decimal token (base) to 6 decimal token (base)", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapDeposit.calculateSwap(
        1,
        3,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99959"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [dai, usdt])

      // User 1 successfully initiates swap
      await metaSwapDeposit
        .connect(user1)
        .swap(1, 3, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [dai, usdt])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })
  })

  describe("addLiquidity", () => {
    it("Reverts when deadline is not met", async () => {
      const tokenDepositAmounts = [
        String(3e18),
        String(1e18),
        String(1e6),
        String(1e6),
      ]
      const blockTimestamp = await getCurrentBlockTimestamp()
      await expect(
        metaSwapDeposit.addLiquidity(
          tokenDepositAmounts,
          0,
          blockTimestamp - 100,
        ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Reverts when minToMint is not met", async () => {
      const tokenDepositAmounts = [
        String(3e18),
        String(1e18),
        String(1e6),
        String(1e6),
      ]
      await expect(
        metaSwapDeposit.addLiquidity(
          tokenDepositAmounts,
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Couldn't mint min requested")
    })

    it("Succeeds when depositing balanced amounts", async () => {
      // In this example, the MetaSwap pool has the two following tokens
      // [susd, usdLPToken]
      // MetaSwapDeposit flattens the tokens so that users can add/remove liquidity easier
      // [susd, dai, usdc, usdt]
      const tokenDepositAmounts = [
        String(3e18),
        String(1e18),
        String(1e6),
        String(1e6),
      ]
      const minToMint = await metaSwapDeposit.calculateTokenAmount(
        tokenDepositAmounts,
        true,
      )
      expect(minToMint).to.eq(String(6e18))

      const balanceBefore = await getUserTokenBalance(ownerAddress, metaLPToken)
      await metaSwapDeposit.addLiquidity(
        tokenDepositAmounts,
        minToMint,
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, metaLPToken)

      expect(balanceAfter.sub(balanceBefore)).to.eq(String(6e18))
    })

    it("Succeeds when depositing imbalanced amounts", async () => {
      const tokenDepositAmounts = [
        String(1e18),
        String(1e18),
        String(0),
        String(1e6),
      ]
      const minToMint = await metaSwapDeposit.calculateTokenAmount(
        tokenDepositAmounts,
        true,
      )
      expect(minToMint).to.eq(String("2999951149277191084"))

      const balanceBefore = await getUserTokenBalance(ownerAddress, metaLPToken)
      const returnValue = await metaSwapDeposit.callStatic.addLiquidity(
        tokenDepositAmounts,
        minToMint.mul(999).div(1000),
        MAX_UINT256,
      )
      await metaSwapDeposit.addLiquidity(
        tokenDepositAmounts,
        minToMint.mul(999).div(1000),
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, metaLPToken)

      // Due to inaccurate fee calculations on imbalanced deposits/withdraws, there is some slippage
      // 2999252268028841201 / 2999951149277191084 = 0.99976703598 (-0.024% of expected)
      expect(balanceAfter.sub(balanceBefore)).to.eq(
        String("2999252268028841201"),
      )
      expect(returnValue).to.eq("2999252268028841201")
    })

    it("Succeeds when depositing single token (meta swap level)", async () => {
      const tokenDepositAmounts = [
        String(1e18),
        String(0),
        String(0),
        String(0),
      ]
      const minToMint = await metaSwapDeposit.calculateTokenAmount(
        tokenDepositAmounts,
        true,
      )
      expect(minToMint).to.eq(String("999951223098644936"))

      const balanceBefore = await getUserTokenBalance(ownerAddress, metaLPToken)
      await metaSwapDeposit.addLiquidity(
        tokenDepositAmounts,
        minToMint.mul(999).div(1000),
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, metaLPToken)

      // Due to inaccurate fee calculations on imbalanced deposits/withdraws, there is some slippage
      // 999451222979682477 / 999951223098644936 = 0.99949997549 (-0.05% of expected)
      expect(balanceAfter.sub(balanceBefore)).to.eq(
        String("999451222979682477"),
      )
    })

    it("Succeeds when depositing single token (base swap level)", async () => {
      const tokenDepositAmounts = [String(0), String(1e6), String(0), String(0)]
      const minToMint = await metaSwapDeposit.calculateTokenAmount(
        tokenDepositAmounts,
        true,
      )
      expect(minToMint).to.eq(String("1000000"))

      const balanceBefore = await getUserTokenBalance(ownerAddress, metaLPToken)
      await metaSwapDeposit.addLiquidity(
        tokenDepositAmounts,
        minToMint.mul(999).div(1000),
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, metaLPToken)

      // Due to inaccurate fee calculations on imbalanced deposits/withdraws, there is some slippage
      // 999402 / 1000000 = 0.999402 (-0.06% of expected)
      expect(balanceAfter.sub(balanceBefore)).to.eq(String("999402"))
    })
  })

  describe("removeLiquidity", () => {
    beforeEach(async () => {
      // Add more liquidity to test with
      await metaSwapDeposit.addLiquidity(
        [String(3e18), String(1e18), String(0), String(0)],
        0,
        MAX_UINT256,
      )
    })

    it("Reverts when minAmounts are not reached", async () => {
      // meta swap level minAmounts not reached
      await expect(
        metaSwapDeposit.removeLiquidity(
          String(1e18),
          [String(6e18), 0, 0, 0],
          MAX_UINT256,
        ),
      ).to.be.reverted
      // base swap level minAmounts not reached
      await expect(
        metaSwapDeposit.removeLiquidity(
          String(1e18),
          [0, String(6e18), 0, 0],
          MAX_UINT256,
        ),
      ).to.be.reverted
    })

    it("Reverts when deadline is not met", async () => {
      const blockTimestamp = await getCurrentBlockTimestamp()
      await expect(
        metaSwapDeposit.removeLiquidity(
          String(1e18),
          [0, 0, 0, 0],
          blockTimestamp - 100,
        ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Reverts when minAmounts array length is too big", async () => {
      await expect(
        metaSwapDeposit.removeLiquidity(
          String(1e18),
          [0, 0, 0, 0, 0],
          MAX_UINT256,
        ),
      ).to.be.revertedWith("out of range")
    })

    it("Succeeds with expected minAmounts", async () => {
      const minAmounts = await metaSwapDeposit.calculateRemoveLiquidity(
        String(1e18),
      )
      expect(minAmounts[0]).to.eq("504905403408763500")
      expect(minAmounts[1]).to.eq("165399818069810691")
      expect(minAmounts[2]).to.eq("164850")
      expect(minAmounts[3]).to.eq("164850")

      const balancesBefore = await getUserTokenBalances(ownerAddress, allTokens)
      const returnValues = await metaSwapDeposit.callStatic.removeLiquidity(
        String(1e18),
        minAmounts,
        MAX_UINT256,
      )
      await metaSwapDeposit.removeLiquidity(
        String(1e18),
        minAmounts,
        MAX_UINT256,
      )
      const balancesAfter = await getUserTokenBalances(ownerAddress, allTokens)

      // Check the return value of the function matches the actual amounts that are withdrawn from the pool
      expect(balancesAfter[0].sub(balancesBefore[0])).to.eq(
        "504905403408763500",
      )
      expect(returnValues[0]).to.eq("504905403408763500")
      expect(balancesAfter[1].sub(balancesBefore[1])).to.eq(
        "165399818069810691",
      )
      expect(returnValues[1]).to.eq("165399818069810691")
      expect(balancesAfter[2].sub(balancesBefore[2])).to.eq("164850")
      expect(returnValues[2]).to.eq("164850")
      expect(balancesAfter[3].sub(balancesBefore[3])).to.eq("164850")
      expect(returnValues[3]).to.eq("164850")
    })
  })

  describe("removeLiquidityOneToken", () => {
    beforeEach(async () => {
      // Add more liquidity to test with
      await metaSwapDeposit.addLiquidity(
        [String(3e18), String(1e18), String(0), String(0)],
        0,
        MAX_UINT256,
      )
    })

    it("Reverts when minAmount is not reached", async () => {
      await expect(
        metaSwapDeposit.removeLiquidityOneToken(
          String(1e18),
          0,
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("dy < minAmount")
    })

    it("Reverts when deadline is not met", async () => {
      const blockTimestamp = await getCurrentBlockTimestamp()
      await expect(
        metaSwapDeposit.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          blockTimestamp - 100,
        ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Reverts when index is out of range", async () => {
      await expect(
        metaSwapDeposit.removeLiquidityOneToken(
          String(1e18),
          10,
          0,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("out of range")
    })

    it("Succeeds when withdrawing via a meta level token", async () => {
      const minAmount = await metaSwapDeposit.calculateRemoveLiquidityOneToken(
        String(1e18),
        0,
      )
      const returnValue =
        await metaSwapDeposit.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          minAmount,
          MAX_UINT256,
        )

      const balanceBefore = await getUserTokenBalance(ownerAddress, susd)
      await metaSwapDeposit.removeLiquidityOneToken(
        String(1e18),
        0,
        minAmount,
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, susd)

      // Check the return value matches the amount withdrawn
      expect(balanceAfter.sub(balanceBefore)).to.eq("999653671541279835")
      expect(returnValue).to.eq("999653671541279835")
    })

    it("Succeeds when withdrawing via a base level token", async () => {
      const minAmount = await metaSwapDeposit.calculateRemoveLiquidityOneToken(
        String(1e18),
        2,
      )
      const returnValue =
        await metaSwapDeposit.callStatic.removeLiquidityOneToken(
          String(1e18),
          2,
          minAmount,
          MAX_UINT256,
        )

      const balanceBefore = await getUserTokenBalance(ownerAddress, usdc)
      await metaSwapDeposit.removeLiquidityOneToken(
        String(1e18),
        2,
        minAmount,
        MAX_UINT256,
      )
      const balanceAfter = await getUserTokenBalance(ownerAddress, usdc)

      // Check the return value matches the amount withdrawn
      expect(balanceAfter.sub(balanceBefore)).to.eq("999056")
      expect(returnValue).to.eq("999056")
    })
  })

  describe("removeLiquidityImbalance", () => {
    beforeEach(async () => {
      // Add more liquidity to test with
      await metaSwapDeposit.addLiquidity(
        [String(3e18), String(1e18), String(0), String(0)],
        0,
        MAX_UINT256,
      )
    })

    it("Reverts when maxBurnAmount is exceeded", async () => {
      const maxBurnAmount = 1
      await expect(
        metaSwapDeposit.removeLiquidityImbalance(
          [String(1e18), String(1e18), String(0), String(0)],
          maxBurnAmount,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("tokenAmount > maxBurnAmount")
    })

    it("Reverts when deadline is not met", async () => {
      const blockTimestamp = await getCurrentBlockTimestamp()
      await expect(
        metaSwapDeposit.removeLiquidityImbalance(
          [String(1e18), String(1e18), String(0), String(0)],
          String(2e18),
          blockTimestamp - 100,
        ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Reverts when amounts array length is too big", async () => {
      await expect(
        metaSwapDeposit.removeLiquidityImbalance(
          [String(1e18), String(1e18), String(0), String(0), String(0)],
          String(2e18),
          MAX_UINT256,
        ),
      ).to.be.revertedWith("out of range")
    })

    it("Reverts when slippage setting is 0%", async () => {
      // Due to the inaccuracy of swap fee calculation on imbalanced withdrawls, maxBurnAmount should always use a slippage
      // setting that is at least 0.1% when withdrawing meta-level tokens and 0.2% when withdrawing base-level tokens.
      const amounts = [String(1e18), String(0), String(0), String(0)]
      const maxBurnAmount = await metaSwapDeposit.calculateTokenAmount(
        amounts,
        false,
      )
      await expect(
        metaSwapDeposit.removeLiquidityImbalance(
          amounts,
          maxBurnAmount,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("tokenAmount > maxBurnAmount")
    })

    it("Succeeds when only withdrawing meta-level tokens", async () => {
      const amounts = [String(1e18), String(0), String(0), String(0)]

      // Apply 0.1% slippage
      const maxBurnAmount = (
        await metaSwapDeposit.calculateTokenAmount(amounts, false)
      )
        .mul(1001)
        .div(1000)
      expect(maxBurnAmount).to.eq("1000850974852926461")

      // Balances before the call
      const tokens = [susd, dai, usdc, usdt, metaLPToken]
      const balancesBefore = await getUserTokenBalances(ownerAddress, tokens)

      // Perform the call
      const returnValues =
        await metaSwapDeposit.callStatic.removeLiquidityImbalance(
          amounts,
          maxBurnAmount,
          MAX_UINT256,
        )
      await metaSwapDeposit.removeLiquidityImbalance(
        amounts,
        maxBurnAmount,
        MAX_UINT256,
      )

      // Balances after the call
      const balancesAfter = await getUserTokenBalances(ownerAddress, tokens)

      // The return value matches the amount of meta LP token burned
      expect(returnValues).to.eq("1000346219661929705")
      expect(balancesBefore[4].sub(balancesAfter[4])).to.eq(
        "1000346219661929705",
      )

      // Check user's balances increased in desired amounts
      expect(balancesAfter[0].sub(balancesBefore[0])).to.eq(amounts[0])
      expect(balancesAfter[1].sub(balancesBefore[1])).to.eq(amounts[1])
      expect(balancesAfter[2].sub(balancesBefore[2])).to.eq(amounts[2])
      expect(balancesAfter[3].sub(balancesBefore[3])).to.eq(amounts[3])
    })

    it("Succeeds when only withdrawing base-level tokens", async () => {
      const amounts = [String(0), String(1e18), String(1e6), String(0)]

      // Apply 0.2% slippage
      const maxBurnAmount = (
        await metaSwapDeposit.calculateTokenAmount(amounts, false)
      )
        .mul(1002)
        .div(1000)
      expect(maxBurnAmount).to.eq("2004575797776447634")

      // Balances before the call
      const tokens = [susd, dai, usdc, usdt, metaLPToken]
      const balancesBefore = await getUserTokenBalances(ownerAddress, tokens)

      // Perform the call
      const returnValues =
        await metaSwapDeposit.callStatic.removeLiquidityImbalance(
          amounts,
          maxBurnAmount,
          MAX_UINT256,
        )
      await metaSwapDeposit.removeLiquidityImbalance(
        amounts,
        maxBurnAmount,
        MAX_UINT256,
      )

      // Balances after the call
      const balancesAfter = await getUserTokenBalances(ownerAddress, tokens)

      // The return value matches the amount of meta LP token burned
      expect(returnValues).to.eq("2001784227476244931")
      expect(balancesBefore[4].sub(balancesAfter[4])).to.eq(
        "2001784227476244931",
      )

      // Check the user's balances increased in desired amounts
      expect(balancesAfter[0].sub(balancesBefore[0])).to.eq(amounts[0])
      expect(balancesAfter[1].sub(balancesBefore[1])).to.eq(amounts[1])
      expect(balancesAfter[2].sub(balancesBefore[2])).to.eq(amounts[2])
      expect(balancesAfter[3].sub(balancesBefore[3])).to.eq(amounts[3])
    })

    it("Succeeds when withdrawing both meta-level and base-level tokens", async () => {
      const amounts = [String(1e18), String(0), String(1e6), String(1e6)]

      // Apply 0.2% slippage
      const maxBurnAmount = (
        await metaSwapDeposit.calculateTokenAmount(amounts, false)
      )
        .mul(1002)
        .div(1000)
      expect(maxBurnAmount).to.eq("3006234092570322430")

      // Balances before the call
      const tokens = [susd, dai, usdc, usdt, metaLPToken]
      const balancesBefore = await getUserTokenBalances(ownerAddress, tokens)

      // Perform the call
      const returnValues =
        await metaSwapDeposit.callStatic.removeLiquidityImbalance(
          amounts,
          maxBurnAmount,
          MAX_UINT256,
        )
      await metaSwapDeposit.removeLiquidityImbalance(
        amounts,
        maxBurnAmount,
        MAX_UINT256,
      )

      // Balances after the call
      const balancesAfter = await getUserTokenBalances(ownerAddress, tokens)

      // The return value matches the amount of meta LP token burned
      expect(returnValues).to.eq("3000949526037631237")
      expect(balancesBefore[4].sub(balancesAfter[4])).to.eq(
        "3000949526037631237",
      )

      // Check the user's balances increased in desired amounts
      expect(balancesAfter[0].sub(balancesBefore[0])).to.eq(amounts[0])
      expect(balancesAfter[1].sub(balancesBefore[1])).to.eq(amounts[1])
      expect(balancesAfter[2].sub(balancesBefore[2])).to.eq(amounts[2])
      expect(balancesAfter[3].sub(balancesBefore[3])).to.eq(amounts[3])
    })
  })
})
