#!/usr/bin/env node
/**
 * 把一个 framework-dependent 的 `dotnet publish` 产物，就地转换成本机可独立运行的自包含目录。
 *
 * 背景：标准做法是 `dotnet publish --self-contained`，但那需要下载对应的 runtime pack
 * （Microsoft.NETCore.App.Runtime.win-x64 / Microsoft.WindowsDesktop.App.Runtime.win-x64）。
 * 在没有网络、而本机已经装了 .NET 运行时的环境里，可以把 %ProgramFiles%\dotnet\shared\...
 * 展平复制到发布目录，并按 SDK 的格式补齐 runtimeconfig.json 与 deps.json。
 *
 * 用法：
 *   node make-selfcontained.js --publish-dir out \
 *        --framework Microsoft.NETCore.App --framework Microsoft.WindowsDesktop.App
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { frameworks: [], versions: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--publish-dir') args.publishDir = argv[++i];
    else if (token === '--dotnet-root') args.dotnetRoot = argv[++i];
    else if (token === '--framework') args.frameworks.push(argv[++i]);
    else if (token === '--version') args.versions.push(argv[++i]);
    else if (token === '--app-name') args.appName = argv[++i];
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.publishDir) throw new Error('缺少 --publish-dir');
  if (args.frameworks.length === 0) {
    args.frameworks = ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App'];
  }
  if (!args.dotnetRoot) {
    args.dotnetRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet');
  }
  return args;
}

/** 通过 PE 可选头里的 CLR 目录项判断是不是托管程序集。 */
function isManagedAssembly(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return false; // 'MZ'

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length) return false;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return false; // 'PE\0\0'

  const coff = peOffset + 4;
  const optionalHeaderSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buffer.readUInt16LE(optional);
  const dataDirs = magic === 0x20b ? optional + 112 : optional + 96; // PE32+ / PE32
  const clrDir = dataDirs + 14 * 8;
  if (optional + optionalHeaderSize < clrDir + 8 || clrDir + 8 > buffer.length) return false;

  const rva = buffer.readUInt32LE(clrDir);
  const size = buffer.readUInt32LE(clrDir + 4);
  return rva !== 0 && size !== 0;
}

function compareVersions(a, b) {
  const split = (value) => value.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

function latestFrameworkVersion(dotnetRoot, framework) {
  const dir = path.join(dotnetRoot, 'shared', framework);
  if (!fs.existsSync(dir)) throw new Error(`找不到共享框架目录：${dir}`);
  const versions = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory());
  if (versions.length === 0) throw new Error(`${dir} 下没有可用版本`);
  return versions.sort(compareVersions).pop();
}

function collectFrameworkFiles(dir) {
  const runtime = {};
  const native = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    if (/\.(deps|runtimeconfig)\.json$/.test(name) || name.endsWith('.pdb')) continue;
    if (/\.dll$/i.test(name) && isManagedAssembly(file)) runtime[name] = {};
    else native[name] = {};
  }
  return { runtime, native };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishDir = path.resolve(args.publishDir);
  if (!fs.existsSync(publishDir)) throw new Error(`发布目录不存在：${publishDir}`);
  const dotnetRoot = path.resolve(args.dotnetRoot);

  let appName = args.appName;
  if (!appName) {
    const configs = fs.readdirSync(publishDir).filter((f) => f.endsWith('.runtimeconfig.json'));
    if (configs.length !== 1) {
      throw new Error(`无法确定入口程序集，请用 --app-name 指定（候选：${configs.join(', ')}）`);
    }
    appName = configs[0].slice(0, -'.runtimeconfig.json'.length);
  }

  const versions = args.frameworks.map((framework, index) => {
    const explicit = args.versions[index];
    return explicit && explicit.length > 0 ? explicit : latestFrameworkVersion(dotnetRoot, framework);
  });

  // 1) hostfxr + 各框架文件展平复制到发布目录
  const hostfxr = path.join(dotnetRoot, 'host', 'fxr', versions[0], 'hostfxr.dll');
  if (!fs.existsSync(hostfxr)) throw new Error(`找不到 hostfxr：${hostfxr}`);
  fs.copyFileSync(hostfxr, path.join(publishDir, 'hostfxr.dll'));

  const packs = [];
  args.frameworks.forEach((framework, index) => {
    const version = versions[index];
    const source = path.join(dotnetRoot, 'shared', framework, version);
    if (!fs.existsSync(source)) throw new Error(`找不到框架：${source}`);
    const files = collectFrameworkFiles(source);
    packs.push({
      library: `${framework}.Runtime.win-x64/${version}`,
      runtime: files.runtime,
      native: files.native,
    });
    for (const name of [...Object.keys(files.runtime), ...Object.keys(files.native)]) {
      fs.copyFileSync(path.join(source, name), path.join(publishDir, name));
    }
    console.log(`[make-sc] 复制 ${framework} ${version}：`
      + `${Object.keys(files.runtime).length} 个托管程序集，${Object.keys(files.native).length} 个原生文件`);
  });

  // 2) runtimeconfig.json：framework/frameworks -> includedFrameworks
  const runtimeconfigPath = path.join(publishDir, `${appName}.runtimeconfig.json`);
  const runtimeconfig = JSON.parse(fs.readFileSync(runtimeconfigPath, 'utf8').replace(/^\uFEFF/, ''));
  const options = runtimeconfig.runtimeOptions ?? (runtimeconfig.runtimeOptions = {});
  delete options.framework;
  delete options.frameworks;
  options.includedFrameworks = args.frameworks.map((framework, index) => ({
    name: framework,
    version: versions[index],
  }));
  fs.writeFileSync(runtimeconfigPath, JSON.stringify(runtimeconfig, null, 2) + '\n', 'utf8');
  console.log(`[make-sc] 已改写 ${path.basename(runtimeconfigPath)}：`
    + options.includedFrameworks.map((f) => `${f.name}/${f.version}`).join(', '));

  // 3) deps.json：把框架文件登记为 runtimepack 的 runtime/native 资产
  const depsPath = path.join(publishDir, `${appName}.deps.json`);
  const deps = JSON.parse(fs.readFileSync(depsPath, 'utf8').replace(/^\uFEFF/, ''));
  const targetName = (deps.runtimeTarget && deps.runtimeTarget.name) || '';
  deps.targets = deps.targets || {};
  if (!deps.targets[targetName]) deps.targets[targetName] = {};
  const target = deps.targets[targetName];
  deps.libraries = deps.libraries || {};

  for (const pack of packs) {
    const entry = {};
    if (Object.keys(pack.runtime).length > 0) entry.runtime = pack.runtime;
    if (Object.keys(pack.native).length > 0) entry.native = pack.native;
    target[pack.library] = entry;
    deps.libraries[pack.library] = { type: 'runtimepack', serviceable: false, sha512: '' };
    console.log(`[make-sc] deps.json += ${pack.library}`
      + `（${Object.keys(pack.runtime).length} runtime / ${Object.keys(pack.native).length} native）`);
  }
  fs.writeFileSync(depsPath, JSON.stringify(deps, null, 2) + '\n', 'utf8');

  const entries = fs.readdirSync(publishDir);
  const bytes = entries.reduce((sum, name) => {
    const stat = fs.statSync(path.join(publishDir, name));
    return sum + (stat.isFile() ? stat.size : 0);
  }, 0);
  console.log(`[make-sc] 完成：${entries.length} 个条目，约 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[make-sc] 失败：${error.message}`);
  process.exit(1);
}
