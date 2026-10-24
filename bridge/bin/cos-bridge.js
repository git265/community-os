#!/usr/bin/env node
// The CommunityOS site bridge. Settings: COS_SERVER, COS_BRIDGE_TOKEN, COS_STATE_DIR (see README.md).
import { loadConfig } from '../src/config.js';
import { Cloud } from '../src/cloud.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { log } from '../src/log.js';

let cfg;
try { cfg = loadConfig(); } catch (e) { log.error(e.message); process.exit(2); }
const bridge = new Bridge(cfg, { cloud: new Cloud(cfg), store: new Store(cfg.stateDir) });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await bridge.stop(); process.exit(0); });
bridge.start().catch((e) => { log.error('could not start', e); process.exit(1); });
