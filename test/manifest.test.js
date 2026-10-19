// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also keep
// the texts clean (no mojibake, no BOM) and honest (never tested, unofficial,
// a secret field is not "encrypted").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import {
  ACTIONS,
  ARM_MODES,
  LIMITS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  STAY_MODES,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const values = (field) => field.options.map((o) => o.value);
const partitionValues = Array.from({ length: LIMITS.maxPartitions }, (_, i) => String(i + 1));
const TEXT_FILES = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
];

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers and actions need Gladys 5.1');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-satel-integra:${manifest.version}`);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['security']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+SATEL|sans\s+lien\s+avec\s+SATEL/i);
    assert.match(docs, /never\s+(been\s+)?tested|jamais\s+(été\s+)?testée?/i, `docs/${lang}.md`);
  }
});

test('no double-encoded UTF-8 (mojibake) and no BOM in the texts', () => {
  // U+00C3 U+00A9 for "Ã©", U+00C2 U+00AB for "Â«", U+00E2 U+20AC for "â€":
  // UTF-8 read as Windows-1252 and written again. Built from code points so
  // this file never holds one.
  const c = (code) => String.fromCharCode(code);
  const mojibake = new RegExp(
    `[${c(0xc2)}${c(0xc3)}][${c(0x80)}-${c(0xbf)}${c(0x20ac)}${c(0x201a)}-${c(0x2122)}]|${c(0xe2)}${c(0x20ac)}`,
  );
  assert.match(`caf${c(0xc3)}${c(0xa9)}`, mojibake, 'the guard catches a double encoding');
  assert.match(`${c(0xe2)}${c(0x20ac)}${c(0x201d)}`, mojibake, 'and the dash family');
  for (const path of TEXT_FILES) {
    const text = read(path);
    assert.doesNotMatch(text, mojibake, path);
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${path} starts with a BOM`);
  }
});

test('a secret field is never said to be encrypted', () => {
  // The texts speak of the AES layer of the ETHM-1 Plus as "AES" only, so
  // that no sentence can read as "the secret is stored encrypted".
  // THIRD_PARTY_NOTICES.md names the ported file `encryption.py`: left out.
  for (const path of TEXT_FILES.filter((p) => p !== 'THIRD_PARTY_NOTICES.md')) {
    // "chiffres" (digits) is fine, "chiffré" (encrypted) is not.
    assert.doesNotMatch(read(path), /chiffré|chiffrement|\bencrypt/i, path);
  }
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.match(field.description.en, /Kept by Gladys in its database, never shown again/);
    assert.match(field.description.fr, /par Gladys dans sa base, jamais réaffiché/);
  }
});

test('the licence names nobody; the reference is credited in full', () => {
  const licence = read('LICENSE');
  assert.match(licence, /Apache License/);
  assert.match(licence, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(licence, /Copyright (?:\(c\) )?\d{4}/i);
  assert.match(
    read('THIRD_PARTY_NOTICES.md'),
    /satel-integra[\s\S]*1\.5\.0[\s\S]*MIT License[\s\S]*Krzysztof Machelski[\s\S]*THE SOFTWARE IS PROVIDED "AS IS"/,
  );
  assert.match(read('Dockerfile'), /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.equal(fields.allow_disarm.default, false, 'disarming from Gladys is opt-in');
  assert.equal(fields.allow_outputs.default, false, 'the outputs are opt-in');
  assert.equal(fields.allow_arm.default, true);
  assert.equal(fields.user_code.type, 'secret', 'the code is never sent back to the browser');
  assert.equal(fields.integration_key.type, 'secret');
  assert.match(fields.integration_key.description.en, /clear text/);
  // M10: what the texts must say.
  assert.match(fields.user_code.description.en, /Without an integration key it travels in clear/);
  assert.match(fields.user_code.description.fr, /circule en clair/);
  assert.match(fields.integration_key.description.en, /replayed/);
  assert.match(fields.integration_key.description.fr, /rejouée/);
  assert.match(fields.allow_arm.description.en, /false alarm.*monitoring company/);
  assert.match(fields.allow_arm.description.fr, /fausse alarme.*télésurveillance/);
  for (const lang of ['en', 'fr']) {
    const docs = read(`docs/${lang}.md`);
    assert.match(docs, lang === 'en' ? /replay/ : /rejeu/, `docs/${lang}.md`);
    assert.match(docs, lang === 'en' ? /monitoring company/ : /télésurveillance/);
    assert.match(
      docs,
      lang === 'en' ? /Allow a new try of the code/ : /Autoriser un nouvel essai du code/,
    );
  }
  assert.deepEqual(values(fields.language), LANGUAGES);
  assert.deepEqual(values(fields.stay_mode), STAY_MODES);
  assert.equal(fields.host.required, true);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} too long`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  const action = (key) => manifest.scene_actions.find((a) => a.key === key);
  const field = (item, key) => item.fields.find((f) => f.key === key);
  assert.deepEqual(values(field(action('arm'), 'mode')), ARM_MODES);
  assert.deepEqual(values(field(action('arm'), 'partition')), partitionValues);
  assert.deepEqual(values(field(action('disarm'), 'partition')), partitionValues);
});

test('the trigger fields and variables are what the events carry', () => {
  const expected = {
    alarm_triggered: ['partition', 'partition', 'zone', 'fire'],
    armed: ['partition', 'mode', 'partition', 'mode', 'by_gladys'],
    disarmed: ['partition', 'partition', 'by_gladys'],
  };
  for (const trigger of manifest.scene_triggers) {
    const declared = [...(trigger.fields ?? []), ...(trigger.variables ?? [])].map((f) => f.key);
    assert.deepEqual(declared, expected[trigger.key], trigger.key);
    for (const key of new Set(declared)) {
      assert.match(app, new RegExp(`\\b${key}[:,\\s}]`), `${trigger.key}: ${key} is never sent`);
    }
    assert.deepEqual(values(trigger.fields[0]), partitionValues, 'partitions sent as strings');
  }
  const modes = manifest.scene_triggers.find((t) => t.key === 'armed').fields[1];
  assert.deepEqual(values(modes), ARM_MODES);
});
