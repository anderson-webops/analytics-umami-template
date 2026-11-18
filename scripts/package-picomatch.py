import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'vendor/picomatch'
ORIGINAL_NAMES = {
    'package/LICENSE', 'package/README.md', 'package/index.js',
    'package/lib/constants.js', 'package/lib/parse.js',
    'package/lib/picomatch.js', 'package/lib/scan.js', 'package/lib/utils.js',
    'package/package.json', 'package/posix.js',
}


def rebuild(original, metadata, guard):
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(original).digest()).decode()
    if integrity != metadata['registryIntegrity']:
        raise ValueError('Picomatch original archive differs from its reviewed registry identity')
    output = io.BytesIO()
    records = []
    with tarfile.open(fileobj=io.BytesIO(original), mode='r:gz') as upstream:
        members = upstream.getmembers()
        if len(members) != len(ORIGINAL_NAMES) or {entry.name for entry in members} != ORIGINAL_NAMES:
            raise ValueError('Unexpected or repeated original Picomatch member')
        with gzip.GzipFile(fileobj=output, mode='wb', compresslevel=6, mtime=0, filename='') as compressed:
            with tarfile.open(fileobj=compressed, mode='w|') as archive:
                for member in members:
                    parts = PurePosixPath(member.name).parts
                    if not member.isfile() or '..' in parts or member.mode != 0o644:
                        raise ValueError('Unexpected original Picomatch member type or mode')
                    payload = upstream.extractfile(member).read()
                    original_digest = hashlib.sha256(payload).hexdigest()
                    if member.name == 'package/package.json':
                        manifest = json.loads(payload)
                        if manifest['name'] != metadata['name'] or manifest['version'] != metadata['version']:
                            raise ValueError('Unexpected original Picomatch package identity')
                        manifest['version'] = metadata['patchedVersion']
                        manifest['private'] = True
                        payload = (json.dumps(manifest, indent=2) + '\n').encode()
                    if member.name == 'package/lib/parse.js':
                        before = b"const utils = require('./utils');"
                        after = before + b"\nconst hasUnsafeRepeatedOutput = require('./repeated-output');"
                        if payload.count(before) != 1:
                            raise ValueError('Original Picomatch parser import boundary changed')
                        payload = payload.replace(before, after)
                        before = b"    if ((token.type === 'plus' || token.type === 'star') && analysis.risky) {"
                        after = (
                            b"    const repeatedOutput = tokens.slice(token.tokensIndex + 2)\n"
                            b"      .map(part => part.output === undefined ? part.value : part.output).join('');\n"
                            b"    if ((token.type === 'plus' || token.type === 'star')\n"
                            b"      && (analysis.risky || hasUnsafeRepeatedOutput(repeatedOutput, opts))) {"
                        )
                        if payload.count(before) != 1:
                            raise ValueError('Original Picomatch repeated-extglob boundary changed')
                        payload = payload.replace(before, after)
                        before = b'      open.output = safeOutput || utils.escapeRegex(literal);'
                        after = br"      open.output = safeOutput || utils.escapeRegex(literal.replace(/\\/g, '\\\\'));"
                        if payload.count(before) != 1:
                            raise ValueError('Original Picomatch literalization boundary changed')
                        payload = payload.replace(before, after)
                    entry = tarfile.TarInfo(member.name)
                    entry.mode = member.mode
                    entry.size = len(payload)
                    archive.addfile(entry, io.BytesIO(payload))
                    records.append({'path': member.name, 'upstreamSha256': original_digest,
                                    'sha256': hashlib.sha256(payload).hexdigest()})
                entry = tarfile.TarInfo('package/lib/repeated-output.js')
                entry.mode = 0o644
                entry.size = len(guard)
                archive.addfile(entry, io.BytesIO(guard))
    return output.getvalue(), records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    arguments = parser.parse_args()
    record_path = SOURCE / 'UPSTREAM.json'
    metadata = json.loads(record_path.read_text())
    original = (SOURCE / 'upstream/picomatch-4.0.7.tgz').read_bytes()
    guard = (SOURCE / 'repeated-output.cjs').read_bytes()
    payload, records = rebuild(original, metadata, guard)
    paths = [ROOT / 'vendor/picomatch-4.0.7-webops.1.tgz',
             ROOT / 'build-toolchain/vendor/picomatch-4.0.7-webops.1.tgz']
    computed = {
        'archiveSha256': hashlib.sha256(payload).hexdigest(),
        'guardSha256': hashlib.sha256(guard).hexdigest(),
        'files': records,
    }
    if arguments.check:
        if any(destination.read_bytes() != payload for destination in paths):
            raise ValueError('Maintained Picomatch archives do not reproduce')
        if any(metadata.get(key) != value for key, value in computed.items()):
            raise ValueError('Picomatch provenance differs from the verified source')
    else:
        for destination in paths:
            destination.write_bytes(payload)
        metadata.update(computed)
        record_path.write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps({'originalFiles': len(records), 'modifiedOriginalFiles': sum(
        record['sha256'] != record['upstreamSha256'] for record in records),
        'archiveSha256': computed['archiveSha256']}))


if __name__ == '__main__':
    main()
