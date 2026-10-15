'use strict';

// Run after npm install: node test/blockTemplate.js [captured-getblocktemplate.json]
// Synthetic payloads below test opaque serialization, not transaction validity.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const BlockTemplate = require('../lib/blockTemplate');
const merkle = require('../lib/merkleTree');

global.diff1 = 1;
const reverse = hex => Buffer.from(hex, 'hex').reverse().toString('hex');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
const pair = (a, b) => digest(digest(Buffer.from(a + b, 'hex'))).toString('hex');
const ids = [0, 1, 2, 3].map(n => digest(Buffer.from('txid-' + n)).toString('hex'));
const leaves = ids.map(reverse);
const roots = [leaves[0], pair(leaves[0], leaves[1]),
    pair(pair(leaves[0], leaves[1]), pair(leaves[2], leaves[2])),
    pair(pair(leaves[0], leaves[1]), pair(leaves[2], leaves[3]))];

// Exact hash/root excerpt of the real Zebra NU5 funded-template capture.
const funded = require('./zebra-funded-template.json');
assert.strictEqual(funded.transactions.length, 2);
const computed = merkle.getRoot({transactions: funded.transactions}, funded.coinbasetxn.hash);
assert.strictEqual(reverse(computed), funded.defaultroots.merkleroot);
assert.strictEqual(computed, reverse(funded.defaultroots.merkleroot));
assert.strictEqual(merkle.getRoot(funded, funded.coinbasetxn.hash), computed);

function checkTemplate(rpc, expectedRoot) {
    const job = new BlockTemplate('test', rpc, {}, null);
    const time = Buffer.alloc(4);
    time.writeUInt32LE(rpc.curtime);
    const header = job.serializeHeader(time.toString('hex'), '00'.repeat(32));
    const commitment = rpc.blockcommitmentshash ||
        (rpc.defaultroots && rpc.defaultroots.blockcommitmentshash) || rpc.finalsaplingroothash;
    assert.strictEqual(header.slice(36, 68).toString('hex'), expectedRoot);
    assert.strictEqual(header.slice(68, 100).toString('hex'), reverse(commitment));
    assert.strictEqual(job.getJobParams()[3], expectedRoot);
    assert.strictEqual(job.getJobParams()[4], reverse(commitment));
    assert.strictEqual(job.genTx, rpc.coinbasetxn.data);
    assert.strictEqual(job.genTxHash, rpc.coinbasetxn.hash);

    // This is only a serialization check, not an Equihash solution.
    const solution = Buffer.from('00', 'hex');
    const count = rpc.transactions.length + 1;
    const countBytes = Buffer.alloc(count < 253 ? 1 : 3);
    countBytes[0] = count < 253 ? count : 253;
    if (count >= 253) countBytes.writeUInt16LE(count, 1);
    assert.strictEqual(job.serializeBlock(header, solution).toString('hex'),
        header.toString('hex') + solution.toString('hex') + countBytes.toString('hex') +
        rpc.coinbasetxn.data + rpc.transactions.map(tx => tx.data).join(''));
}

// v5 NU5 and v6 NU6.3 prefixes: neither the coinbase nor other transactions are parsed.
['050000800a27a726b4d0d6c2', '0600008098b684d85b16a537'].forEach(prefix => {
    for (let count = 0; count < 4; count++) {
        const rpc = {
            version: 4, height: 200, curtime: 1700000000,
            previousblockhash: ids[3], target: '0f'.repeat(32), bits: '200f0f0f',
            coinbasetxn: {data: prefix + '00', hash: ids[0], authdigest: 'ab'.repeat(32)},
            transactions: ids.slice(1, count + 1).map((hash, i) => ({
                hash: hash, authdigest: 'cd'.repeat(32), data: prefix + '000' + i, fee: 10000
            })),
            finalsaplingroothash: ids[2]
        };
        assert.strictEqual(merkle.getRoot(rpc, rpc.coinbasetxn.hash), roots[count]);
        checkTemplate(rpc, roots[count]);
        rpc.defaultroots = {
            merkleroot: reverse(roots[count]), chainhistoryroot: ids[1],
            authdataroot: ids[2], blockcommitmentshash: ids[3]
        };
        checkTemplate(rpc, roots[count]);
        rpc.blockcommitmentshash = ids[3];
        delete rpc.finalsaplingroothash;
        checkTemplate(rpc, roots[count]);
    }
});

// The txid alias, when supplied by a Bitcoin-style daemon, is not its witness hash.
assert.strictEqual(merkle.getRoot({transactions: [{txid: ids[1], hash: ids[3]}]}, ids[0]), roots[1]);

// Exercise CompactSize at the one-byte boundary and beyond the former 0x7fff cap.
[252, 32767].forEach(count => {
    const rpc = {
        version: 4, height: 200, curtime: 1700000000,
        previousblockhash: ids[3], target: '0f'.repeat(32), bits: '200f0f0f',
        coinbasetxn: {data: '0600008098b684d85b16a537', hash: ids[0]},
        transactions: Array.from({length: count}, () => ({hash: ids[1], data: '00', fee: 0})),
        defaultroots: {merkleroot: ids[2], blockcommitmentshash: ids[3]}
    };
    checkTemplate(rpc, reverse(ids[2]));
});

// Real captured GBT responses exercise the same code with actual v6 shielded bundles.
if (process.argv[2]) {
    const captured = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const rpc = captured.result || captured;
    assert(rpc.defaultroots, 'capture must include Zebra defaultroots');
    const expected = reverse(rpc.defaultroots.merkleroot);
    checkTemplate(rpc, expected);
    const withoutRoots = Object.assign({}, rpc);
    delete withoutRoots.defaultroots;
    assert.strictEqual(merkle.getRoot(withoutRoots, rpc.coinbasetxn.hash), expected);
}

const Pool = require('../lib/pool');
[{rewardRecipients: {address: 1}}, {poolHex: 'abcd'}, {paymentProcessing: {enabled: true}}]
    .forEach(options => assert.throws(() => new Pool(options), /Daemon coinbase mode/));
console.log('Template serialization checks passed (not consensus acceptance).');
