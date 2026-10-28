'use strict';

const assert = require('assert');
require('../lib/algoProperties');
const JobManager = require('../lib/jobManager');
const clone = value => JSON.parse(JSON.stringify(value));

async function check() {
    const manager = new JobManager({coin: {algorithm: 'equihash'}});
    const events = [];
    manager.on('newBlock', job => events.push(['new', job]));
    manager.on('updatedBlock', job => events.push(['update', job]));
    let rpc = {
        version: 4, height: 200, curtime: 1700000000,
        previousblockhash: '01'.repeat(32), target: '0f'.repeat(32), bits: '200f0f0f',
        coinbasetxn: {data: '0600008098b684d85b16a537', hash: '11'.repeat(32)},
        transactions: [], finalsaplingroothash: '22'.repeat(32)
    };
    assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
    const first = manager.currentJob;
    assert.strictEqual(events[0][0], 'new');
    assert.strictEqual(first.registerSubmit('nonce', 'solution'), true);

    const unchanged = clone(rpc);
    unchanged.curtime++;
    unchanged.longpollid = 'another-id';
    assert.strictEqual(await manager.processTemplate(unchanged), false);
    assert.strictEqual(manager.currentJob, first);
    assert.strictEqual(events.length, 1);

    async function update(change) {
        const previous = manager.currentJob;
        rpc = clone(rpc);
        change(rpc);
        assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
        assert.notStrictEqual(manager.currentJob.jobId, previous.jobId);
        assert.strictEqual(events[events.length - 1][0], 'update');
        assert.strictEqual(manager.validJobs[previous.jobId], previous);
        assert.strictEqual(manager.validJobs[first.jobId], first);
        // Share lookup must still reach validation of the old job, not reject it as stale.
        const share = manager.processShare(first.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '');
        assert.deepStrictEqual(share.error, [20, 'incorrect size of ntime']);
        assert.strictEqual(first.registerSubmit('nonce', 'solution'), false);
        assert.strictEqual(await manager.processTemplate(clone(rpc)), false);
    }
    await update(value => { value.bits = '207fffff'; });
    await update(value => { value.target = '7f'.repeat(32); });
    await update(value => { value.version = 5; });


    await update(value => {
        value.transactions.push({hash: '33'.repeat(32), data: '0600008001', fee: 10000});
    });
    assert.notStrictEqual(manager.currentJob.merkleRoot, first.merkleRoot);
    assert.strictEqual(manager.currentJob.rewardFees, 10000);
    await update(value => {
        value.transactions.push({txid: '44'.repeat(32), hash: '55'.repeat(32),
            data: '0600008002', fee: 20000});
    });
    await update(value => value.transactions.reverse());
    await update(value => { value.transactions[0].txid = '66'.repeat(32); });
    // Authorized transaction data can change without changing its v5/v6 transaction ID.
    await update(value => { value.transactions[0].data += '00'; });
    await update(value => value.transactions.pop());
    await update(value => { value.coinbasetxn.data += '00'; });
    await update(value => { value.coinbasetxn.hash = '77'.repeat(32); });
    await update(value => {
        value.defaultroots = {merkleroot: '88'.repeat(32), blockcommitmentshash: '99'.repeat(32)};
    });
    await update(value => { value.defaultroots.merkleroot = 'aa'.repeat(32); });
    await update(value => { value.defaultroots.blockcommitmentshash = 'bb'.repeat(32); });
    await update(value => { value.blockcommitmentshash = 'cc'.repeat(32); });

    const jobs = Object.keys(manager.validJobs);
    const outdated = clone(rpc);
    outdated.previousblockhash = 'dd'.repeat(32);
    outdated.height--;
    assert.strictEqual(await manager.processTemplate(outdated), false);
    assert.deepStrictEqual(Object.keys(manager.validJobs), jobs);
    // A same-height reorg is a new parent, not a fee update.
    rpc.previousblockhash = 'ee'.repeat(32);
    assert.strictEqual(await manager.processTemplate(rpc), true);
    assert.strictEqual(events[events.length - 1][0], 'new');
    assert.deepStrictEqual(Object.keys(manager.validJobs), [manager.currentJob.jobId]);
    assert.deepStrictEqual(
        manager.processShare(first.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '').error,
        [21, 'job not found']);

    const retained = [manager.currentJob];
    for (let update = 0; update < 64; update++) {
        rpc = clone(rpc);
        rpc.coinbasetxn.data += '00';
        if (update % 2) await manager.updateCurrentJob(rpc);
        else assert.strictEqual(await manager.processTemplate(rpc), true);
        retained.push(manager.currentJob);
        assert(Object.keys(manager.validJobs).length <= 32, 'job retention must remain bounded');
    }
    assert.deepStrictEqual(Object.keys(manager.validJobs), retained.slice(-32).map(job => job.jobId));
    for (const job of retained.slice(-32)) {
        assert.strictEqual(manager.validJobs[job.jobId], job);
        assert.deepStrictEqual(
            manager.processShare(job.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '').error,
            [20, 'incorrect size of ntime']);
    }
    assert.deepStrictEqual(
        manager.processShare(retained[retained.length - 33].jobId,
            1, 1, '', '', '', '', '', 0, 'worker', '').error,
        [21, 'job not found']);
    rpc = clone(rpc);
    rpc.previousblockhash = 'ff'.repeat(32);
    rpc.height++;
    assert.strictEqual(await manager.processTemplate(rpc), true);
    assert.deepStrictEqual(Object.keys(manager.validJobs), [manager.currentJob.jobId]);
}

check().then(() => {
    console.log('Same-parent transaction/root updates and old-job share lookup checks passed.');
}, error => {
    console.error(error);
    process.exitCode = 1;
});
