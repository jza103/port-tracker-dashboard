#!/usr/bin/env node
// Applies changes from a "[dashboard]" GitHub issue to config/projects.yml.
// The issue body comes from the dashboard's "Save to GitHub" button (a JSON
// block) or from the "Track a project" issue form. Comments in the YAML
// file are preserved.
//
// Usage: ISSUE_BODY="..." node scripts/apply-changes.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'projects.yml');

/** Issue forms render as "### Label\n\nvalue" sections. */
export function parseSections(body) {
  const out = {};
  for (const part of String(body).split(/^###\s+/m).slice(1)) {
    const [label, ...rest] = part.split('\n');
    const value = rest.join('\n').trim();
    out[label.trim().toLowerCase()] = value === '_No response_' ? '' : value;
  }
  return out;
}

export function parseChanges(body) {
  const sections = parseSections(body);
  const changes = { hide: [], unhide: [], pin: [], unpin: [], follow: [], add: [] };

  // JSON from the dashboard (possibly inside a ```json fence).
  const raw = sections.changes ?? '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenced ? fenced[1] : raw).trim();
  if (jsonText.startsWith('{')) {
    const parsed = JSON.parse(jsonText);
    for (const k of Object.keys(changes)) {
      if (Array.isArray(parsed[k])) changes[k] = parsed[k];
    }
  }

  // "Track a project" form.
  const ref = sections['repo or link'];
  if (ref) {
    const isRepo = /github\.com|gitlab\.com|^[\w.-]+\/[\w.-]+$/i.test(ref);
    const entry = { [isRepo ? 'repo' : 'url']: ref.trim() };
    if (sections.name) entry.name = sections.name;
    if (sections.game) entry.game = sections.game;
    if (sections.category) entry.category = sections.category;
    const type = (sections.type || '').toLowerCase();
    if (type && type !== 'guess') entry.type = type;
    if (/\[x\]/i.test(sections['vr port'] || '')) {
      entry.tags = ['VR'];
      entry.categories = [entry.category, 'VR Ports'].filter(Boolean);
      delete entry.category;
    }
    changes.add.push(entry);
  }
  return changes;
}

const ALLOWED_FIELDS = ['repo', 'url', 'name', 'game', 'category', 'categories', 'type', 'tags', 'description', 'links'];

function cleanEntry(e) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (e[k] == null || e[k] === '') continue;
    if (k === 'categories' || k === 'tags') out[k] = [].concat(e[k]).map(String).map((s) => s.slice(0, 80));
    else if (k === 'links') out[k] = [].concat(e[k]).filter((l) => /^https?:\/\//.test(l?.url)).map((l) => ({ label: String(l.label || 'Link').slice(0, 40), url: l.url }));
    else out[k] = String(e[k]).slice(0, 300);
  }
  if (out.url && !/^https?:\/\//.test(out.url)) delete out.url;
  return out.repo || out.url ? out : null;
}

export function applyChanges(yamlText, changes) {
  const doc = YAML.parseDocument(yamlText);
  const summary = [];
  const list = (key) => {
    let seq = doc.get(key, true);
    if (!seq || !YAML.isSeq(seq)) {
      seq = doc.createNode([]);
      doc.set(key, seq);
    }
    // Keep short lists readable on one line, long ones one per line.
    seq.flow = false;
    return seq;
  };
  const values = (seq) => seq.items.map((n) => String(YAML.isScalar(n) ? n.value : n));
  const addTo = (key, id) => {
    const seq = list(key);
    if (!values(seq).includes(id)) { seq.add(id); return true; }
    return false;
  };
  const removeFrom = (key, id) => {
    const seq = list(key);
    const i = values(seq).indexOf(id);
    if (i >= 0) { seq.items.splice(i, 1); return true; }
    return false;
  };
  const isId = (s) => typeof s === 'string' && s.length < 200 && /^[\w.:#/@-]+$/.test(s);

  for (const id of changes.hide.filter(isId)) {
    if (addTo('hidden', id)) summary.push(`Hid ${id}`);
    removeFrom('follow', id);
    removeFrom('pinned', id);
  }
  for (const id of changes.unhide.filter(isId)) if (removeFrom('hidden', id)) summary.push(`Unhid ${id}`);
  for (const id of changes.pin.filter(isId)) if (addTo('pinned', id)) summary.push(`Pinned ${id}`);
  for (const id of changes.unpin.filter(isId)) if (removeFrom('pinned', id)) summary.push(`Unpinned ${id}`);
  for (const id of changes.follow.filter(isId)) {
    if (addTo('follow', id)) summary.push(`Following ${id}`);
    removeFrom('hidden', id);
  }

  const projects = list('projects');
  const existing = new Set(projects.items.map((n) => String(n.get?.('repo') || n.get?.('url') || '').toLowerCase()));
  for (const raw of changes.add) {
    const entry = cleanEntry(raw || {});
    if (!entry) continue;
    const key = String(entry.repo || entry.url).toLowerCase();
    if (existing.has(key)) continue;
    const node = doc.createNode(entry);
    node.flow = true;
    projects.add(node);
    existing.add(key);
    summary.push(`Added ${entry.name || entry.repo || entry.url}`);
  }
  for (const key of ['hidden', 'pinned', 'follow']) {
    const seq = list(key);
    if (seq.items.length === 0) seq.flow = true;
  }
  return { text: doc.toString({ lineWidth: 0 }), summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const body = process.env.ISSUE_BODY || '';
  let changes;
  try {
    changes = parseChanges(body);
  } catch (err) {
    console.error(`Could not read the changes: ${err.message}`);
    fs.writeFileSync(process.env.SUMMARY_FILE || '/dev/null', `Could not read the changes: ${err.message}`);
    process.exit(1);
  }
  const { text, summary } = applyChanges(fs.readFileSync(FILE, 'utf8'), changes);
  fs.writeFileSync(FILE, text);
  const msg = summary.length ? summary.map((s) => `- ${s}`).join('\n') : 'Nothing to change (already applied).';
  console.log(msg);
  if (process.env.SUMMARY_FILE) fs.writeFileSync(process.env.SUMMARY_FILE, msg);
}
