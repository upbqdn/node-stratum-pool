var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    coin,
    daemon
) {
    //private members
    var submits = [];

    //public members
    this.rpcData = rpcData;
    this.jobId = jobId;
    this.algoNK = coin.parameters && coin.parameters.N && coin.parameters.K ? coin.parameters.N+'_'+coin.parameters.K : undefined;
    this.persString = coin.parameters ? coin.parameters.personalization : undefined;

    // get target info
    this.target = bignum(rpcData.target, 16);

    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

    this.rewardFees = rpcData.transactions.reduce(function (fees, tx) {
        return fees + Number(tx.fee);
    }, 0);
    rpcData.rewardFees = this.rewardFees;

    // Never mutate the daemon coinbase: it owns the payout, transaction version,
    // consensus branch ID and shielded proofs. Extranonce belongs in the header.
    this.genTx = rpcData.coinbasetxn.data;
    this.genTxHash = rpcData.coinbasetxn.hash;

    // generate the merkle root
    this.prevHashReversed = util.reverseBuffer(new Buffer(rpcData.previousblockhash, 'hex')).toString('hex');
    var commitment = rpcData.blockcommitmentshash ||
        (rpcData.defaultroots && rpcData.defaultroots.blockcommitmentshash) ||
        rpcData.finalsaplingroothash;
    if (commitment) {
        // The daemon coinbase and all transaction bytes/order are preserved, so
        // its auth-data root and block commitment remain valid, including NU6.3.
        this.hashReserved = util.reverseHex(commitment);
    } else {
        this.hashReserved = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
    }
    this.merkleRoot = merkle.getRoot(rpcData, this.genTxHash);

    this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase
    // we can't do anything else until we have a submission

    this.txs = new Array();
    this.txs.push(this.genTx)
    for (var tx of rpcData.transactions) {
        this.txs.push(tx.data);
    }

    this.calculateTrees = async function () {
        return new Promise(resolve => {
            daemon.cmd(
                'getblockmerkleroots',
                [this.txs,
                    this.rpcData.certificates.length > 0 ? this.rpcData.certificates.map(el => el.data) : []],
                result => result.error ? resolve(result.error) : resolve(this.getTrees(result[0].response))
            )
        })
    }
    this.getTrees = function (response) {
        this.merkleRoot = response.merkleTree;
        this.hashReserved = util.reverseBuffer(new Buffer(response.scTxsCommitment, 'hex')).toString('hex');
        this.certCount = this.rpcData.certificates.length;
    }

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
    this.serializeHeader = function (nTime, nonce) {
        var header = new Buffer(140);
        var position = 0;

        header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
        header.write(this.prevHashReversed, position += 4, 32, 'hex');
        // merkleRoot is already in serialized byte order.
        header.write(this.merkleRoot, position += 32, 32, 'hex');
        header.write(this.hashReserved, position += 32, 32, 'hex');
        header.write(nTime, position += 32, 4, 'hex');
        header.write(util.reverseBuffer(new Buffer(rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');
        header.write(nonce, position += 4, 32, 'hex');
        return header;
    };

    // join the header and txs together
    this.serializeBlock = function (header, soln) {
        // Keep the exact template order and bytes; v5/v6 bundles are opaque here.
        var buf = Buffer.concat([
            header,
            soln,
            util.varIntBuffer(this.txCount)
        ].concat(this.txs.map(function (tx) {
            return Buffer.from(tx, 'hex');
        })));


        if (this.rpcData.version == 3 && (coin.symbol == "zen" || coin.symbol == "zent")) {
            var certCount = this.certCount.toString(16);
            if (Math.abs(certCount.length % 2) == 1) {
                certCount = "0" + certCount;
            }
            if (this.certCount <= 0xfc) {
                var varIntCert = new Buffer(certCount, 'hex');
            } else if (this.certCount <= 0x7fff) {
                if (certCount.length == 2) {
                    certCount = "00" + certCount;
                }
                var varIntCert = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer(certCount, 'hex'))]);
            }
            tmpBuf = new Buffer(varIntCert, 'hex');
            certBuf = new Buffer.concat([buf, tmpBuf]);
            buf = certBuf;

            if (this.rpcData.certificates.length > 0) {
                this.rpcData.certificates.forEach(function (value) {
                    tmpBuf = new Buffer.concat([buf, new Buffer(value.data, 'hex')]);
                    buf = tmpBuf;
                });
            }
        }

        return buf;
    };

    // submit the block header
    this.registerSubmit = function (header, soln) {
        var submission = (header + soln).toLowerCase();
        if (submits.indexOf(submission) === -1) {

            submits.push(submission);
            return true;
        }
        return false;
    };

    // used for mining.notify
    this.getJobParams = function () {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                // Stratum uses the same serialized root bytes as the header.
                this.merkleRoot,
                this.hashReserved,
                util.packUInt32LE(rpcData.curtime).toString('hex'),
                util.reverseBuffer(new Buffer(this.rpcData.bits, 'hex')).toString('hex'),
                true,
                this.algoNK,
                this.persString
            ];
        }
        return this.jobParams;
    };
};
