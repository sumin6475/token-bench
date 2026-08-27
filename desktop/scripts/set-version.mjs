#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver>')
  process.exit(1)
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const name of ['package.json', 'package-lock.json']) {
  const file = path.join(desktop, name)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  json.version = version
  if (json.packages && json.packages['']) json.packages[''].version = version
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
}

const tauriFile = path.join(desktop, 'src-tauri', 'tauri.conf.json')
const tauri = JSON.parse(fs.readFileSync(tauriFile, 'utf8'))
tauri.version = version
fs.writeFileSync(tauriFile, JSON.stringify(tauri, null, 2) + '\n')

const cargoFile = path.join(desktop, 'src-tauri', 'Cargo.toml')
const cargo = fs.readFileSync(cargoFile, 'utf8').replace(
  /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
  `$1${version}$2`,
)
fs.writeFileSync(cargoFile, cargo)

console.log(`TokenBench version set to ${version}`)
