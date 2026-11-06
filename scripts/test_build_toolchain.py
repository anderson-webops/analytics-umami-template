import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("npm_toolchain_package", Path(__file__).with_name("package-npm-toolchain.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class BuildToolchainPackageTests(unittest.TestCase):
    def fixture(self, extra=None):
        members = [
            ("package/package.json", json.dumps({"name": "npm", "version": "12.2.2", "bundleDependencies": ["fixture"], "dependencies": {"fixture": "1.0.0"}}).encode()),
            ("package/LICENSE", b"original license\n"),
            ("package/bin/npm-cli.js", b"original CLI code\n"),
            ("package/node_modules/fixture/index.js", b"bundled dependency\n"),
        ]
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, payload in members:
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                member.mode = 0o755 if name.endswith("npm-cli.js") else 0o644
                archive.addfile(member, io.BytesIO(payload))
            if extra is not None:
                archive.addfile(extra)
        original = output.getvalue()
        metadata = {"npm": "12.2.2", "upstreamIntegrity": "sha512-" + base64.b64encode(hashlib.sha512(original).digest()).decode()}
        return original, metadata

    def rebuild(self, original, metadata):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent / ".ai-work/runs") as directory:
            source = Path(directory) / "upstream.tgz"
            source.write_bytes(original)
            return packager.rebuild(source, metadata)

    def test_reproducible_package_preserves_original_code_license_modes_and_dependency_ranges(self):
        original, metadata = self.fixture()
        first, records = self.rebuild(original, metadata)
        second, repeated = self.rebuild(original, metadata)
        self.assertEqual(first, second)
        self.assertEqual(records, repeated)
        with tarfile.open(fileobj=io.BytesIO(first), mode="r:gz") as archive:
            self.assertEqual(set(archive.getnames()), {"package/package.json", "package/LICENSE", "package/bin/npm-cli.js"})
            manifest = json.load(archive.extractfile("package/package.json"))
            self.assertNotIn("bundleDependencies", manifest)
            self.assertEqual(manifest["dependencies"], {"fixture": "1.0.0"})
            self.assertEqual(archive.extractfile("package/LICENSE").read(), b"original license\n")
            self.assertEqual(archive.extractfile("package/bin/npm-cli.js").read(), b"original CLI code\n")
            self.assertEqual(archive.getmember("package/bin/npm-cli.js").mode, 0o755)
        self.assertEqual(sum(entry["upstreamSha256"] != entry["sha256"] for entry in records), 1)

    def test_tampered_upstream_is_rejected_before_unpacking(self):
        original, metadata = self.fixture()
        with self.assertRaisesRegex(ValueError, "upstream integrity"):
            self.rebuild(original + b"changed", metadata)

    def test_archive_is_independent_of_interpreter_compression_defaults(self):
        original, metadata = self.fixture()
        expected, records = self.rebuild(original, metadata)
        original_gzip = packager.gzip.GzipFile
        for compression_default in [6, 9]:
            with self.subTest(compression_default=compression_default):
                def changed_default(*args, **kwargs):
                    if len(args) < 3:
                        kwargs.setdefault("compresslevel", compression_default)
                    return original_gzip(*args, **kwargs)
                with patch.object(packager.gzip, "GzipFile", side_effect=changed_default):
                    actual, repeated = self.rebuild(original, metadata)
                self.assertEqual(actual, expected)
                self.assertEqual(repeated, records)

    def test_links_traversal_and_duplicate_members_are_rejected(self):
        for name, link in [("package/../outside", False), ("/outside", False), ("package/LICENSE", False), ("package/linked", True)]:
            with self.subTest(name=name, link=link):
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/outside"
                original, metadata = self.fixture(member)
                with self.assertRaisesRegex(ValueError, "archive member"):
                    self.rebuild(original, metadata)


if __name__ == "__main__":
    unittest.main()
