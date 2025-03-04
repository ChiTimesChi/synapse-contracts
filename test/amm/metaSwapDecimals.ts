import { BigNumber, Signer, Wallet } from "ethers"
import {
  MAX_UINT256,
  TIME,
  ZERO_ADDRESS,
  asyncForEach,
  deployContractWithLibraries,
  getCurrentBlockTimestamp,
  getUserTokenBalance,
  getUserTokenBalances,
  setNextTimestamp,
  setTimestamp,
  forceAdvanceOneBlock,
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
import { MetaSwapUtils } from "../../build/typechain/MetaSwapUtils"
import MetaSwapUtilsArtifact from "../../build/artifacts/contracts/amm/meta/MetaSwapUtils.sol/MetaSwapUtils.json"
import chai from "chai"

chai.use(solidity)
const { expect } = chai

describe("Meta-Swap", async () => {
  let signers: Array<Signer>
  let baseSwap: Swap
  let metaSwap: MetaSwap
  let metaSwapUtils: MetaSwapUtils
  let dummyUSD: GenericERC20
  let dai: GenericERC20
  let usdc: GenericERC20
  let usdt: GenericERC20
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
      dummyUSD = (await deployContract(owner as Wallet, GenericERC20Artifact, [
        "Dummy USD",
        "dummyUSD",
        "6",
      ])) as GenericERC20

      // Mint tokens
      await asyncForEach(
        [ownerAddress, user1Address, user2Address],
        async (address) => {
          await dai.mint(address, BigNumber.from(10).pow(18).mul(100000))
          await usdc.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await usdt.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await dummyUSD.mint(address, BigNumber.from(10).pow(6).mul(100000))
        },
      )

      // Deploy MetaSwapUtils
      metaSwapUtils = (await deployContract(
        owner,
        MetaSwapUtilsArtifact,
      )) as MetaSwapUtils
      await metaSwapUtils.deployed()

      // Deploy Swap with SwapUtils library
      metaSwap = (await deployContractWithLibraries(owner, MetaSwapArtifact, {
        SwapUtils: (await get("SwapUtils")).address,
        MetaSwapUtils: metaSwapUtils.address,
        AmplificationUtils: (await get("AmplificationUtils")).address,
      })) as MetaSwap
      await metaSwap.deployed()

      // Set approvals
      await asyncForEach([owner, user1, user2], async (signer) => {
        await dummyUSD.connect(signer).approve(metaSwap.address, MAX_UINT256)
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
      // Manually overload the signature
      await metaSwap.initializeMetaSwap(
        [dummyUSD.address, baseLPToken.address],
        [6, 18],
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

      // Add liquidity to the meta swap pool
      await metaSwap.addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)

      expect(await dummyUSD.balanceOf(metaSwap.address)).to.eq(String(1e6))
      expect(await baseLPToken.balanceOf(metaSwap.address)).to.eq(String(1e18))
    },
  )

  beforeEach(async () => {
    await setupTest()
  })

  describe("swapStorage", () => {
    describe("lpToken", async () => {
      it("Returns correct lpTokenName", async () => {
        expect(await metaLPToken.name()).to.eq(LP_TOKEN_NAME)
      })

      it("Returns correct lpTokenSymbol", async () => {
        expect(await metaLPToken.symbol()).to.eq(LP_TOKEN_SYMBOL)
      })
    })

    describe("A", async () => {
      it("Returns correct A value", async () => {
        expect(await metaSwap.getA()).to.eq(INITIAL_A_VALUE)
        expect(await metaSwap.getAPrecise()).to.eq(INITIAL_A_VALUE * 100)
      })
    })

    describe("fee", async () => {
      it("Returns correct fee value", async () => {
        expect((await metaSwap.swapStorage()).swapFee).to.eq(SWAP_FEE)
      })
    })

    describe("adminFee", async () => {
      it("Returns correct adminFee value", async () => {
        expect((await metaSwap.swapStorage()).adminFee).to.eq(0)
      })
    })
  })

  describe("getToken", () => {
    it("Returns correct addresses of pooled tokens", async () => {
      expect(await metaSwap.getToken(0)).to.eq(dummyUSD.address)
      expect(await metaSwap.getToken(1)).to.eq(baseLPToken.address)
    })

    it("Reverts when index is out of range", async () => {
      await expect(metaSwap.getToken(2)).to.be.reverted
    })
  })

  describe("getTokenIndex", () => {
    it("Returns correct token indexes", async () => {
      expect(await metaSwap.getTokenIndex(dummyUSD.address)).to.be.eq(0)
      expect(await metaSwap.getTokenIndex(baseLPToken.address)).to.be.eq(1)
    })

    it("Reverts when token address is not found", async () => {
      await expect(metaSwap.getTokenIndex(ZERO_ADDRESS)).to.be.revertedWith(
        "Token does not exist",
      )
    })
  })

  describe("getTokenBalance", () => {
    it("Returns correct balances of pooled tokens", async () => {
      expect(await metaSwap.getTokenBalance(0)).to.eq(
        BigNumber.from(String(1e6)),
      )
      expect(await metaSwap.getTokenBalance(1)).to.eq(
        BigNumber.from(String(1e18)),
      )
    })

    it("Reverts when index is out of range", async () => {
      await expect(metaSwap.getTokenBalance(2)).to.be.reverted
    })
  })

  describe("getA", () => {
    it("Returns correct value", async () => {
      expect(await metaSwap.getA()).to.eq(INITIAL_A_VALUE)
    })
  })

  describe("addLiquidity", () => {
    it("Reverts when contract is paused", async () => {
      await metaSwap.pause()

      await expect(
        metaSwap
          .connect(user1)
          .addLiquidity([String(1e6), String(3e18)], 0, MAX_UINT256),
      ).to.be.reverted

      // unpause
      await metaSwap.unpause()

      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(3e18)], 0, MAX_UINT256)

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("3991672381321833910"))
    })

    it("Reverts with 'Amounts must match pooled tokens'", async () => {
      await expect(
        metaSwap.connect(user1).addLiquidity([String(1e16)], 0, MAX_UINT256),
      ).to.be.revertedWith("Amounts must match pooled tokens")
    })

    it("Reverts with 'Cannot withdraw more than available'", async () => {
      await expect(
        metaSwap
          .connect(user1)
          .calculateTokenAmount([MAX_UINT256, String(3e18)], false),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Reverts with 'Must supply all tokens in pool'", async () => {
      metaLPToken.approve(metaSwap.address, String(2e18))
      await metaSwap.removeLiquidity(String(2e18), [0, 0], MAX_UINT256)
      await expect(
        metaSwap
          .connect(user1)
          .addLiquidity([0, String(3e18)], MAX_UINT256, MAX_UINT256),
      ).to.be.revertedWith("Must supply all tokens in pool")
    })

    it("Succeeds with expected output amount of pool tokens", async () => {
      const calculatedPoolTokenAmount = await metaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e6), String(3e18)], true)

      const calculatedPoolTokenAmountWithSlippage = calculatedPoolTokenAmount
        .mul(999)
        .div(1000)

      await metaSwap
        .connect(user1)
        .addLiquidity(
          [String(1e6), String(3e18)],
          calculatedPoolTokenAmountWithSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      // The actual pool token amount is less than 4e18 due to the imbalance of the underlying tokens
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("3991672381321833910"))
    })

    it("Succeeds with actual pool token amount being within ±0.1% range of calculated pool token", async () => {
      const calculatedPoolTokenAmount = await metaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e6), String(3e18)], true)

      const calculatedPoolTokenAmountWithNegativeSlippage =
        calculatedPoolTokenAmount.mul(999).div(1000)

      const calculatedPoolTokenAmountWithPositiveSlippage =
        calculatedPoolTokenAmount.mul(1001).div(1000)

      await metaSwap
        .connect(user1)
        .addLiquidity(
          [String(1e6), String(3e18)],
          calculatedPoolTokenAmountWithNegativeSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      expect(actualPoolTokenAmount).to.gte(
        calculatedPoolTokenAmountWithNegativeSlippage,
      )

      expect(actualPoolTokenAmount).to.lte(
        calculatedPoolTokenAmountWithPositiveSlippage,
      )
    })

    it("Succeeds with correctly updated tokenBalance after imbalanced deposit", async () => {
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(3e18)], 0, MAX_UINT256)

      // Check updated token balance
      expect(await metaSwap.getTokenBalance(0)).to.eq(
        BigNumber.from(String(2e6)),
      )
      expect(await metaSwap.getTokenBalance(1)).to.eq(
        BigNumber.from(String(4e18)),
      )
    })

    it("Returns correct minted lpToken amount", async () => {
      const mintedAmount = await metaSwap
        .connect(user1)
        .callStatic.addLiquidity([String(1e6), String(2e18)], 0, MAX_UINT256)

      expect(mintedAmount).to.eq("2997460266967704873")
    })

    it("Reverts when minToMint is not reached due to front running", async () => {
      const calculatedLPTokenAmount = await metaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e6), String(3e18)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      // Someone else deposits thus front running user 1's deposit
      await metaSwap.addLiquidity([String(1e6), String(3e18)], 0, MAX_UINT256)

      await expect(
        metaSwap
          .connect(user1)
          .addLiquidity(
            [String(1e6), String(3e18)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      await expect(
        metaSwap
          .connect(user1)
          .addLiquidity(
            [String(2e18), String(1e16)],
            0,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits addLiquidity event", async () => {
      const calculatedLPTokenAmount = await metaSwap
        .connect(user1)
        .calculateTokenAmount([String(2e6), String(1e16)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      await expect(
        metaSwap
          .connect(user1)
          .addLiquidity(
            [String(2e6), String(1e16)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.emit(metaSwap.connect(user1), "AddLiquidity")
    })
  })

  describe("removeLiquidity", () => {
    it("Reverts with 'Cannot exceed total supply'", async () => {
      await expect(
        metaSwap.calculateRemoveLiquidity(MAX_UINT256),
      ).to.be.revertedWith("Cannot exceed total supply")
    })

    it("Reverts with 'minAmounts must match poolTokens'", async () => {
      await expect(
        metaSwap.removeLiquidity(String(2e18), [0], MAX_UINT256),
      ).to.be.revertedWith("minAmounts must match poolTokens")
    })

    it("Succeeds even when contract is paused", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // Owner pauses the contract
      await metaSwap.pause()

      // Owner and user 1 try to remove liquidity
      metaLPToken.approve(metaSwap.address, String(2e18))
      metaLPToken.connect(user1).approve(metaSwap.address, currentUser1Balance)

      await metaSwap.removeLiquidity(String(2e18), [0, 0], MAX_UINT256)
      await metaSwap
        .connect(user1)
        .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256)
      expect(await dummyUSD.balanceOf(metaSwap.address)).to.eq(0)
      expect(await baseLPToken.balanceOf(metaSwap.address)).to.eq(0)
    })

    it("Succeeds with expected return amounts of underlying tokens", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)

      const [
        firstTokenBalanceBefore,
        secondTokenBalanceBefore,
        poolTokenBalanceBefore,
      ] = await getUserTokenBalances(user1, [
        dummyUSD,
        baseLPToken,
        metaLPToken,
      ])

      expect(poolTokenBalanceBefore).to.eq(
        BigNumber.from("1996275943410518065"),
      )

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await metaSwap.calculateRemoveLiquidity(poolTokenBalanceBefore)

      expect(expectedFirstTokenAmount).to.eq(BigNumber.from("1498602"))
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("504529399720059524"),
      )

      // User 1 removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, poolTokenBalanceBefore)
      await metaSwap
        .connect(user1)
        .removeLiquidity(
          poolTokenBalanceBefore,
          [expectedFirstTokenAmount, expectedSecondTokenAmount],
          MAX_UINT256,
        )

      const [firstTokenBalanceAfter, secondTokenBalanceAfter] =
        await getUserTokenBalances(user1, [dummyUSD, baseLPToken])

      // Check the actual returned token amounts match the expected amounts
      expect(firstTokenBalanceAfter.sub(firstTokenBalanceBefore)).to.eq(
        expectedFirstTokenAmount,
      )
      expect(secondTokenBalanceAfter.sub(secondTokenBalanceBefore)).to.eq(
        expectedSecondTokenAmount,
      )
    })

    it("Returns correct amounts of received tokens", async () => {
      const metaLPTokenBalance = await metaLPToken.balanceOf(ownerAddress)

      await metaLPToken.approve(metaSwap.address, MAX_UINT256)
      const removedTokenAmounts = await metaSwap.callStatic.removeLiquidity(
        metaLPTokenBalance,
        [0, 0],
        MAX_UINT256,
      )

      expect(removedTokenAmounts[0]).to.eq(String(1e6))
      expect(removedTokenAmounts[1]).to.eq(String(1e18))
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance.add(1),
            [MAX_UINT256, MAX_UINT256],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await metaSwap.calculateRemoveLiquidity(currentUser1Balance)

      expect(expectedFirstTokenAmount).to.eq(BigNumber.from("1498602"))
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("504529399720059524"),
      )

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await metaSwap
        .connect(user2)
        .addLiquidity([String(1e4), String(2e18)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance,
            [expectedFirstTokenAmount, expectedSecondTokenAmount],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance,
            [0, 0],
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits removeLiquidity event", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 tries removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256),
      ).to.emit(metaSwap.connect(user1), "RemoveLiquidity")
    })
  })

  describe("removeLiquidityImbalance", () => {
    it("Reverts when contract is paused", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // Owner pauses the contract
      await metaSwap.pause()

      // Owner and user 1 try to initiate imbalanced liquidity withdrawal
      metaLPToken.approve(metaSwap.address, MAX_UINT256)
      metaLPToken.connect(user1).approve(metaSwap.address, MAX_UINT256)

      await expect(
        metaSwap.removeLiquidityImbalance(
          [String(1e6), String(1e16)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.reverted

      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e6), String(1e16)],
            MAX_UINT256,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts with 'Amounts should match pool tokens'", async () => {
      await expect(
        metaSwap.removeLiquidityImbalance(
          [String(1e18)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Amounts should match pool tokens")
    })

    it("Reverts with 'Cannot withdraw more than available'", async () => {
      await expect(
        metaSwap.removeLiquidityImbalance(
          [MAX_UINT256, MAX_UINT256],
          1,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Succeeds with calculated max amount of pool token to be burned (±0.1%)", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // User 1 calculates amount of pool token to be burned
      const maxPoolTokenAmountToBeBurned = await metaSwap.calculateTokenAmount(
        [String(1e6), String(1e16)],
        false,
      )

      // ±0.1% range of pool token to be burned
      const maxPoolTokenAmountToBeBurnedNegativeSlippage =
        maxPoolTokenAmountToBeBurned.mul(1001).div(1000)
      const maxPoolTokenAmountToBeBurnedPositiveSlippage =
        maxPoolTokenAmountToBeBurned.mul(999).div(1000)

      const [
        firstTokenBalanceBefore,
        secondTokenBalanceBefore,
        poolTokenBalanceBefore,
      ] = await getUserTokenBalances(user1, [
        dummyUSD,
        baseLPToken,
        metaLPToken,
      ])

      // User 1 withdraws imbalanced tokens
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, maxPoolTokenAmountToBeBurnedNegativeSlippage)
      await metaSwap
        .connect(user1)
        .removeLiquidityImbalance(
          [String(1e6), String(1e16)],
          maxPoolTokenAmountToBeBurnedNegativeSlippage,
          MAX_UINT256,
        )

      const [
        firstTokenBalanceAfter,
        secondTokenBalanceAfter,
        poolTokenBalanceAfter,
      ] = await getUserTokenBalances(user1, [
        dummyUSD,
        baseLPToken,
        metaLPToken,
      ])

      // Check the actual returned token amounts match the requested amounts
      expect(firstTokenBalanceAfter.sub(firstTokenBalanceBefore)).to.eq(
        String(1e6),
      )
      expect(secondTokenBalanceAfter.sub(secondTokenBalanceBefore)).to.eq(
        String(1e16),
      )

      // Check the actual burned pool token amount
      const actualPoolTokenBurned = poolTokenBalanceBefore.sub(
        poolTokenBalanceAfter,
      )

      expect(actualPoolTokenBurned).to.eq(String("1000933957237188886"))
      expect(actualPoolTokenBurned).to.gte(
        maxPoolTokenAmountToBeBurnedPositiveSlippage,
      )
      expect(actualPoolTokenBurned).to.lte(
        maxPoolTokenAmountToBeBurnedNegativeSlippage,
      )
    })

    it("Returns correct amount of burned lpToken", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 removes liquidity
      await metaLPToken.connect(user1).approve(metaSwap.address, MAX_UINT256)

      const burnedLPTokenAmount = await metaSwap
        .connect(user1)
        .callStatic.removeLiquidityImbalance(
          [String(1e6), String(1e16)],
          currentUser1Balance,
          MAX_UINT256,
        )

      expect(burnedLPTokenAmount).eq("1000933957237188886")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e6), String(1e16)],
            currentUser1Balance.add(1),
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // User 1 calculates amount of pool token to be burned
      const maxPoolTokenAmountToBeBurned = await metaSwap.calculateTokenAmount(
        [String(1e6), String(1e16)],
        false,
      )

      // Calculate +0.1% of pool token to be burned
      const maxPoolTokenAmountToBeBurnedNegativeSlippage =
        maxPoolTokenAmountToBeBurned.mul(1001).div(1000)

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await metaSwap
        .connect(user2)
        .addLiquidity([String(1e4), String(1e20)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, maxPoolTokenAmountToBeBurnedNegativeSlippage)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e6), String(1e16)],
            maxPoolTokenAmountToBeBurnedNegativeSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e6), String(1e16)],
            currentUser1Balance,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits RemoveLiquidityImbalance event", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 removes liquidity
      await metaLPToken.connect(user1).approve(metaSwap.address, MAX_UINT256)

      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e6), String(1e16)],
            currentUser1Balance,
            MAX_UINT256,
          ),
      ).to.emit(metaSwap.connect(user1), "RemoveLiquidityImbalance")
    })
  })

  describe("removeLiquidityOneToken", () => {
    it("Reverts when contract is paused.", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // Owner pauses the contract
      await metaSwap.pause()

      // Owner and user 1 try to remove liquidity via single token
      metaLPToken.approve(metaSwap.address, String(2e18))
      metaLPToken.connect(user1).approve(metaSwap.address, currentUser1Balance)

      await expect(
        metaSwap.removeLiquidityOneToken(String(2e18), 0, 0, MAX_UINT256),
      ).to.be.reverted
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwap.calculateRemoveLiquidityOneToken(1, 5),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Withdraw exceeds available'", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      await expect(
        metaSwap.calculateRemoveLiquidityOneToken(
          currentUser1Balance.mul(2),
          0,
        ),
      ).to.be.revertedWith("Withdraw exceeds available")
    })

    it("Reverts with 'Token not found'", async () => {
      await expect(
        metaSwap.connect(user1).removeLiquidityOneToken(0, 9, 1, MAX_UINT256),
      ).to.be.revertedWith("Token not found")
    })

    it("Succeeds with calculated token amount as minAmount", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await metaSwap.calculateRemoveLiquidityOneToken(currentUser1Balance, 0)
      expect(calculatedFirstTokenAmount).to.eq(BigNumber.from("2008990"))

      // User 1 initiates one token withdrawal
      const before = await dummyUSD.balanceOf(user1Address)
      metaLPToken.connect(user1).approve(metaSwap.address, currentUser1Balance)
      await metaSwap
        .connect(user1)
        .removeLiquidityOneToken(
          currentUser1Balance,
          0,
          calculatedFirstTokenAmount,
          MAX_UINT256,
        )
      const after = await dummyUSD.balanceOf(user1Address)

      expect(after.sub(before)).to.eq(BigNumber.from("2008990"))
    })

    it("Returns correct amount of received token", async () => {
      await metaLPToken.approve(metaSwap.address, MAX_UINT256)
      const removedTokenAmount =
        await metaSwap.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          MAX_UINT256,
        )
      expect(removedTokenAmount).to.eq("954404")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance.add(1),
            0,
            0,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmount of underlying token is not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275943410518065"))

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await metaSwap.calculateRemoveLiquidityOneToken(currentUser1Balance, 0)
      expect(calculatedFirstTokenAmount).to.eq(BigNumber.from("2008990"))

      // User 2 adds liquidity before User 1 initiates withdrawal
      await metaSwap
        .connect(user2)
        .addLiquidity([String(1e4), String(1e20)], 0, MAX_UINT256)

      // User 1 initiates one token withdrawal
      metaLPToken.connect(user1).approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance,
            0,
            calculatedFirstTokenAmount,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance,
            0,
            0,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits RemoveLiquidityOne event", async () => {
      // User 1 adds liquidity
      await metaSwap
        .connect(user1)
        .addLiquidity([String(2e6), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, currentUser1Balance)
      await expect(
        metaSwap
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.emit(metaSwap.connect(user1), "RemoveLiquidityOne")
    })
  })

  describe("swap", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await metaSwap.pause()

      // User 1 try to initiate swap
      await expect(
        metaSwap.connect(user1).swap(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwap.calculateSwap(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Cannot swap more than you own'", async () => {
      await expect(
        metaSwap.connect(user1).swap(0, 1, MAX_UINT256, 0, MAX_UINT256),
      ).to.be.revertedWith("Cannot swap more than you own")
    })

    it("Succeeds with expected swap amounts", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwap.calculateSwap(
        0,
        1,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99702611562565289"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [dummyUSD, baseLPToken])

      // User 1 successfully initiates swap
      await metaSwap
        .connect(user1)
        .swap(0, 1, String(1e5), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [dummyUSD, baseLPToken])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e5)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("Reverts when minDy (minimum amount token to receive) is not reached due to front running", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwap.calculateSwap(
        0,
        1,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99702611562565289"))

      // User 2 swaps before User 1 does
      await metaSwap.connect(user2).swap(0, 1, String(1e5), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        metaSwap
          .connect(user1)
          .swap(0, 1, String(1e5), calculatedSwapReturn, MAX_UINT256),
      ).to.be.reverted
    })

    it("Succeeds when using lower minDy even when transaction is front-ran", async () => {
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn = await metaSwap.calculateSwap(
        0,
        1,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99702611562565289"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [dummyUSD, baseLPToken])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(99)
        .div(100)

      // User 2 swaps before User 1 does
      await metaSwap.connect(user2).swap(0, 1, String(1e5), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 1% slippage from initial calculated amount
      await metaSwap
        .connect(user1)
        .swap(
          0,
          1,
          String(1e5),
          calculatedSwapReturnWithNegativeSlippage,
          MAX_UINT256,
        )

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [dummyUSD, baseLPToken])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e5)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("99286252365528551"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token", async () => {
      const swapReturnAmount = await metaSwap.callStatic.swap(
        0,
        1,
        String(1e6),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("908591742545002306")
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        metaSwap
          .connect(user1)
          .swap(0, 1, String(1e5), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      // User 1 initiates swap
      await expect(
        metaSwap.connect(user1).swap(0, 1, String(1e5), 0, MAX_UINT256),
      ).to.emit(metaSwap, "TokenSwap")
    })
  })

  describe("swapUnderlying", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await metaSwap.pause()

      // User 1 try to initiate swap
      await expect(
        metaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwap.calculateSwapUnderlying(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")

      await expect(
        metaSwap.swapUnderlying(0, 9, String(1e17), 0, MAX_UINT256),
      ).to.be.revertedWith("Token index out of range")
    })

    describe("Succeeds with expected swap amounts", () => {
      it("From 6 decimal token (meta) to 18 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
          0,
          1,
          String(1e5),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99682665521916558"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [dummyUSD, dai])

        // User 1 successfully initiates swap
        await metaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e5), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [dummyUSD, dai])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e5)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 6 decimal token (base) to 6 decimal token (meta)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
          2,
          0,
          String(1e5),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99702"))

        // Calculating swapping from a base token to a meta level token
        // does not account for base pool's swap fees
        const minReturnWithNegativeSlippage = calculatedSwapReturn
          .mul(999)
          .div(1000)

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [usdc, dummyUSD])

        // User 1 successfully initiates swap
        await metaSwap
          .connect(user1)
          .swapUnderlying(
            2,
            0,
            String(1e5),
            minReturnWithNegativeSlippage,
            MAX_UINT256,
          )

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [usdc, dummyUSD])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e5)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq("99683")
      })

      it("From 6 decimal token (meta) to 6 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
          0,
          2,
          String(1e5),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99682"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [dummyUSD, usdc])

        // User 1 successfully initiates swap
        await metaSwap
          .connect(user1)
          .swapUnderlying(0, 2, String(1e5), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [dummyUSD, usdc])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e5)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 18 decimal token (base) to 6 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
          1,
          3,
          String(1e17),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99959"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [dai, usdt])

        // User 1 successfully initiates swap
        await metaSwap
          .connect(user1)
          .swapUnderlying(1, 3, String(1e17), calculatedSwapReturn, MAX_UINT256)

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

    it("Reverts when minDy (minimum amount token to receive) is not reached due to front running", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
        0,
        1,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99682665521916558"))

      // User 2 swaps before User 1 does
      await metaSwap
        .connect(user2)
        .swapUnderlying(0, 1, String(1e5), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        metaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e5), calculatedSwapReturn, MAX_UINT256),
      ).to.be.reverted
    })

    it("Succeeds when using lower minDy even when transaction is front-ran", async () => {
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn = await metaSwap.calculateSwapUnderlying(
        0,
        1,
        String(1e5),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("99682665521916558"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [dummyUSD, dai])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(99)
        .div(100)

      // User 2 swaps before User 1 does
      await metaSwap.connect(user2).swap(0, 1, String(1e5), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 1% slippage from initial calculated amount
      await metaSwap
        .connect(user1)
        .swapUnderlying(
          0,
          1,
          String(1e5),
          calculatedSwapReturnWithNegativeSlippage,
          MAX_UINT256,
        )

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [dummyUSD, dai])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e5)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("99266389642716477"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token", async () => {
      const swapReturnAmount = await metaSwap.callStatic.swapUnderlying(
        0,
        1,
        String(1e5),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("99682665521916558")
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        metaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e5), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      // User 1 initiates swap
      await expect(
        metaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e5), 0, MAX_UINT256),
      ).to.emit(metaSwap, "TokenSwapUnderlying")
    })
  })

  describe("getVirtualPrice", () => {
    it("Returns expected value after initial deposit", async () => {
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
    })

    it("Returns expected values after swaps", async () => {
      // With each swap, virtual price will increase due to the fees
      await metaSwap.connect(user1).swap(0, 1, String(1e5), 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000050005862349911"),
      )

      await metaSwap.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000100193837524555"),
      )
    })

    it("Returns expected values after imbalanced withdrawal", async () => {
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)
      await metaSwap
        .connect(user2)
        .addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      await metaLPToken.connect(user1).approve(metaSwap.address, String(2e18))
      await metaSwap
        .connect(user1)
        .removeLiquidityImbalance([String(1e6), 0], String(2e18), MAX_UINT256)

      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000099995569732658"),
      )

      await metaLPToken.connect(user2).approve(metaSwap.address, String(2e18))
      await metaSwap
        .connect(user2)
        .removeLiquidityImbalance([0, String(1e18)], String(2e18), MAX_UINT256)

      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000199887983545535"),
      )
    })

    it("Value is unchanged after balanced deposits", async () => {
      // pool is 1:1 ratio
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      // pool changes to 2:1 ratio, thus changing the virtual price
      await metaSwap
        .connect(user2)
        .addLiquidity([String(2e6), String(0)], 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000167008547897747"),
      )
      // User 2 makes balanced deposit, keeping the ratio 2:1
      await metaSwap
        .connect(user2)
        .addLiquidity([String(2e6), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000167008547897747"),
      )
    })

    it("Value is unchanged after balanced withdrawals", async () => {
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)
      await metaLPToken.connect(user1).approve(metaSwap.address, String(1e18))
      await metaSwap
        .connect(user1)
        .removeLiquidity(String(1e18), ["0", "0"], MAX_UINT256)
      expect(await metaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
    })
  })

  describe("setSwapFee", () => {
    it("Emits NewSwapFee event", async () => {
      await expect(metaSwap.setSwapFee(BigNumber.from(1e8))).to.emit(
        metaSwap,
        "NewSwapFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(metaSwap.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(metaSwap.connect(user2).setSwapFee(BigNumber.from(1e8))).to
        .be.reverted
    })

    it("Reverts when fee is higher than the limit", async () => {
      await expect(metaSwap.setSwapFee(BigNumber.from(1e8).add(1))).to.be
        .reverted
    })

    it("Succeeds when fee is within the limit", async () => {
      await metaSwap.setSwapFee(BigNumber.from(1e8))
      expect((await metaSwap.swapStorage()).swapFee).to.eq(BigNumber.from(1e8))
    })
  })

  describe("setAdminFee", () => {
    it("Emits NewAdminFee event", async () => {
      await expect(metaSwap.setAdminFee(BigNumber.from(1e10))).to.emit(
        metaSwap,
        "NewAdminFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(metaSwap.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(metaSwap.connect(user2).setSwapFee(BigNumber.from(1e10))).to
        .be.reverted
    })

    it("Reverts when adminFee is higher than the limit", async () => {
      await expect(metaSwap.setAdminFee(BigNumber.from(1e10).add(1))).to.be
        .reverted
    })

    it("Succeeds when adminFee is within the limit", async () => {
      await metaSwap.setAdminFee(BigNumber.from(1e10))
      expect((await metaSwap.swapStorage()).adminFee).to.eq(
        BigNumber.from(1e10),
      )
    })
  })

  describe("getAdminBalance", () => {
    it("Reverts with 'Token index out of range'", async () => {
      await expect(metaSwap.getAdminBalance(3)).to.be.revertedWith(
        "Token index out of range",
      )
    })

    it("Is always 0 when adminFee is set to 0", async () => {
      expect(await metaSwap.getAdminBalance(0)).to.eq(0)
      expect(await metaSwap.getAdminBalance(1)).to.eq(0)

      await metaSwap.connect(user1).swap(0, 1, String(1e5), 0, MAX_UINT256)

      expect(await metaSwap.getAdminBalance(0)).to.eq(0)
      expect(await metaSwap.getAdminBalance(1)).to.eq(0)
    })

    it("Returns expected amounts after swaps when adminFee is higher than 0", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwap.connect(user1).swap(0, 1, String(1e5), 0, MAX_UINT256)

      expect(await metaSwap.getAdminBalance(0)).to.eq(0)
      expect(await metaSwap.getAdminBalance(1)).to.eq(String(998024139765))

      // After the first swap, the pool becomes imbalanced; there are more 0th token than 1st token in the pool.
      // Therefore swapping from 1st -> 0th will result in more 0th token returned
      // Also results in higher fees collected on the second swap.

      await metaSwap.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwap.getAdminBalance(0)).to.eq(String(1))
      expect(await metaSwap.getAdminBalance(1)).to.eq(String(998024139765))
    })
  })

  describe("withdrawAdminFees", () => {
    it("Reverts when called by non-owners", async () => {
      await expect(metaSwap.connect(user1).withdrawAdminFees()).to.be.reverted
      await expect(metaSwap.connect(user2).withdrawAdminFees()).to.be.reverted
    })

    it("Succeeds when there are no fees withdrawn", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwap.setAdminFee(BigNumber.from(10 ** 8))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      await metaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      expect(firstTokenBefore).to.eq(firstTokenAfter)
      expect(secondTokenBefore).to.eq(secondTokenAfter)
    })

    it("Succeeds with expected amount of fees withdrawn (swap)", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwap.connect(user1).swap(0, 1, String(1e5), 0, MAX_UINT256)
      await metaSwap.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwap.getAdminBalance(0)).to.eq(String(1))
      expect(await metaSwap.getAdminBalance(1)).to.eq(String(998024139765))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      await metaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(1))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(998024139765),
      )
    })

    it("Succeeds with expected amount of fees withdrawn (swapUnderlying)", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwap
        .connect(user1)
        .swapUnderlying(0, 1, String(1e5), 0, MAX_UINT256)
      await metaSwap
        .connect(user1)
        .swapUnderlying(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwap.getAdminBalance(0)).to.eq(String(1))
      expect(await metaSwap.getAdminBalance(1)).to.eq(String(998024139765))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      await metaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [dummyUSD, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(1))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(998024139765),
      )
    })

    it("Withdrawing admin fees has no impact on users' withdrawal", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwap
        .connect(user1)
        .addLiquidity([String(1e6), String(1e18)], 0, MAX_UINT256)

      for (let i = 0; i < 10; i++) {
        await metaSwap.connect(user2).swap(0, 1, String(1e5), 0, MAX_UINT256)
        await metaSwap.connect(user2).swap(1, 0, String(1e17), 0, MAX_UINT256)
      }

      expect(await metaSwap.getAdminBalance(0)).to.be.eq(10)
      expect(await metaSwap.getAdminBalance(1)).to.be.eq("9990270331848")

      await metaSwap.withdrawAdminFees()

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        user1,
        [dummyUSD, baseLPToken],
      )

      const user1LPTokenBalance = await metaLPToken.balanceOf(user1Address)
      await metaLPToken
        .connect(user1)
        .approve(metaSwap.address, user1LPTokenBalance)
      await metaSwap
        .connect(user1)
        .removeLiquidity(user1LPTokenBalance, [0, 0], MAX_UINT256)

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        user1,
        [dummyUSD, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(
        BigNumber.from("1000012"),
      )

      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        BigNumber.from("1000981001788791742"),
      )
    })
  })

  describe("rampA", () => {
    beforeEach(async () => {
      await forceAdvanceOneBlock()
    })

    it("Emits RampA event", async () => {
      await expect(
        metaSwap.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.emit(metaSwap, "RampA")
    })

    it("Succeeds to ramp upwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to increase as A decreases
      await metaSwap.addLiquidity([String(1e6), 0], 0, MAX_UINT256)

      // call rampA(), changing A to 100 within a span of 14 days
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await metaSwap.rampA(100, endTimestamp)

      // +0 seconds since ramp A
      expect(await metaSwap.getA()).to.be.eq(50)
      expect(await metaSwap.getAPrecise()).to.be.eq(5000)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000166842739703181")

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000258139482235857")

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await metaSwap.getA()).to.be.eq(100)
      expect(await metaSwap.getAPrecise()).to.be.eq(10000)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000771059955666655")
    })

    it("Succeeds to ramp downwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to decrease as A decreases
      await metaSwap.addLiquidity([String(1e6), 0], 0, MAX_UINT256)

      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await metaSwap.rampA(25, endTimestamp)

      // +0 seconds since ramp A
      expect(await metaSwap.getA()).to.be.eq(50)
      expect(await metaSwap.getAPrecise()).to.be.eq(5000)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000166842739703181")

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwap.getA()).to.be.eq(47)
      expect(await metaSwap.getAPrecise()).to.be.eq(4794)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000115566475687268")

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await metaSwap.getA()).to.be.eq(25)
      expect(await metaSwap.getAPrecise()).to.be.eq(2500)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("998999271186582317")
    })

    it("Reverts when non-owner calls it", async () => {
      await expect(
        metaSwap
          .connect(user1)
          .rampA(55, (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1),
      ).to.be.reverted
    })

    it("Reverts with 'Wait 1 day before starting ramp'", async () => {
      await metaSwap.rampA(
        55,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )
      await expect(
        metaSwap.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("Wait 1 day before starting ramp")
    })

    it("Reverts with 'Insufficient ramp time'", async () => {
      await expect(
        metaSwap.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 7 * TIME.DAYS - 1,
        ),
      ).to.be.revertedWith("Insufficient ramp time")
    })

    it("Reverts with 'futureA_ must be > 0 and < MAX_A'", async () => {
      await expect(
        metaSwap.rampA(
          0,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ must be > 0 and < MAX_A")
    })

    it("Reverts with 'futureA_ is too small'", async () => {
      await expect(
        metaSwap.rampA(
          24,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too small")
    })

    it("Reverts with 'futureA_ is too large'", async () => {
      await expect(
        metaSwap.rampA(
          101,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too large")
    })
  })

  describe("stopRampA", () => {
    it("Emits StopRampA event", async () => {
      // call rampA()
      await metaSwap.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100,
      )

      // Stop ramp
      expect(metaSwap.stopRampA()).to.emit(metaSwap, "StopRampA")
    })

    it("Stop ramp succeeds", async () => {
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await metaSwap.rampA(100, endTimestamp)

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await metaSwap.stopRampA()
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)

      // set timestamp to endTimestamp
      await setTimestamp(endTimestamp)

      // verify ramp has stopped
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)
    })

    it("Reverts with 'Ramp is already stopped'", async () => {
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await metaSwap.rampA(100, endTimestamp)

      // set timestamp to +10000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await metaSwap.stopRampA()
      expect(await metaSwap.getA()).to.be.eq(54)
      expect(await metaSwap.getAPrecise()).to.be.eq(5413)

      // check call reverts when ramp is already stopped
      await expect(metaSwap.stopRampA()).to.be.revertedWith(
        "Ramp is already stopped",
      )
    })
  })

  describe("Check for timestamp manipulations", () => {
    beforeEach(async () => {
      await forceAdvanceOneBlock()
    })

    it("Check for maximum differences in A and virtual price when A is increasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where susd is significantly cheaper than lpToken
      await metaSwap.addLiquidity([String(1e6), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await metaSwap.getA()).to.be.eq(50)
      expect(await metaSwap.getAPrecise()).to.be.eq(5000)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000166842739703181")

      // Start ramp
      await metaSwap.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await metaSwap.getA()).to.be.eq(50)
      expect(await metaSwap.getAPrecise()).to.be.eq(5003)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000167559005871668")

      // Max increase of A between two blocks
      // 5003 / 5000
      // = 1.0006

      // Max increase of virtual price between two blocks (at 2:1 ratio of tokens, starting A = 50)
      // 1000167559005871668 / 1000166842739703181
      // = 1.00000071615
    })

    it("Check for maximum differences in A and virtual price when A is decreasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where susd is significantly cheaper than lpToken
      await metaSwap.addLiquidity([String(1e6), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await metaSwap.getA()).to.be.eq(50)
      expect(await metaSwap.getAPrecise()).to.be.eq(5000)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000166842739703181")

      // Start ramp
      await metaSwap.rampA(
        25,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await metaSwap.getA()).to.be.eq(49)
      expect(await metaSwap.getAPrecise()).to.be.eq(4999)
      expect(await metaSwap.getVirtualPrice()).to.be.eq("1000166603797681510")

      // Max decrease of A between two blocks
      // 4999 / 5000
      // = 0.9998

      // Max decrease of virtual price between two blocks (at 2:1 ratio of tokens, starting A = 50)
      // 1000166603797681510 / 1000166842739703181
      // = 0.99999976109
    })

    // Below tests try to verify the issues found in Curve Vulnerability Report are resolved.
    // https://medium.com/@peter_4205/curve-vulnerability-report-a1d7630140ec
    // The two cases we are most concerned are:
    //
    // 1. A is ramping up, and the pool is at imbalanced state.
    //
    // Attacker can 'resolve' the imbalance prior to the change of A. Then try to recreate the imbalance after A has
    // changed. Due to the price curve becoming more linear, recreating the imbalance will become a lot cheaper. Thus
    // benefiting the attacker.
    //
    // 2. A is ramping down, and the pool is at balanced state
    //
    // Attacker can create the imbalance in token balances prior to the change of A. Then try to resolve them
    // near 1:1 ratio. Since downward change of A will make the price curve less linear, resolving the token balances
    // to 1:1 ratio will be cheaper. Thus benefiting the attacker
    //
    // For visual representation of how price curves differ based on A, please refer to Figure 1 in the above
    // Curve Vulnerability Report.

    describe("Check for attacks while A is ramping upwards", () => {
      let initialAttackerBalances: BigNumber[] = []
      let initialPoolBalances: BigNumber[] = []
      let attacker: Signer

      beforeEach(async () => {
        // This attack is achieved by creating imbalance in the first block then
        // trading in reverse direction in the second block.
        attacker = user1

        initialAttackerBalances = await getUserTokenBalances(attacker, [
          dummyUSD,
          baseLPToken,
        ])

        expect(initialAttackerBalances[0]).to.be.eq(String(1e11))
        expect(initialAttackerBalances[1]).to.be.eq(String(3e20))

        // Start ramp upwards
        await metaSwap.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        )
        expect(await metaSwap.getAPrecise()).to.be.eq(5000)

        // Check current pool balances
        initialPoolBalances = [
          await metaSwap.getTokenBalance(0),
          await metaSwap.getTokenBalance(1),
        ]
        expect(initialPoolBalances[0]).to.be.eq(String(1e6))
        expect(initialPoolBalances[1]).to.be.eq(String(1e18))
      })

      describe(
        "When tokens are priced equally: " +
          "attacker creates massive imbalance prior to A change, and resolves it after",
        () => {
          it("Attack fails with 900 seconds between blocks", async () => {
            // Swap 1e18 of susd to lpToken, causing massive imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 9.085e17 of lpToken
            expect(secondTokenOutput).to.be.eq("908591742545002306")

            // Pool is imbalanced! Now trades from lpToken -> susd may be profitable in small sizes
            // susd balance in the pool  : 2.00e18
            // lpToken balance in the pool : 9.14e16
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "91408257454997694",
            )

            // Malicious miner skips 900 seconds
            await setTimestamp((await getCurrentBlockTimestamp()) + 900)

            // Verify A has changed upwards
            // 5000 -> 5003 (0.06%)
            expect(await metaSwap.getAPrecise()).to.be.eq(5003)

            // Trade lpToken to susd, taking advantage of the imbalance and change of A
            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("997214")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("2786")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 2.785e15 susd (0.2785% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = []
            finalPoolBalances.push(await metaSwap.getTokenBalance(0))
            finalPoolBalances.push(await metaSwap.getTokenBalance(1))

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "2786",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 2.785e15 susd (0.2785% of susd balance)
            // The attack did not benefit the attacker.
          })

          it("Attack fails with 2 weeks between transactions (mimics rapid A change)", async () => {
            // This test assumes there are no other transactions during the 2 weeks period of ramping up.
            // Purpose of this test case is to mimic rapid ramp up of A.

            // Swap 1e18 of susd to lpToken, causing massive imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 9.085e17 of lpToken
            expect(secondTokenOutput).to.be.eq("908591742545002306")

            // Pool is imbalanced! Now trades from lpToken -> susd may be profitable in small sizes
            // susd balance in the pool  : 2.00e18
            // lpToken balance in the pool : 9.14e16
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "91408257454997694",
            )

            // Assume no transactions occur during 2 weeks
            await setTimestamp(
              (await getCurrentBlockTimestamp()) + 2 * TIME.WEEKS,
            )

            // Verify A has changed upwards
            // 5000 -> 10000 (100%)
            expect(await metaSwap.getAPrecise()).to.be.eq(10000)

            // Trade lpToken to susd, taking advantage of the imbalance and sudden change of A
            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("955743")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("44257")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 4.426e16 susd (4.426%)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "44257",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 4.426e16 susd (4.426% of susd balance of the pool)
            // The attack did not benefit the attacker.
          })
        },
      )

      describe(
        "When token price is unequal: " +
          "attacker 'resolves' the imbalance prior to A change, then recreates the imbalance.",
        () => {
          beforeEach(async () => {
            // Set up pool to be imbalanced prior to the attack
            await metaSwap
              .connect(user2)
              .addLiquidity(
                [String(0), String(2e18)],
                0,
                (await getCurrentBlockTimestamp()) + 60,
              )

            // Check current pool balances
            initialPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]
            expect(initialPoolBalances[0]).to.be.eq(String(1e6))
            expect(initialPoolBalances[1]).to.be.eq(String(3e18))
          })

          it("Attack fails with 900 seconds between blocks", async () => {
            // Swap 1e18 of susd to lpToken, resolving imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 1.012e18 of lpToken
            // Because the pool was imbalanced in the beginning, this trade results in more than 1e18 lpToken
            expect(secondTokenOutput).to.be.eq("1011933251060681353")

            // Pool is now almost balanced!
            // susd balance in the pool  : 2.000e18
            // lpToken balance in the pool : 1.988e18
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "1988066748939318647",
            )

            // Malicious miner skips 900 seconds
            await setTimestamp((await getCurrentBlockTimestamp()) + 900)

            // Verify A has changed upwards
            // 5000 -> 5003 (0.06%)
            expect(await metaSwap.getAPrecise()).to.be.eq(5003)

            // Trade lpToken to susd, taking advantage of the imbalance and sudden change of A
            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the attacker leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("998017")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("1983")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 1.982e15 susd (0.1982% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = []
            finalPoolBalances.push(await metaSwap.getTokenBalance(0))
            finalPoolBalances.push(await metaSwap.getTokenBalance(1))

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "1983",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 1.982e15 susd (0.1982% of susd balance)
            // The attack did not benefit the attacker.
          })

          it("Attack succeeds with 2 weeks between transactions (mimics rapid A change)", async () => {
            // This test assumes there are no other transactions during the 2 weeks period of ramping up.
            // Purpose of this test case is to mimic rapid ramp up of A.

            // Swap 1e18 of susd to lpToken, resolving the imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 9.085e17 of lpToken
            expect(secondTokenOutput).to.be.eq("1011933251060681353")

            // Pool is now almost balanced!
            // susd balance in the pool  : 2.000e18
            // lpToken balance in the pool : 1.988e18
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "1988066748939318647",
            )

            // Assume 2 weeks go by without any other transactions
            // This mimics rapid change of A
            await setTimestamp(
              (await getCurrentBlockTimestamp()) + 2 * TIME.WEEKS,
            )

            // Verify A has changed upwards
            // 5000 -> 10000 (100%)
            expect(await metaSwap.getAPrecise()).to.be.eq(10000)

            // Trade lpToken to susd, taking advantage of the imbalance and sudden change of A
            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("1004298")
            // Attack was successful!

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            expect(initialAttackerBalances[0]).to.be.lt(
              finalAttackerBalances[0],
            )
            expect(initialAttackerBalances[1]).to.be.eq(
              finalAttackerBalances[1],
            )
            expect(
              finalAttackerBalances[0].sub(initialAttackerBalances[0]),
            ).to.be.eq("4298")
            expect(
              finalAttackerBalances[1].sub(initialAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker gained 4.430e15 susd (0.430%)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.lt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(initialPoolBalances[0].sub(finalPoolBalances[0])).to.be.eq(
              "4298",
            )
            expect(initialPoolBalances[1].sub(finalPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) lost 4.430e15 susd (0.430% of susd balance)

            // The attack benefited the attacker.
            // Note that this attack is only possible when there are no swaps happening during the 2 weeks ramp period.
          })
        },
      )
    })

    describe("Check for attacks while A is ramping downwards", () => {
      let initialAttackerBalances: BigNumber[] = []
      let initialPoolBalances: BigNumber[] = []
      let attacker: Signer

      beforeEach(async () => {
        // Set up the downward ramp A
        attacker = user1

        initialAttackerBalances = await getUserTokenBalances(attacker, [
          dummyUSD,
          baseLPToken,
        ])

        expect(initialAttackerBalances[0]).to.be.eq(String(1e11))
        expect(initialAttackerBalances[1]).to.be.eq(String(3e20))

        // Start ramp downwards
        await metaSwap.rampA(
          25,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        )
        expect(await metaSwap.getAPrecise()).to.be.eq(5000)

        // Check current pool balances
        initialPoolBalances = [
          await metaSwap.getTokenBalance(0),
          await metaSwap.getTokenBalance(1),
        ]
        expect(initialPoolBalances[0]).to.be.eq(String(1e6))
        expect(initialPoolBalances[1]).to.be.eq(String(1e18))
      })

      describe(
        "When tokens are priced equally: " +
          "attacker creates massive imbalance prior to A change, and resolves it after",
        () => {
          // This attack is achieved by creating imbalance in the first block then
          // trading in reverse direction in the second block.

          it("Attack fails with 900 seconds between blocks", async () => {
            // Swap 1e18 of susd to lpToken, causing massive imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 9.085e17 of lpToken
            expect(secondTokenOutput).to.be.eq("908591742545002306")

            // Pool is imbalanced! Now trades from lpToken -> susd may be profitable in small sizes
            // susd balance in the pool  : 2.00e18
            // lpToken balance in the pool : 9.14e16
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "91408257454997694",
            )

            // Malicious miner skips 900 seconds
            await setTimestamp((await getCurrentBlockTimestamp()) + 900)

            // Verify A has changed downwards
            expect(await metaSwap.getAPrecise()).to.be.eq(4999)

            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("997276")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            // Check for attacker's balance changes
            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("2724")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 2.723e15 susd (0.2723% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "2724",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 2.723e15 susd (0.2723% of susd balance)
            // The attack did not benefit the attacker.
          })

          it("Attack succeeds with 2 weeks between transactions (mimics rapid A change)", async () => {
            // This test assumes there are no other transactions during the 2 weeks period of ramping down.
            // Purpose of this test is to show how dangerous rapid A ramp is.

            // Swap 1e18 of susd to lpToken, causing massive imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 9.085e17 of lpToken
            expect(secondTokenOutput).to.be.eq("908591742545002306")

            // Pool is imbalanced! Now trades from lpToken -> susd may be profitable in small sizes
            // susd balance in the pool  : 2.00e18
            // lpToken balance in the pool : 9.14e16
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "91408257454997694",
            )

            // Assume no transactions occur during 2 weeks ramp time
            await setTimestamp(
              (await getCurrentBlockTimestamp()) + 2 * TIME.WEEKS,
            )

            // Verify A has changed downwards
            expect(await metaSwap.getAPrecise()).to.be.eq(2500)

            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("1066252")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            // Check for attacker's balance changes
            expect(finalAttackerBalances[0]).to.be.gt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              finalAttackerBalances[0].sub(initialAttackerBalances[0]),
            ).to.be.eq("66252")
            expect(
              finalAttackerBalances[1].sub(initialAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker gained 6.625e16 susd (6.625% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.lt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(initialPoolBalances[0].sub(finalPoolBalances[0])).to.be.eq(
              "66252",
            )
            expect(initialPoolBalances[1].sub(finalPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) lost 6.625e16 susd (6.625% of susd balance)

            // The attack was successful. The change of A (-50%) gave the attacker a chance to swap
            // more efficiently. The swap fee (0.1%) was not sufficient to counter the efficient trade, giving
            // the attacker more tokens than initial deposit.
          })
        },
      )

      describe(
        "When token price is unequal: " +
          "attacker 'resolves' the imbalance prior to A change, then recreates the imbalance.",
        () => {
          beforeEach(async () => {
            // Set up pool to be imbalanced prior to the attack
            await metaSwap
              .connect(user2)
              .addLiquidity(
                [String(0), String(2e18)],
                0,
                (await getCurrentBlockTimestamp()) + 60,
              )

            // Check current pool balances
            initialPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]
            expect(initialPoolBalances[0]).to.be.eq(String(1e6))
            expect(initialPoolBalances[1]).to.be.eq(String(3e18))
          })

          it("Attack fails with 900 seconds between blocks", async () => {
            // Swap 1e18 of susd to lpToken, resolving imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 1.012e18 of lpToken
            // Because the pool was imbalanced in the beginning, this trade results in more than 1e18 lpToken
            expect(secondTokenOutput).to.be.eq("1011933251060681353")

            // Pool is now almost balanced!
            // susd balance in the pool  : 2.000e18
            // lpToken balance in the pool : 1.988e18
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "1988066748939318647",
            )

            // Malicious miner skips 900 seconds
            await setTimestamp((await getCurrentBlockTimestamp()) + 900)

            // Verify A has changed downwards
            expect(await metaSwap.getAPrecise()).to.be.eq(4999)

            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("998007")

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            // Check for attacker's balance changes
            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("1993")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 1.992e15 susd (0.1992% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "1993",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 1.992e15 susd (0.1992% of susd balance)
            // The attack did not benefit the attacker.
          })

          it("Attack fails with 2 weeks between transactions (mimics rapid A change)", async () => {
            // This test assumes there are no other transactions during the 2 weeks period of ramping down.
            // Purpose of this test case is to mimic rapid ramp down of A.

            // Swap 1e18 of susd to lpToken, resolving imbalance in the pool
            await metaSwap
              .connect(attacker)
              .swap(0, 1, String(1e6), 0, MAX_UINT256)
            const secondTokenOutput = (
              await getUserTokenBalance(attacker, baseLPToken)
            ).sub(initialAttackerBalances[1])

            // First trade results in 1.012e18 of lpToken
            // Because the pool was imbalanced in the beginning, this trade results in more than 1e18 lpToken
            expect(secondTokenOutput).to.be.eq("1011933251060681353")

            // Pool is now almost balanced!
            // susd balance in the pool  : 2.000e18
            // lpToken balance in the pool : 1.988e18
            expect(await metaSwap.getTokenBalance(0)).to.be.eq(String(2e6))
            expect(await metaSwap.getTokenBalance(1)).to.be.eq(
              "1988066748939318647",
            )

            // Assume no other transactions occur during the 2 weeks ramp period
            await setTimestamp(
              (await getCurrentBlockTimestamp()) + 2 * TIME.WEEKS,
            )

            // Verify A has changed downwards
            expect(await metaSwap.getAPrecise()).to.be.eq(2500)

            const balanceBefore = await getUserTokenBalance(attacker, dummyUSD)
            await metaSwap
              .connect(attacker)
              .swap(1, 0, secondTokenOutput, 0, MAX_UINT256)
            const firstTokenOutput = (
              await getUserTokenBalance(attacker, dummyUSD)
            ).sub(balanceBefore)

            // If firstTokenOutput > 1e18, the malicious user leaves with more susd than the start.
            expect(firstTokenOutput).to.be.eq("986318")
            // Attack was not successful

            const finalAttackerBalances = await getUserTokenBalances(attacker, [
              dummyUSD,
              baseLPToken,
            ])

            // Check for attacker's balance changes
            expect(finalAttackerBalances[0]).to.be.lt(
              initialAttackerBalances[0],
            )
            expect(finalAttackerBalances[1]).to.be.eq(
              initialAttackerBalances[1],
            )
            expect(
              initialAttackerBalances[0].sub(finalAttackerBalances[0]),
            ).to.be.eq("13682")
            expect(
              initialAttackerBalances[1].sub(finalAttackerBalances[1]),
            ).to.be.eq("0")
            // Attacker lost 1.368e16 susd (1.368% of initial deposit)

            // Check for pool balance changes
            const finalPoolBalances = [
              await metaSwap.getTokenBalance(0),
              await metaSwap.getTokenBalance(1),
            ]

            expect(finalPoolBalances[0]).to.be.gt(initialPoolBalances[0])
            expect(finalPoolBalances[1]).to.be.eq(initialPoolBalances[1])
            expect(finalPoolBalances[0].sub(initialPoolBalances[0])).to.be.eq(
              "13682",
            )
            expect(finalPoolBalances[1].sub(initialPoolBalances[1])).to.be.eq(
              "0",
            )
            // Pool (liquidity providers) gained 1.368e16 susd (1.368% of susd balance)
            // The attack did not benefit the attacker
          })
        },
      )
    })
  })
})
