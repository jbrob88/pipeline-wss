import { createRequire } from 'module';
import { SocketAddress } from 'net';

const require = createRequire(import.meta.url);

const WebSocket2 = require('ws');
const fs = require('fs');
const path = require('path');

const wss = new WebSocket2.Server({ port: '8081' });
const pipeline = [];
let allResults = {};

console.log("Server online.");

function readPipeline(dir) {
    // read directory
    fs.readdir(dir, (err, fileNames) => {
        if (err) {
            console.log('ERROR: unable to read directory ' + dir + ': ' + err);
        }
  
        fileNames.forEach(filename => {
            const parsed = path.parse(filename);
            const name = parsed.name;
            const ext = parsed.ext;

            if (ext != '.json') {
                console.log('WARNING: non-json file ' + filename + ' with extension ' + ext + ' ignored.');
                return;
            }

            // Get current file path.
            const filepath = path.resolve(dir, filename);

            // Get information about the file.
            fs.stat(filepath, function(err, stat) {
                if (err) {
                    console.log('ERROR: unable to read file stats for ' + filepath + ': '  + err);
                    return;
                }

                // Only read files, not folders.
                const isFile = stat.isFile();
                if (!isFile) {
                    return;
                }

                fs.readFile(filepath, 'utf-8', function(err, contents) {
                    if (err) {
                        console.log('ERROR: unable to read file ' + filepath + ': ' + err);
                        return;
                    }
                    let module = JSON.parse(contents);
                    module.id = name;
                    pipeline.push(module);
                });
            });
        });
    });
}
readPipeline('./modules');

function randID() {
    return Date.now().toString(16) + '-' + Math.random().toString(16).substring(2);
}
wss.on('connection', ws => {
    let id = randID();
    id = id.substring(id.length - 6, id.length);
    const addr = new SocketAddress(ws);
    const fqAddr = addr.address + ':' + addr.port;
    console.log('New connection from', fqAddr, '(' + id + ') --', wss.clients.size, 'connection' + (wss.clients == 1 ? '' : 's') + ' active');

    ws.isAlive = true;
    ws.on('pong', function() {
        this.isAlive = true;
    });
    ws.on('error', console.error);
    ws.on('message', message => {
        console.log('New message ' + message + ' from', fqAddr, '(' + id + ')');
        handleCommand(ws, message);
    });
    ws.on('close', function() {
        ws.terminate();
        console.log(id, 'disconnected --', wss.clients.size, 'connection' + (wss.clients.size == 1 ? '' : 's') + ' active');
    });

    ws.send(JSON.stringify({ pipeline: pipeline.map( m => ({ id: m.id, parentIds: m.parentIds })) }));
    ws.send(JSON.stringify(Object.values(allResults)));
});

// Make sure connections are still alive.
setInterval(function ping() {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
  
        ws.isAlive = false;
        ws.ping();
    });
  }, 30000);

function handleCommand(ws, cmd) {
    switch(String(cmd)) {
        case 'INJECT_TARGETS':
            injectTargets(1);
            break;
        case 'RESET_TARGETS':
            resetTargets();
            break;
        default:
            console.log('WARNING: received unhandled command \'' + cmd + '\'');
            break;
    }
}

let moduleTimeouts = new Set();
function queueFunc(timeout, fn) {
    const handle = { id: 0 };
    handle.id = setTimeout(function() {
        moduleTimeouts.delete(handle.id);
        fn();
    }, timeout);
    moduleTimeouts.add(handle.id);
}
function clearTimeouts() {
    for (const t of moduleTimeouts) {
        clearTimeout(t);
    }
    moduleTimeouts.clear();
}
function injectTargets(n) {
    recordResults([{ targetCount: n }]);
    for (let i = 0; i < n; i++) {
        injectTarget(randTarget());
    }
}
function resetTargets() {
    clearTimeouts();
    allResults = {};
    wss.clients.forEach(ws => {
        ws.send(JSON.stringify({reset: true}));
    });
}

/*
Filters can be one of:
- and: An array containing any number of filters.
- or: An array containing any number of filters.
- not: A
- target: An object containing { property, value }. Returnes true if the target's named property matches value.
- dep: An object containing { module, result } or { module, results }. Returns true if the specified dependency returned the specified result(s).

One can be specified in the 'filter' field, or an array of them can be specified in the 'filters' field.
*/
function filter(f, t, r) {
    if (f == undefined) {
        return {matched: true, reason: ''};
    }
    if (f.hasOwnProperty('and')) {
        let allReasons = '';
        for (let i in f.and) {
            const f2 = f.and[i];
            const {matched, reason} = filter(f2, t, r);
            if (!matched) {
                return {matched: false, reason: reason};
            }
            if (allReasons != '') {
                allReasons += ' && '
            }
            allReasons += reason;
        }
        return {matched: true, reason: allReasons};
    }
    if (f.hasOwnProperty('or')) {
        let allReasons = ''
        for (let i in f.or) {
            const f2 = f.or[i];
            const {matched, reason} = filter(f2, t, r);
            if (matched) {
                return {matched: true, reason: reason};
            }
            if (allReasons != '') {
                allReasons += ' && '
            }
            allReasons += reason;
        }
        return {matched: false, reason: allReasons};
    }
    if (f.hasOwnProperty('not')) {
        const {matched, reason} = filter(f.not, t, r);
        if (matched) {
            return {matched: false, reason: reason};
        }
        return {matched: true, reason: reason};
    }
    if (f.hasOwnProperty('target')) {
        if (t[f.target.property] != f.target.value) {
            return {matched: false, reason: 'target.' + f.target.property + ' (' + t[f.target.property] + ') != ' + f.target.value};
        }
        return {matched: true, reason: 'target.' + f.target.property + ' (' + t[f.target.property] + ') == ' + f.target.value};
    }
    if (f.hasOwnProperty('dep')) {
        if (f.dep.hasOwnProperty('results')) {
            for (let i in f.dep.results) {
                const r2 = f.dep.results[i];
                if (r[f.dep.module] == r2) {
                    return {matched: true, reason: 'dep.' + f.dep.module + ' (' + r[f.dep.module] + ') in ' + JSON.stringify(f.dep.results)};
                }
            };
            return {matched: false, reason: '!(dep.' + f.dep.module + ' (' + r[f.dep.module] + ') in ' + JSON.stringify(f.dep.results) + ')'};
        }
        const res = (r[f.dep.module] == f.dep.result);
        if (!res) {
            return {matched: false, reason: 'dep.' + f.dep.module + ' (' + r[f.dep.module] + ') != ' + f.dep.result};
        }
        return {matched: true, reason: 'dep.' + f.dep.module + ' (' + r[f.dep.module] + ') == ' + f.dep.result};
    }
}

function injectTarget(t) {
    const results = {};

    function runReadyModules() {
        for (let k in pipeline) {
            const m = pipeline[k];
            // Skip modules that have already started.
            if (results.hasOwnProperty(m.id)) {
                continue;
            }
            // Skip modules where not all parents are ready.
            let skip = false;
            for (let pid in m.parentIds) {
                if (! results.hasOwnProperty(m.parentIds[pid]) || results[m.parentIds[pid]] == 'pending') {
                    skip = true;
                    break;
                }
            }
            if (skip) {
                continue;
            }
            runModule(m);
        }
    }

    function markWontRun(m, rsn) {
        results[m.id] = 'wontRun';
        let result = {
            module: m.id,
            wontRun: {
                count: 1,
                details: [
                    {
                        target: t,
                        reason: rsn,
                    },
                ],
            },
        };
        recordResults([result]);
    }

    function runModule(m) {
        // Mark as wontRun if filter doesn't match.
        let matched = true;
        let reason = '';
        if (m.hasOwnProperty('filters')) {
            const f = filter({and: m.filters}, t, results);
            matched = f.matched;
            reason = f.reason;
        } else if (m.hasOwnProperty('filter')) {
            const f = filter(m.filter, t, results);
            matched = f.matched;
            reason = f.reason;
        }
        if (!matched) {
            markWontRun(m, reason);
            runReadyModules();
            return;
        }
        // Mark as pending.
        results[m.id] = 'pending';
        let resultObj = {
            module: m.id,
            pending: {
                count: 1,
                details: [
                    {
                        target: t,
                    },
                ],
            },
        };
        recordResults([resultObj]);
        // Wait for a bit, then mark final result.
        queueFunc(randTime(m), function() {
            const {result, reason} = randResult(m);
            results[m.id] = result;
            resultObj.pending = {
                count: -1,
                removeDetails: [
                    {
                        target: t,
                    },
                ],
            };
            resultObj[result] = {
                count: 1,
                details: [
                    {
                        target: t,
                        reason: reason,
                    },
                ],  
            };
            recordResults([resultObj]);
            // Now that new results are finished, check for ready modules again.
            runReadyModules();
        });
    }

    runReadyModules();
}

function randSpecies() {
    const r = Math.random();
    if (r < 0.45) {
        return 'cow';
    }
    if (r < 0.72) {
        return 'goat';
    }
    if (r < 0.9) {
        return 'horse';
    }
    return 'llama';
}
function randTarget() {
    return {
        id: randID(),
        species: randSpecies(),
    };
}
function randResult(module) {
    const weights = module.resultWeights;
    const spinner = {};
    let total = 0;
    for (const i in weights) {
        const w = weights[i];
        total += w.weight;
    };
    const r = Math.random() * total;
    total = 0;
    for (const i in weights) {
        const w = weights[i];
        total += w.weight;
        if (r <= total) {
            return {result: w.result, reason: w.reason};
        }
    }
}
function randTime(module) {
    const t = module.executionTime;
    return Math.random() * (t.max - t.min) + t.min;
}

// Results should either be in the form { targetCount: x } or:
// {
//     module: 'module_name',
//     pending: {
//         count: x,
//     },
// },
function recordResults(results) {
    results.forEach(r => {
        storeResultLocally(r);
    });
    wss.clients.forEach(ws => {
        ws.send(JSON.stringify(results));
    });
}

function storePropertyLocally(moduleName, result, property) {
    if (! result.hasOwnProperty(property)) {
        return;
    }
    const module = allResults[moduleName];
    if (! module.hasOwnProperty(property)) {
        module[property] = { count: 0, details: [] };
    }
    const p = module[property];
    p.count += result[property].count;
    if (result[property].hasOwnProperty('removeDetails')) {
        p.details = p.details.splice(p.details.indexOf(result[property].removeDetails), 1);
    }
    if (result[property].hasOwnProperty('details')) {
        p.details.push(...(result[property].details));
    }
}

function storeResultLocally(result) {
    if (result.hasOwnProperty('targetCount')) {
        if (! allResults.hasOwnProperty('$targetCount')) {
            allResults['$targetCount'] = { targetCount: 0 };
        }
        allResults['$targetCount'].targetCount += result.targetCount;
    }
    if (! result.hasOwnProperty('module')) {
        return;
    }
    if (! allResults.hasOwnProperty(result.module)) {
        allResults[result.module] = { module: result.module };
    }
    ['success', 'fail', 'pending', 'wontRun', 'error'].forEach(prop => {
        storePropertyLocally(result.module, result, prop);
    });
}
