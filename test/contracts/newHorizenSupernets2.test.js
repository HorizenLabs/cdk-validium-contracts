/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { calculateBatchHashData } = contractUtils;

xdescribe('CDKValidium with NewHorizen Verifier', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;
    let aggregator1;

    let verifierContract;
    let PolygonZkEVMBridgeContract;
    let cdkValidiumContract;
    let cdkDataCommitteeContract;
    let maticTokenContract;
    let PolygonZkEVMGlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://cdk-validium-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'cdk-validium';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    const initialAttestationId = 1
    let minSubstrateTree = {
        root: "0x6af3cd8528949e82eb99b61f170ea7935d7403af6ef154f40460a94675a2cb06",
        leaves: ["0x36baf53ebdc0c5655b64b744b79e94aa977f6707f420e9871615b0dc089879f3"],
        proofs: []
    }

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin, aggregator1] = await ethers.getSigners();

        // deploy verifier
        const NewHorizenProofVerifierFactory = await ethers.getContractFactory(
          'NewHorizenProofVerifier',
        );
        verifierContract = await NewHorizenProofVerifierFactory.deploy(
          trustedAggregator.getAddress()
        );

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
          maticTokenName,
          maticTokenSymbol,
          deployer.address,
          maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();
        if ((await upgrades.admin.getInstance()).address !== '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') {
            firstDeployment = false;
        }
        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + (firstDeployment ? 3 : 2);
        const nonceProxyCommittee = nonceProxyBridge + (firstDeployment ? 2 : 1);
        // Always have to redeploy impl since the PolygonZkEVMGlobalExitRoot address changes
        const nonceProxyCDKValidium = nonceProxyCommittee + 2;

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateCommitteeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCommittee });
        const precalculateCDKValidiumAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCDKValidium });
        firstDeployment = false;

        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRoot');
        PolygonZkEVMGlobalExitRoot = await upgrades.deployProxy(PolygonZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateCDKValidiumAddress, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy CDKDataCommittee
        const cdkDataCommitteeFactory = await ethers.getContractFactory('CDKDataCommittee');
        cdkDataCommitteeContract = await upgrades.deployProxy(
          cdkDataCommitteeFactory,
          [],
          { initializer: false },
        );

        // deploy CDKValidiumMock
        const CDKValidiumFactory = await ethers.getContractFactory('CDKValidiumMock');
        cdkValidiumContract = await upgrades.deployProxy(CDKValidiumFactory, [], {
            initializer: false,
            constructorArgs: [
                PolygonZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                PolygonZkEVMBridgeContract.address,
                cdkDataCommitteeContract.address,
                chainID,
                forkID,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(PolygonZkEVMBridgeContract.address);
        expect(precalculateCommitteeAddress).to.be.equal(cdkDataCommitteeContract.address);
        expect(precalculateCDKValidiumAddress).to.be.equal(cdkValidiumContract.address);

        await PolygonZkEVMBridgeContract.initialize(networkIDMainnet, PolygonZkEVMGlobalExitRoot.address, cdkValidiumContract.address);
        await cdkValidiumContract.initialize(
          {
              admin: admin.address,
              trustedSequencer: trustedSequencer.address,
              pendingStateTimeout: pendingStateTimeoutDefault,
              trustedAggregator: trustedAggregator.address,
              trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
          },
          genesisRoot,
          urlSequencer,
          networkName,
          version,
        );
        await cdkDataCommitteeContract.initialize();
        const expectedHash = ethers.utils.solidityKeccak256(['bytes'], [[]]);
        await expect(cdkDataCommitteeContract.connect(deployer)
          .setupCommittee(0, [], []))
          .to.emit(cdkDataCommitteeContract, 'CommitteeUpdated')
          .withArgs(expectedHash);

        // fund sequencer address with Matic tokens
        await maticTokenContract.transfer(trustedSequencer.address, ethers.utils.parseEther('1000'));
    });

    it('should verify a sequenced batch using the NewHorizen Verifier', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const maticAmount = await cdkValidiumContract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
          maticTokenContract.connect(trustedSequencer).approve(cdkValidiumContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await cdkValidiumContract.lastBatchSequenced();
        // Sequence Batches
        await expect(cdkValidiumContract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address, []))
          .to.emit(cdkValidiumContract, 'SequenceBatches')
          .withArgs(lastBatchSequenced + 1);

        // aggregator forge the batch
        const pendingState = 0;
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000002';
        const numBatch = (await cdkValidiumContract.lastVerifiedBatch()) + 1;
        const newHorizenRequest = {
            attestationId: 1,
            merklePath: [],
            leafCount: 1,
            index: 0,
        }

        const initialAggregatorMatic = await maticTokenContract.balanceOf(
          aggregator1.address,
        );

        const sequencedBatchData = await cdkValidiumContract.sequencedBatches(1);
        const { sequencedTimestamp } = sequencedBatchData;
        const currentBatchFee = await cdkValidiumContract.batchFee();

        // submit attestations for use by the verifier
        await verifierContract.connect(trustedAggregator).submitAttestation(initialAttestationId, minSubstrateTree.root);
        await expect(await verifierContract.connect(trustedAggregator).proofsAttestations([initialAttestationId])).to.equal(minSubstrateTree.root)

        await expect(
          cdkValidiumContract.connect(aggregator1).verifyBatches(
            pendingState,
            numBatch - 1,
            numBatch,
            newLocalExitRoot,
            newStateRoot,
            newHorizenRequest,
          ),
        ).to.be.revertedWith('TrustedAggregatorTimeoutNotExpired');

        await ethers.provider.send('evm_setNextBlockTimestamp', [sequencedTimestamp.toNumber() + trustedAggregatorTimeoutDefault - 1]);

        await expect(
          cdkValidiumContract.connect(aggregator1).verifyBatches(
            pendingState,
            numBatch - 1,
            numBatch,
            newLocalExitRoot,
            newStateRoot,
            newHorizenRequest,
          ),
        ).to.be.revertedWith('TrustedAggregatorTimeoutNotExpired');

        // Verify batch
        await expect(
          cdkValidiumContract.connect(aggregator1).verifyBatches(
            pendingState,
            numBatch - 1,
            numBatch,
            newLocalExitRoot,
            newStateRoot,
            newHorizenRequest,
          ),
        ).to.emit(cdkValidiumContract, 'VerifyBatches')
          .withArgs(numBatch, newStateRoot, aggregator1.address);

        const verifyTimestamp = (await ethers.provider.getBlock()).timestamp;

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
          aggregator1.address,
        );
        expect(finalAggregatorMatic).to.equal(
          ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );

        // Check pending state
        const lastPendingstate = 1;
        expect(lastPendingstate).to.be.equal(await cdkValidiumContract.lastPendingState());

        const pendingStateData = await cdkValidiumContract.pendingStateTransitions(lastPendingstate);
        expect(verifyTimestamp).to.be.equal(pendingStateData.timestamp);
        expect(numBatch).to.be.equal(pendingStateData.lastVerifiedBatch);
        expect(newLocalExitRoot).to.be.equal(pendingStateData.exitRoot);
        expect(newStateRoot).to.be.equal(pendingStateData.stateRoot);

        // Try consolidate state
        expect(0).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());

        // Pending state can't be 0
        await expect(
          cdkValidiumContract.consolidatePendingState(0),
        ).to.be.revertedWith('PendingStateInvalid');

        // Pending state does not exist
        await expect(
          cdkValidiumContract.consolidatePendingState(2),
        ).to.be.revertedWith('PendingStateInvalid');

        // Not ready to be consolidated
        await expect(
          cdkValidiumContract.consolidatePendingState(lastPendingstate),
        ).to.be.revertedWith('PendingStateNotConsolidable');

        await ethers.provider.send('evm_setNextBlockTimestamp', [verifyTimestamp + pendingStateTimeoutDefault - 1]);

        await expect(
          cdkValidiumContract.consolidatePendingState(lastPendingstate),
        ).to.be.revertedWith('PendingStateNotConsolidable');

        await expect(
          cdkValidiumContract.consolidatePendingState(lastPendingstate),
        ).to.emit(cdkValidiumContract, 'ConsolidatePendingState')
          .withArgs(numBatch, newStateRoot, lastPendingstate);

        // Pending state already consolidated
        await expect(
          cdkValidiumContract.consolidatePendingState(1),
        ).to.be.revertedWith('PendingStateInvalid');

        // Fee es divided because is was fast verified
        const multiplierFee = await cdkValidiumContract.multiplierBatchFee();
        expect((currentBatchFee.mul(1000)).div(multiplierFee)).to.be.equal(await cdkValidiumContract.batchFee());

        // Check pending state variables
        expect(1).to.be.equal(await cdkValidiumContract.lastVerifiedBatch());
        expect(newStateRoot).to.be.equal(await cdkValidiumContract.batchNumToStateRoot(1));
        expect(1).to.be.equal(await cdkValidiumContract.lastPendingStateConsolidated());
    });

});