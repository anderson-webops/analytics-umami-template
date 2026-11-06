import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


def rebuild(source_path, metadata):
    original = source_path.read_bytes()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(original).digest()).decode()
    if integrity != metadata["upstreamIntegrity"]:
        raise ValueError("npm upstream integrity differs from the reviewed source")
    output = io.BytesIO()
    retained = []
    names = set()
    with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as source:
        with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=6, mtime=0, filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as archive:
                for member in source.getmembers():
                    parts = PurePosixPath(member.name).parts
                    if (not parts or parts[0] != "package" or ".." in parts or "\\" in member.name
                            or PurePosixPath(member.name).as_posix() != member.name
                            or not member.isfile() or member.name in names):
                        raise ValueError("invalid or repeated upstream archive member")
                    names.add(member.name)
                    if "node_modules" in parts:
                        continue
                    payload = source.extractfile(member).read()
                    original_digest = hashlib.sha256(payload).hexdigest()
                    if member.name == "package/package.json":
                        manifest = json.loads(payload)
                        if manifest["name"] != "npm" or manifest["version"] != metadata["npm"]:
                            raise ValueError("unexpected upstream npm identity")
                        manifest.pop("bundleDependencies", None)
                        manifest.pop("bundledDependencies", None)
                        payload = (json.dumps(manifest, indent=2) + "\n").encode()
                    entry = tarfile.TarInfo(member.name)
                    entry.size = len(payload)
                    entry.mode = member.mode
                    entry.mtime = 0
                    archive.addfile(entry, io.BytesIO(payload))
                    retained.append({"path": member.name, "upstreamSha256": original_digest,
                                     "sha256": hashlib.sha256(payload).hexdigest()})
    if not retained or "package/bin/npm-cli.js" not in names or "package/LICENSE" not in names:
        raise ValueError("incomplete upstream npm distribution")
    return output.getvalue(), retained


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("upstream", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent.parent / "build-toolchain"
    record = directory / "UPSTREAM.json"
    metadata = json.loads(record.read_text())
    archive_name = PurePosixPath(metadata["archive"])
    if archive_name.parts != ("vendor", f"npm-{metadata['npm']}-webops.1.tgz"):
        raise ValueError("unexpected toolchain archive destination")
    payload, files = rebuild(args.upstream, metadata)
    archive = directory / str(archive_name)
    digest = hashlib.sha256(payload).hexdigest()
    if args.check:
        if payload != archive.read_bytes() or files != metadata["files"] or digest != metadata["archiveSha256"]:
            raise ValueError("toolchain archive does not reproduce the reviewed upstream source")
        if hashlib.sha256((directory / "package-lock.json").read_bytes()).hexdigest() != metadata["lockSha256"]:
            raise ValueError("toolchain lock differs from its reviewed identity")
    else:
        archive.parent.mkdir(exist_ok=True)
        archive.write_bytes(payload)
        metadata["archiveSha256"] = digest
        metadata["files"] = files
        if (directory / "package-lock.json").exists():
            metadata["lockSha256"] = hashlib.sha256((directory / "package-lock.json").read_bytes()).hexdigest()
        record.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Verified {len(files)} original npm CLI files; only packaging metadata differs.")


if __name__ == "__main__":
    main()
