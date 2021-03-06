/*
 * Copyright 2016 Joyent, Inc.
 */

var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');

var libuuid = require('uuid');
var MemoryStream = require('readable-stream/passthrough.js');
var bunyan = require('bunyan');
var format = require('util').format;
var vasync = require('vasync');

var logging = require('./lib/logging');
var manta = require('../lib');


/*
 * Globals
 */

var log = logging.createLogger();

var ROOT = '/' + (process.env.MANTA_USER || 'admin') + '/stor';
var PUBLIC = '/' + (process.env.MANTA_USER || 'admin') + '/public';
var TSTDIR = ROOT + '/node-manta-test-muntar-' + libuuid.v4().split('-')[0];


/*
 * Helper functions
 */

function test(name, testfunc) {
    module.exports[name] = testfunc;
}



/*
 * Pre- and Post-test actions
 */

module.exports.setUp = function (cb) {
    var self = this;
    var url = process.env.MANTA_URL || 'http://localhost:8080';
    var user = process.env.MANTA_USER || 'admin';

    function createClient(signer) {
        self.client = manta.createClient({
            connectTimeout: 1000,
            log: log,
            rejectUnauthorized: (process.env.MANTA_TLS_INSECURE ?
                                    false : true),
            sign: signer,
            url: url,
            user: user
        });

        cb();
    }

    if (process.env.MANTA_KEY_ID) {
        createClient(manta.cliSigner({
            user: user,
            keyId: process.env.MANTA_KEY_ID
        }));
    } else {
        var f = process.env.SSH_KEY || process.env.HOME + '/.ssh/id_rsa';
        var cmd = 'ssh-keygen -l -f ' +
            f + ' ' +
            '| awk \'{print $2}\'';
        fs.readFile(f, 'utf8', function (err, key) {
            if (err) {
                cb(err);
                return;
            }

            exec(cmd, function (err2, stdout, stderr) {
                if (err2) {
                    (cb(err2));
                    return;
                }
                createClient(manta.privateKeySigner({
                    key: key,
                    keyId: stdout.replace('\n', ''),
                    user: user
                }));
                return;
            });
            return;
        });
    }
};


module.exports.tearDown = function (cb) {
    if (this.client) {
        this.client.close();
        delete this.client;
    }
    cb();
};


/*
 * Tests
 */

// muntar tests
var cases = [
    {
        tarpath: 'corpus/tar1.tar',
        checks: [
            {
                path: 'subdir1/',
                type: 'application/x-json-stream; type=directory'
            },
            {
                path: 'subdir1/test.txt',
                type: 'text/plain',
                size: 24,
                md5: 'jio1WnSoM7CbsXjNHfTqwg=='
            },
            {
                path: 'test.txt',
                type: 'text/plain',
                size: 20,
                md5: 'c6scKv46Y7irTX2ipN2zUQ=='
            }
        ]
    },
    {
        // Skipping, see <https://github.com/joyent/node-manta/issues/259>
        skip: true,
        tarpath: 'corpus/259-emptydir.tar',
        checks: [
            { path: 'emptydir/', type: 'directory' }
        ]
    }
];

cases.forEach(function (c, i) {
    if (c.skip) {
        return;
    }

    var name = format('muntar case %d: %s', i, c.tarpath);
    var cmd = format('%s -f %s %s', path.resolve(__dirname, '../bin/muntar'),
        path.resolve(__dirname, c.tarpath), TSTDIR);
    log.debug({caseName: name, cmd: cmd}, 'run case');

    test(name, function (t) {
        var self = this;
        exec(cmd, function (err, stdout, stderr) {
            t.ifError(err);
            vasync.forEachPipeline({
                func: function checkOne(check, cb) {
                    var mpath = path.join(TSTDIR, check.path);
                    self.client.info(mpath, function (err2, info) {
                        t.ifError(err2, err2);
                        if (!err2) {
                            t.equal(info.type, check.type, format(
                                '%s is expected type (%s): %s',
                                mpath, check.type, info.type));
                            if (check.size) {
                                t.equal(info.size, check.size, format(
                                    '%s is expected size (%s): %s',
                                    mpath, check.size, info.size));
                            }
                            if (check.md5) {
                                t.equal(info.md5, check.md5, format(
                                    '%s is expected md5 (%s): %s',
                                    mpath, check.md5, info.md5));
                            }
                        }
                        cb();
                    });
                },
                inputs: c.checks
            }, function (err3, results) {
                self.client.rmr(TSTDIR, function (rmErr) {
                    t.ifError(rmErr, rmErr);
                    t.done();
                });
            });
        });
    });
});
