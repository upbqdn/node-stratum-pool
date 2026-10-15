var util = require('./util.js');

// Return serialized (not RPC display-order) bytes for the header and mining.notify.
exports.getRoot = function (rpcData, coinbaseTxId) {
    // Coinbase and transaction order are unchanged, so Zebra's root is authoritative.
    if (rpcData.defaultroots) {
        return util.reverseHex(rpcData.defaultroots.merkleroot);
    }

    // GBT hash is a txid in Zcash, including v5/v6; authdigest is a separate tree.
    var hashes = [coinbaseTxId].concat(rpcData.transactions.map(function (tx) {
        return tx.txid !== undefined ? tx.txid : tx.hash;
    })).map(function (hash) {
        return util.reverseBuffer(Buffer.from(hash, 'hex'));
    });

    while (hashes.length > 1) {
        var parents = [];
        for (var i = 0; i < hashes.length; i += 2) {
            var right = hashes[i + 1] || hashes[i];
            parents.push(util.sha256d(Buffer.concat([hashes[i], right])));
        }
        hashes = parents;
    }
    return hashes[0].toString('hex');
};
