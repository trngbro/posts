const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Normalizes file paths to use forward slashes.
 */
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Calculates SHA256 hex hash of a Buffer or String.
 */
function getSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Helper to parse YAML scalar and array values into JS types.
 */
function parseYamlValue(rawVal) {
  if (rawVal === 'null' || rawVal === '~' || rawVal === '') {
    return null;
  }
  if (rawVal === 'true') return true;
  if (rawVal === 'false') return false;

  try {
    return JSON.parse(rawVal);
  } catch (e) {
    if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
      return rawVal.slice(1, -1);
    }
    if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
      return Number(rawVal);
    }
    return rawVal;
  }
}

/**
 * Minimal, zero-dependency YAML frontmatter parser for frontmatter metadata.
 */
function parseFrontmatter(text) {
  const normalizedText = text.replace(/\r\n/g, '\n');
  if (!normalizedText.startsWith('---')) {
    return { frontmatter: {}, body: normalizedText.trim() };
  }

  const endIdx = normalizedText.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: normalizedText.trim() };
  }

  const yamlBlock = normalizedText.slice(3, endIdx).trim();
  const body = normalizedText.slice(endIdx + 4).trim();
  const frontmatter = {};

  const lines = yamlBlock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();

    frontmatter[key] = parseYamlValue(rawVal);
  }

  return { frontmatter, body };
}

/**
 * Derives default `uri` and `parent` based on relative path within `uploads/`.
 */
function deriveUriAndParent(relPathInUploads) {
  const relPathNoExt = relPathInUploads.replace(/\.(md|mdx)$/i, '');
  const parts = relPathNoExt.split('/').filter(Boolean);

  if (parts.length > 0 && parts[parts.length - 1] === 'index') {
    parts.pop();
  }

  let defaultUri;
  let defaultParent;

  if (parts.length === 0) {
    defaultUri = '/';
    defaultParent = null;
  } else {
    defaultUri = '/' + parts.join('/');
    const parentParts = parts.slice(0, -1);
    defaultParent = parentParts.length > 0 ? '/' + parentParts.join('/') : null;
  }

  return { defaultUri, defaultParent };
}

/**
 * Recursively scans directory for files.
 */
function scanFilesRecursively(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) return fileList;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanFilesRecursively(fullPath, fileList);
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Builds or updates the index.json data structure.
 */
function buildIndex(rootDir = process.cwd()) {
  const uploadsDir = path.join(rootDir, 'uploads');
  const indexPath = path.join(rootDir, 'index.json');

  let oldIndex = { nodes: [] };
  if (fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      oldIndex = JSON.parse(content);
    } catch (e) {
      console.warn('Existing index.json could not be parsed. Rebuilding from scratch.');
    }
  }

  const oldNodesMap = new Map();
  if (Array.isArray(oldIndex.nodes)) {
    for (const node of oldIndex.nodes) {
      oldNodesMap.set(node.id, node);
    }
  }

  const currentDiskFiles = scanFilesRecursively(uploadsDir);
  const currentDiskFilePaths = new Set();
  const folderPaths = new Set(['uploads']);

  const newNodesMap = new Map();

  // Root node
  newNodesMap.set('root', {
    id: 'root',
    parent: null,
    type: 'root',
    data: {
      name: 'root',
      path: 'uploads'
    }
  });

  const nowIso = new Date().toISOString();

  for (const fullFilePath of currentDiskFiles) {
    const relPath = normalizePath(path.relative(rootDir, fullFilePath));
    currentDiskFilePaths.add(relPath);

    // Track all ancestor folders
    let currentDir = path.dirname(relPath);
    while (currentDir && currentDir !== '.' && currentDir.startsWith('uploads')) {
      folderPaths.add(normalizePath(currentDir));
      const nextDir = path.dirname(currentDir);
      if (nextDir === currentDir) break;
      currentDir = nextDir;
    }

    const fileBuffer = fs.readFileSync(fullFilePath);
    const fileHash = getSha256(fileBuffer);
    const ext = path.extname(relPath).toLowerCase();
    const isMarkdown = ext === '.md' || ext === '.mdx';
    const fileName = path.basename(relPath);

    const fileId = `file:${relPath}`;
    const oldFileNode = oldNodesMap.get(fileId);

    let updatedAt = nowIso;
    if (oldFileNode && oldFileNode.data && oldFileNode.data.hash === fileHash) {
      updatedAt = oldFileNode.data.updated_at || null;
    }

    const parentFolderDir = normalizePath(path.dirname(relPath));
    const fileParentId = `folder:${parentFolderDir}`;

    const fileNode = {
      id: fileId,
      parent: fileParentId,
      type: 'file',
      data: {
        name: fileName,
        path: relPath,
        extension: ext,
        is_markdown: isMarkdown,
        hash: fileHash,
        updated_at: updatedAt
      }
    };

    newNodesMap.set(fileId, fileNode);

    if (isMarkdown) {
      const contentId = `content:${relPath}`;
      const oldContentNode = oldNodesMap.get(contentId);

      if (oldFileNode && oldFileNode.data && oldFileNode.data.hash === fileHash && oldContentNode) {
        newNodesMap.set(contentId, oldContentNode);
      } else {
        const textContent = fileBuffer.toString('utf8');
        const { frontmatter, body } = parseFrontmatter(textContent);
        const relPathInUploads = normalizePath(path.relative(uploadsDir, fullFilePath));
        const { defaultUri, defaultParent } = deriveUriAndParent(relPathInUploads);

        const uri = (frontmatter.uri !== undefined && frontmatter.uri !== null && String(frontmatter.uri).trim() !== '')
          ? String(frontmatter.uri).trim()
          : defaultUri;

        let parentUri;
        if (frontmatter.parent !== undefined) {
          if (frontmatter.parent === null || String(frontmatter.parent).trim() === '' || String(frontmatter.parent).trim() === 'null') {
            parentUri = null;
          } else {
            parentUri = String(frontmatter.parent).trim();
          }
        } else {
          parentUri = defaultParent;
        }

        const title = (frontmatter.title !== undefined && frontmatter.title !== null)
          ? String(frontmatter.title)
          : null;

        const excerpt = body.slice(0, 250);

        const contentNode = {
          id: contentId,
          parent: fileId,
          type: 'content',
          data: {
            path: relPath,
            uri: uri,
            parent: parentUri,
            title: title,
            excerpt: excerpt,
            language: ext === '.mdx' ? 'mdx' : 'markdown',
            metadata: frontmatter
          }
        };

        newNodesMap.set(contentId, contentNode);
      }
    }
  }

  // Create folder nodes
  for (const folderPath of folderPaths) {
    const folderId = `folder:${folderPath}`;
    let folderParentId;
    if (folderPath === 'uploads') {
      folderParentId = 'root';
    } else {
      const parentDir = normalizePath(path.dirname(folderPath));
      folderParentId = `folder:${parentDir}`;
    }

    newNodesMap.set(folderId, {
      id: folderId,
      parent: folderParentId,
      type: 'folder',
      data: {
        name: path.basename(folderPath),
        path: folderPath
      }
    });
  }

  // Prune empty folders iteratively (except folder:uploads)
  let nodesList = Array.from(newNodesMap.values());
  let changed = true;
  while (changed) {
    changed = false;
    const activeParents = new Set(nodesList.map(n => n.parent).filter(Boolean));
    nodesList = nodesList.filter(node => {
      if (node.type === 'folder' && node.id !== 'folder:uploads') {
        if (!activeParents.has(node.id)) {
          changed = true;
          return false;
        }
      }
      return true;
    });
  }

  // Sort nodes deterministically
  nodesList.sort((a, b) => {
    if (a.id === 'root') return -1;
    if (b.id === 'root') return 1;
    return a.id.localeCompare(b.id);
  });

  const finalOutput = { nodes: nodesList };

  // Validate JSON
  const jsonString = JSON.stringify(finalOutput, null, 2);
  JSON.parse(jsonString); // Will throw if invalid

  fs.writeFileSync(indexPath, jsonString, 'utf8');
  console.log(`Successfully updated index.json with ${nodesList.length} nodes.`);

  return finalOutput;
}

if (require.main === module) {
  buildIndex(process.cwd());
}

module.exports = {
  buildIndex,
  parseFrontmatter,
  deriveUriAndParent,
  getSha256
};
