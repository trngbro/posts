const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildIndex, deriveUriAndParent, parseFrontmatter } = require('../scripts/build-index.js');

function createTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
  fs.mkdirSync(path.join(tmpDir, 'uploads'), { recursive: true });
  return tmpDir;
}

function removeTempDir(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

test('deriveUriAndParent rules', (t) => {
  // docs/guide.md -> /docs/guide, /docs
  const t1 = deriveUriAndParent('docs/guide.md');
  assert.equal(t1.defaultUri, '/docs/guide');
  assert.equal(t1.defaultParent, '/docs');

  // guide.md -> /guide, null
  const t2 = deriveUriAndParent('guide.md');
  assert.equal(t2.defaultUri, '/guide');
  assert.equal(t2.defaultParent, null);

  // docs/index.md -> /docs, null
  const t3 = deriveUriAndParent('docs/index.md');
  assert.equal(t3.defaultUri, '/docs');
  assert.equal(t3.defaultParent, null);

  // docs/sub/page.mdx -> /docs/sub/page, /docs/sub
  const t4 = deriveUriAndParent('docs/sub/page.mdx');
  assert.equal(t4.defaultUri, '/docs/sub/page');
  assert.equal(t4.defaultParent, '/docs/sub');

  // docs/sub/index.md -> /docs/sub, /docs
  const t5 = deriveUriAndParent('docs/sub/index.md');
  assert.equal(t5.defaultUri, '/docs/sub');
  assert.equal(t5.defaultParent, '/docs');
});

test('Acceptance Criteria 1: .md file with explicit uri & parent in frontmatter', () => {
  const tmpDir = createTempDir();
  try {
    const mdPath = path.join(tmpDir, 'uploads', 'custom.md');
    fs.writeFileSync(mdPath, `---
title: Custom Title
uri: /custom/my-uri
parent: /custom/my-parent
---
# Custom Page
Body text here.`);

    const output = buildIndex(tmpDir);
    const contentNode = output.nodes.find(n => n.id === 'content:uploads/custom.md');

    assert.ok(contentNode);
    assert.equal(contentNode.data.uri, '/custom/my-uri');
    assert.equal(contentNode.data.parent, '/custom/my-parent');
    assert.equal(contentNode.data.title, 'Custom Title');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 2: .mdx file without uri/parent fallback derivation', () => {
  const tmpDir = createTempDir();
  try {
    const subDir = path.join(tmpDir, 'uploads', 'docs', 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const mdxPath = path.join(subDir, 'page.mdx');
    fs.writeFileSync(mdxPath, `# MDX Page
Hello MDX!`);

    const output = buildIndex(tmpDir);
    const contentNode = output.nodes.find(n => n.id === 'content:uploads/docs/sub/page.mdx');

    assert.ok(contentNode);
    assert.equal(contentNode.data.uri, '/docs/sub/page');
    assert.equal(contentNode.data.parent, '/docs/sub');
    assert.equal(contentNode.data.language, 'mdx');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 3: Image file (.png) creates file node without content node', () => {
  const tmpDir = createTempDir();
  try {
    const imgPath = path.join(tmpDir, 'uploads', 'image.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const output = buildIndex(tmpDir);
    const fileNode = output.nodes.find(n => n.id === 'file:uploads/image.png');
    const contentNode = output.nodes.find(n => n.id === 'content:uploads/image.png');

    assert.ok(fileNode);
    assert.equal(fileNode.data.is_markdown, false);
    assert.equal(fileNode.data.extension, '.png');
    assert.equal(contentNode, undefined);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 4: Editing existing .md updates content node and hash', () => {
  const tmpDir = createTempDir();
  try {
    const mdPath = path.join(tmpDir, 'uploads', 'post.md');
    fs.writeFileSync(mdPath, 'Original content');
    const firstOutput = buildIndex(tmpDir);

    const firstFile = firstOutput.nodes.find(n => n.id === 'file:uploads/post.md');
    const firstContent = firstOutput.nodes.find(n => n.id === 'content:uploads/post.md');

    assert.equal(firstContent.data.excerpt, 'Original content');

    // Edit file
    fs.writeFileSync(mdPath, 'Updated content!');
    const secondOutput = buildIndex(tmpDir);

    const secondFile = secondOutput.nodes.find(n => n.id === 'file:uploads/post.md');
    const secondContent = secondOutput.nodes.find(n => n.id === 'content:uploads/post.md');

    assert.notEqual(firstFile.data.hash, secondFile.data.hash);
    assert.equal(secondContent.data.excerpt, 'Updated content!');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 5: Deleting a file removes node and prunes empty folders (except uploads)', () => {
  const tmpDir = createTempDir();
  try {
    const folderPath = path.join(tmpDir, 'uploads', 'isolated');
    fs.mkdirSync(folderPath, { recursive: true });
    const filePath = path.join(folderPath, 'temp.md');
    fs.writeFileSync(filePath, 'Temp content');

    buildIndex(tmpDir);

    // Verify folder existed
    let indexData = JSON.parse(fs.readFileSync(path.join(tmpDir, 'index.json'), 'utf8'));
    assert.ok(indexData.nodes.some(n => n.id === 'folder:uploads/isolated'));

    // Delete file
    fs.unlinkSync(filePath);
    const updatedOutput = buildIndex(tmpDir);

    assert.equal(updatedOutput.nodes.some(n => n.id === 'file:uploads/isolated/temp.md'), false);
    assert.equal(updatedOutput.nodes.some(n => n.id === 'content:uploads/isolated/temp.md'), false);
    assert.equal(updatedOutput.nodes.some(n => n.id === 'folder:uploads/isolated'), false);
    assert.ok(updatedOutput.nodes.some(n => n.id === 'folder:uploads'));
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 6: Idempotency (running twice produces identical output)', () => {
  const tmpDir = createTempDir();
  try {
    const mdPath = path.join(tmpDir, 'uploads', 'doc.md');
    fs.writeFileSync(mdPath, 'Static content');

    const run1 = buildIndex(tmpDir);
    const run2 = buildIndex(tmpDir);

    assert.deepEqual(run1, run2);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('Acceptance Criteria 7: Deeply nested files create all intermediate folders', () => {
  const tmpDir = createTempDir();
  try {
    const deepDir = path.join(tmpDir, 'uploads', 'a', 'b', 'c');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, 'd.md'), 'Deep content');

    const output = buildIndex(tmpDir);

    assert.ok(output.nodes.some(n => n.id === 'folder:uploads'));
    assert.ok(output.nodes.some(n => n.id === 'folder:uploads/a'));
    assert.ok(output.nodes.some(n => n.id === 'folder:uploads/a/b'));
    assert.ok(output.nodes.some(n => n.id === 'folder:uploads/a/b/c'));
    assert.ok(output.nodes.some(n => n.id === 'file:uploads/a/b/c/d.md'));
  } finally {
    removeTempDir(tmpDir);
  }
});
