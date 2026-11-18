import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSubscriptionEngine } from '../engine.mjs';
import { RepairError, repairLoonVlessSource } from '../../scripts/repair-loon-vless.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const worker = 'worker.example';
const config = {
  epd: 'no', epi: 'yes', egi: 'no', ena: 'no', ev: 'yes', et: 'yes', ex: 'no', ech: 'no',
  yx: '192.0.2.10:443#tls\n192.0.2.11:80#plain',
};
const fixedSnippet = '`"$' + '{数量值545.uuid}"`, `udp=true`, `transport=ws`';
const brokenSnippet = '`udp=true`, `username=$' + '{数量值545.uuid}`, `transport=ws`';
const misplacedSnippet = '`udp=true`, `"$' + '{数量值545.uuid}"`, `transport=ws`';

async function render(target) {
  const response = await createSubscriptionEngine(config, uuid).subscribe(new Request('https://' + worker + '/' + uuid + '/sub?target=' + target));
  assert.equal(response.status, 200, target);
  const text = await response.text();
  if (target === 'base64' || target === 'v2ray') return Buffer.from(text, 'base64').toString('utf8');
  return text;
}

function splitFields(value) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ',' && !quoted) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted) throw new Error('unbalanced quotes: ' + value);
  fields.push(current);
  return fields;
}

function proxyLines(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('[Proxy]');
  assert.ok(start >= 0);
  const nodes = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) break;
    const parts = lines[index].split(' = ');
    assert.equal(parts.length, 2, lines[index]);
    nodes.push({ name: parts[0], fields: splitFields(parts[1]) });
  }
  return nodes;
}

function fieldMap(fields) {
  const named = new Map();
  for (const field of fields) {
    const split = field.indexOf('=');
    if (split > 0) named.set(field.slice(0, split), field.slice(split + 1));
  }
  return named;
}

function pathOf(value) {
  const url = new URL(value, 'https://' + worker);
  return { pathname: url.pathname, ed: url.searchParams.get('ed'), raw: value };
}

test('Loon VLESS uses a positional quoted UUID and keeps path, UDP, host, and TLS', async () => {
  const nodes = proxyLines(await render('loon'));
  assert.equal(nodes.length, 4);
  const tls = nodes.find(node => node.name === 'tls-01');
  const plain = nodes.find(node => node.name === 'plain-01');
  assert.deepEqual(tls.fields, [
    'vless', '192.0.2.10', '443', '"' + uuid + '"', 'udp=true', 'transport=ws',
    'path=/?ed=2048', 'host=' + worker, 'over-tls=true', 'tls-name=' + worker, 'skip-cert-verify=false',
  ]);
  assert.deepEqual(plain.fields, [
    'vless', '192.0.2.11', '80', '"' + uuid + '"', 'udp=true', 'transport=ws',
    'path=/?ed=2048', 'host=' + worker, 'over-tls=false',
  ]);
  for (const node of [tls, plain]) {
    assert.equal(node.fields[0], 'vless');
    assert.equal(node.fields[3], '"' + uuid + '"');
    assert.equal(fieldMap(node.fields).has('username'), false);
    const path = pathOf(fieldMap(node.fields).get('path'));
    assert.equal(path.raw, '/?ed=2048');
    assert.equal(path.pathname, '/');
    assert.equal(path.ed, '2048');
    assert.equal(fieldMap(node.fields).get('udp'), 'true');
    assert.equal(fieldMap(node.fields).get('host'), worker);
    assert.equal(fieldMap(node.fields).get('transport'), 'ws');
  }
  assert.equal(fieldMap(tls.fields).get('over-tls'), 'true');
  assert.equal(fieldMap(tls.fields).get('tls-name'), worker);
  assert.equal(fieldMap(tls.fields).get('skip-cert-verify'), 'false');
  assert.equal(fieldMap(plain.fields).has('tls-name'), false);
  assert.equal(fieldMap(plain.fields).has('skip-cert-verify'), false);
  assert.equal(fieldMap(plain.fields).get('over-tls'), 'false');

  const trojans = nodes.filter(node => node.fields[0] === 'trojan');
  assert.equal(trojans.length, 2);
  for (const node of trojans) {
    assert.equal(node.fields[3], 'password=' + uuid);
    assert.equal(node.fields[3].startsWith('"'), false);
    assert.equal(fieldMap(node.fields).get('path'), '/?ed=2048');
    assert.equal(fieldMap(node.fields).get('transport'), 'ws');
    assert.equal(fieldMap(node.fields).get('host'), worker);
    assert.equal(fieldMap(node.fields).has('username'), false);
  }
  assert.equal(nodes.some(node => node.fields.join(',').includes('username=')), false);
});

test('other subscription formats keep their own credentials and the early-data path', async () => {
  const links = (await render('base64')).trim().split('\n').map(line => new URL(line));
  assert.equal(links.length, 4);
  const vlessLinks = links.filter(link => link.protocol === 'vless:');
  const trojanLinks = links.filter(link => link.protocol === 'trojan:');
  assert.equal(vlessLinks.length, 2);
  assert.equal(trojanLinks.length, 2);
  for (const link of links) {
    assert.equal(link.username, uuid);
    assert.equal(link.searchParams.get('path'), '/?ed=2048');
    assert.equal(link.searchParams.get('host'), worker);
    assert.equal(link.searchParams.get('type'), 'ws');
  }
  assert.equal(vlessLinks.find(link => link.port === '443').searchParams.get('security'), 'tls');
  assert.equal(vlessLinks.find(link => link.port === '443').searchParams.get('sni'), worker);
  assert.equal(vlessLinks.find(link => link.port === '80').searchParams.get('security'), 'none');
  assert.equal(vlessLinks.find(link => link.port === '80').searchParams.has('sni'), false);

  const singbox = JSON.parse(await render('singbox'));
  const leaves = singbox.outbounds.filter(node => node.type === 'vless' || node.type === 'trojan');
  assert.equal(leaves.length, 4);
  for (const node of leaves.filter(item => item.type === 'vless')) {
    assert.equal(node.uuid, uuid);
    assert.equal(node.password, undefined);
    assert.equal(node.transport.type, 'ws');
    assert.equal(node.transport.path, '/?ed=2048');
    assert.equal(node.transport.headers.Host, worker);
  }
  for (const node of leaves.filter(item => item.type === 'trojan')) {
    assert.equal(node.password, uuid);
    assert.equal(node.uuid, undefined);
    assert.equal(node.transport.path, '/?ed=2048');
  }
  assert.equal(leaves.find(node => node.type === 'vless' && node.server_port === 443).tls.enabled, true);
  assert.equal(leaves.find(node => node.type === 'vless' && node.server_port === 443).tls.server_name, worker);
  assert.equal(Object.hasOwn(leaves.find(node => node.type === 'vless' && node.server_port === 80), 'tls'), false);

  const quanx = (await render('quanx')).split('\n').filter(line => line.startsWith('vless=') || line.startsWith('trojan='));
  assert.equal(quanx.length, 4);
  assert.equal(quanx.filter(line => line.startsWith('vless=')).length, 2);
  for (const line of quanx) {
    assert.equal(line.includes('username='), false);
    assert.match(line, new RegExp('password=' + uuid));
    assert.match(line, /obfs-uri=\/\?ed=2048/);
  }
  assert.match(quanx.find(line => line.startsWith('vless=') && line.includes(':443')), /obfs=wss/);
  assert.match(quanx.find(line => line.startsWith('vless=') && line.includes(':80')), /obfs=ws/);

  const surge = (await render('surge')).split('\n').filter(line => line.includes('192.0.2.'));
  assert.equal(surge.length, 2);
  for (const line of surge) {
    assert.match(line, /^[^ ]+ = trojan, /);
    assert.match(line, new RegExp('password=' + uuid));
    assert.match(line, /ws-path=\/\?ed=2048/);
    assert.equal(line.includes('vless'), false);
    assert.equal(line.includes('username='), false);
  }

  const clashNodes = [];
  let block = null;
  for (const line of (await render('clash')).split('\n')) {
    if (line.startsWith('  - name: ')) {
      if (block) clashNodes.push(block);
      block = [line];
    } else if (block && line.startsWith('    ')) block.push(line);
    else if (block) {
      clashNodes.push(block);
      block = null;
    }
  }
  if (block) clashNodes.push(block);
  const proxies = clashNodes.filter(lines => lines.some(line => line === '    type: vless' || line === '    type: trojan'));
  assert.equal(proxies.length, 4);
  const clashVless = proxies.filter(lines => lines.includes('    type: vless'));
  assert.equal(clashVless.length, 2);
  for (const lines of clashVless) {
    assert.ok(lines.includes('    uuid: ' + uuid));
    assert.ok(lines.includes('      path: "/?ed=2048"'));
    assert.equal(lines.some(line => line.includes('username')), false);
  }
  assert.ok(clashVless.find(lines => lines.includes('    server: "192.0.2.10"')).includes('    tls: true'));
  assert.ok(clashVless.find(lines => lines.includes('    server: "192.0.2.11"')).includes('    tls: false'));
  for (const lines of proxies.filter(lines => lines.includes('    type: trojan'))) {
    assert.ok(lines.includes('    password: "' + uuid + '"'));
    assert.ok(lines.includes('      path: "/?ed=2048"'));
  }
});

test('Loon credential repair is idempotent and refuses a drifted serializer', async () => {
  const source = await readFile(new URL('../engine.mjs', import.meta.url), 'utf8');
  const passwords = source.split('\n').filter(line => line.includes('password='));
  assert.equal(source.includes(fixedSnippet), true);
  assert.equal(source.includes('username='), false);
  const unchanged = repairLoonVlessSource(source);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.source, source);

  const repaired = repairLoonVlessSource(source.replace(fixedSnippet, brokenSnippet));
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.source, source);
  assert.equal(repairLoonVlessSource(repaired.source).status, 'unchanged');
  assert.equal(repairLoonVlessSource(source.replace(fixedSnippet, misplacedSnippet)).source, source);
  assert.deepEqual(repaired.source.split('\n').filter(line => line.includes('password=')), passwords);

  assert.throws(() => repairLoonVlessSource('const value = 1;\n'), RepairError);
  assert.throws(() => repairLoonVlessSource(source + '\nconst note = "username=extra";\n'), /refusing to guess/);
  assert.throws(() => repairLoonVlessSource(source.replace(fixedSnippet, brokenSnippet) + source.replace(fixedSnippet, brokenSnippet)), /matched 2 times/);
});
