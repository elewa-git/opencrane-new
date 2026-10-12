export function newDumpFiles(before, after) {
  const previous = new Map();
  for (const file of before) previous.set(file.path, file);
  const dumps = [];
  for (const file of after) {
    if (!file.dump) continue;
    const old = previous.get(file.path);
    if (!old || old.sha256 !== file.sha256 || old.inode !== file.inode
        || old.mtimeNs !== file.mtimeNs) dumps.push(file.path);
  }
  return dumps;
}
