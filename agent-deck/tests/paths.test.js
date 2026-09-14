// tests/paths.test.js — path extraction and display shortening (shared/paths.js).
// Pure string work: the same code runs in the browser, so nothing here touches the filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bashPathTokens, displayPath, elidePath, expandHome, extractPaths, guessHome, looksLikePath } from '../shared/paths.js';

const CTX = { cwd: '/Users/me/Documents/GitHub/agent-workspace', home: '/Users/me' };

// ---------------------------------------------------------------- looksLikePath

test('looksLikePath accepts real paths and rejects noise', () => {
  for (const yes of ['/etc/hosts', '~/.claude/settings.json', './server.js', '../a/b', 'web/js/main.js',
    'server.py', 'Dockerfile', 'README', 'C:\\Users\\j\\x.txt', 'notes.md', 'a/b']) {
    assert.ok(looksLikePath(yes), `expected a path: ${yes}`);
  }
  for (const no of ['https://example.com/x', '--verbose', '-rf', '42', '3.14', '', 'hello', 'x',
    'echo', 'and then some words']) {
    assert.ok(!looksLikePath(no), `expected not a path: ${no}`);
  }
});

// ---------------------------------------------------------------- tool inputs

test('the file tools give up their file_path', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    assert.deepEqual(extractPaths(tool, { file_path: `${CTX.cwd}/server.js` }, CTX), ['server.js']);
  }
  assert.deepEqual(extractPaths('NotebookEdit', { notebook_path: '/Users/me/x.ipynb' }, CTX), ['~/x.ipynb']);
  assert.deepEqual(extractPaths('Read', {}, CTX), []);
  assert.deepEqual(extractPaths('Read', null, CTX), []);
});

test('Grep and Glob combine path and pattern', () => {
  assert.deepEqual(extractPaths('Glob', { path: `${CTX.cwd}/web`, pattern: '**/*.js' }, CTX), ['web/**/*.js']);
  assert.deepEqual(extractPaths('Glob', { pattern: 'server/*.js' }, CTX), ['server/*.js']);
  assert.deepEqual(extractPaths('Grep', { pattern: 'setInterval', path: `${CTX.cwd}/web/js` }, CTX), ['web/js']);
  // a pattern that is plainly a filename counts as a path too
  assert.deepEqual(extractPaths('Grep', { pattern: 'server.py' }, CTX), ['server.py']);
  // a regular expression does not
  assert.deepEqual(extractPaths('Grep', { pattern: '^def .*\\(self\\)' }, CTX), []);
});

test('Bash commands give up the tokens that look like paths', () => {
  assert.deepEqual(
    extractPaths('Bash', { command: 'ls -la ~/.claude/sessions && cat /etc/hosts' }, CTX),
    ['~/.claude/sessions', '/etc/hosts'],
  );
  assert.deepEqual(extractPaths('Bash', { command: 'python3 server.py --check' }, CTX), ['server.py']);
  assert.deepEqual(extractPaths('Bash', { command: 'git status' }, CTX), []);
  assert.deepEqual(extractPaths('Bash', { command: 'curl -s https://example.com/x.json' }, CTX), []);
  assert.deepEqual(bashPathTokens('FILE=/tmp/x.log tail -f /tmp/x.log'), ['/tmp/x.log'], 'de-duplicated');
  assert.deepEqual(bashPathTokens('grep -n --file=patterns.txt src/main.js'), ['patterns.txt', 'src/main.js']);
  assert.deepEqual(bashPathTokens(null), []);
});

test('an unknown tool contributes any path-shaped field whose name mentions a path', () => {
  assert.deepEqual(extractPaths('Mystery', { target_file: '/tmp/a.txt', note: '/tmp/b.txt', n: 4 }, CTX), ['/tmp/a.txt']);
});

test('paths come back de-duplicated and in order', () => {
  const out = extractPaths('Bash', { command: 'cp server.js server.js.bak && diff server.js server.js.bak' }, CTX);
  assert.deepEqual(out, ['server.js', 'server.js.bak']);
});

// ---------------------------------------------------------------- display

test('displayPath prefers cwd-relative, then ~-relative, then the path itself', () => {
  assert.equal(displayPath(`${CTX.cwd}/server/state.js`, CTX), 'server/state.js');
  assert.equal(displayPath(CTX.cwd, CTX), '.');
  assert.equal(displayPath('/Users/me/.claude/settings.json', CTX), '~/.claude/settings.json');
  assert.equal(displayPath('/etc/hosts', CTX), '/etc/hosts');
  assert.equal(displayPath('relative/thing.js', CTX), 'relative/thing.js');
  assert.equal(displayPath('', CTX), '');
  assert.equal(displayPath(null, CTX), '');
});

test('displayPath normalises Windows separators and works without a home', () => {
  assert.equal(displayPath('C:\\Users\\j\\proj\\a.js', { cwd: 'C:/Users/j/proj' }), 'a.js');
  assert.equal(displayPath('/var/log/x', {}), '/var/log/x');
});

test('guessHome finds the home folder inside an absolute cwd', () => {
  assert.equal(guessHome('/Users/me/Documents/x'), '/Users/me');
  assert.equal(guessHome('/home/jo/src'), '/home/jo');
  assert.equal(guessHome('/opt/thing'), null);
  assert.equal(guessHome(undefined), null);
});

test('elidePath keeps the first and last segment', () => {
  assert.equal(elidePath('short/path.js', 60), 'short/path.js');
  assert.equal(elidePath('a/b/c/d/e/f/g/verylongname.js', 16), 'a/…/verylongname.js'.slice(0, 15) + '…');
  const abs = elidePath('/Users/me/Documents/GitHub/agent-workspace/web/js/renderer/iso2d/primitives.js', 40);
  assert.ok(abs.startsWith('/Users/'), `absolute paths keep a single leading slash: ${abs}`);
  assert.ok(abs.endsWith('primitives.js'));
  assert.ok(!abs.startsWith('//'));
  assert.equal(elidePath('nosep-but-really-quite-long-indeed.js', 12).length, 12);
});

test('expandHome only touches a leading ~', () => {
  assert.equal(expandHome('~/x', { home: '/Users/me' }), '/Users/me/x');
  assert.equal(expandHome('~', { home: '/Users/me' }), '/Users/me');
  assert.equal(expandHome('/abs/~/x', { home: '/Users/me' }), '/abs/~/x');
  assert.equal(expandHome(7), '');
});
