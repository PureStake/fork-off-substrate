const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers')
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { HttpProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const execFileSync = require('child_process').execFileSync;
const execSync = require('child_process').execSync;
const binaryPath = path.join(__dirname, 'data', 'binary');
const wasmPath = path.join(__dirname, 'data', 'runtime.wasm');
const schemaPath = path.join(__dirname, 'data', 'schema.json');
const hexPath = path.join(__dirname, 'data', 'runtime.hex');
const originalSpecPath = path.join(__dirname, 'data', 'genesis.json');
const forkedSpecPath = path.join(__dirname, 'data', 'fork.json');
const storagePath = path.join(__dirname, 'data', 'storage.json');

// Using http endpoint since substrate's Ws endpoint has a size limit.
const provider = new HttpProvider(process.env.HTTP_RPC_ENDPOINT || 'http://localhost:9933')
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];
const skippedModulesPrefix = ['System', 'Session', 'Babe', 'Grandpa', 'GrandpaFinality', 'FinalityTracker', 'Authorship'];

async function main(argv) {
  if (!fs.existsSync(binaryPath)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', binaryPath]);

  if (!fs.existsSync(wasmPath)) {
    console.log(chalk.red('WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'));
    process.exit(1);
  }
  execSync('cat ' + wasmPath + ' | hexdump -ve \'/1 "%02x"\' > ' + hexPath);

  let api;
  console.log(chalk.green('We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them.'));
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow('Custom Schema missing, using default schema.'));
    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(chalk.yellow('Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage'));
  } else {
    // Download state of original chain
    console.log(chalk.green('Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.'));
    if (argv.block) {
      console.log(chalk.yellow(`Using specified block: ${argv.block}`));
    }
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: 'a' });
    stream.write("[");
    await fetchChunks("0x", argv.block, chunksLevel, stream);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = JSON.parse(metadata.asLatest.modules);
  modules.forEach((module) => {
    if (module.storage) {
      if (!skippedModulesPrefix.includes(module.storage.prefix)) {
        prefixes.push(xxhashAsHex(module.storage.prefix, 128));
      }
    }
  });

  // Generate chain spec for original and forked chains
  execSync(`${binaryPath} build-spec --chain ${argv.chain} --raw > ${originalSpecPath}`);
  execSync(`${binaryPath} build-spec --dev --raw > ${forkedSpecPath}`);

  let storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, 'utf8'));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, 'utf8'));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + '-fork';
  forkedSpec.id = originalSpec.id + '-fork';
  forkedSpec.protocolId = originalSpec.protocolId;

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top['0x3a636f6465'] = '0x' + fs.readFileSync(hexPath, 'utf8').trim();

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  // Adjust HostConfiguration so that validationUpgradeFrequency and validationUpgradeDelay are 1 each
  forkedSpec.genesis.raw.top['0x45323df7cc47150b3930e2666b0aa313c522231880238a0c56021b8744a00743'] = '0x0000a000005000000a00000000c8000000c800000a0000000a0000000100000001000000';

  // Set council and technical committee to Alice only
  forkedSpec.genesis.raw.top['0x11f3ba2e1cdd6d62f2ff9b5589e7ff81ba7fb8745735dc3be2a2c61a72c39e78'] = '0x04f24ff3a9cf04c71dbc94d0b566f7a27b94566cac';
  forkedSpec.genesis.raw.top['0x8985776095addd4789fccbce8ca77b23ba7fb8745735dc3be2a2c61a72c39e78'] = '0x04f24ff3a9cf04c71dbc94d0b566f7a27b94566cac';
  
  // Set eligibility to 0x64
  forkedSpec.genesis.raw.top['0x76310ee24dbd609d21d08ad7292757d0e48df801946c7a0cc54f1a4e51592741'] = '0x64';

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log('Forked genesis generated successfully. Find it at ./data/fork.json');
  process.exit();
}

const argv = yargs(hideBin(process.argv))
  .option('chain', {
    type: 'string',
    description: 'chain to specify when building spec',
  })
  .option('block', {
    type: 'string',
    description: 'hash of desired block',
  })
  .demandOption(['chain'], 'Please specify which chain to use.')
  .help()
  .argv;

main(argv);

async function fetchChunks(prefix, block, levelsRemaining, stream) {
  if (levelsRemaining <= 0) {
    const pairs = await provider.send('state_getPairs', [prefix, block]);
    if (pairs.length > 0) {
      separator ? stream.write(",") : separator = true;
      stream.write(JSON.stringify(pairs).slice(1, -1));
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(fetchChunks(prefix + i.toString(16).padStart(2, "0"), block, levelsRemaining - 1, stream));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(prefix + i.toString(16).padStart(2, "0"), block, levelsRemaining - 1, stream);
    }
  }
}
