"""Run with python3 after building the CLI; BLENDER may name a headless executable."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

CLI = Path(__file__).resolve().parents[1] / "dist/index.js"


class RegionTopology(unittest.TestCase):
    def test_transfer_and_rejections(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ring = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\n"
            files = {
                "reference": ring
                + "v .5 .5 0\ng elbow\nf 1 2 5\nf 2 3 5\nf 3 4 5\nf 4 1 5\n",
                "target": ring + "g elbow\nf 1 2 3 4\n",
            }
            job = dict(region="elbow", units="cm", maxSurfaceDeviation=0.00001)
            for key, content in files.items():
                path = root / (key + ".obj")
                path.write_text(content)
                job[key] = dict(
                    file=path.name,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    group="elbow",
                    anchor=0,
                )

            def run(name, expected):
                manifest = root / "job.json"
                manifest.write_text(json.dumps(job))
                args = [
                    "node",
                    str(CLI),
                    "mesh-review",
                    "repair-region",
                    "--manifest",
                    str(manifest),
                    "--out",
                    str(root / name),
                ]
                if os.environ.get("BLENDER"):
                    args += ["--blender", os.environ["BLENDER"]]
                done = subprocess.run(args, capture_output=True, text=True)
                self.assertEqual(done.returncode, expected, done.stderr)
                return json.loads(done.stdout)

            report = run("ok", 0)
            self.assertEqual((report["beforeFaces"], report["afterFaces"]), (1, 4))
            self.assertEqual(report["boundaryMaxDisplacement"], 0)
            self.assertFalse(report["handoffAllowed"])
            self.assertTrue((root / "ok" / "candidate.obj").exists())
            for key, body in {
                "reference": ring + "g elbow\nf 1 2 3\nf 1 3 4\n",
                "target": ring + "v 0 0 1\ng elbow\nf 1 2 3 4\ng protected\nf 1 3 5\n",
            }.items():
                path = root / (key + ".obj")
                path.write_text(body)
                job[key]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertIn("nonmanifold", run("junction", 1)["reason"])
            self.assertFalse((root / "junction" / "candidate.obj").exists())
            job["target"]["group"] = "unmatched"
            self.assertIn("patch", run("missing", 1)["reason"])
            self.assertFalse((root / "missing" / "candidate.obj").exists())
            job["reference"]["sha256"] = "0" * 64
            self.assertIn("hash mismatch", run("stale", 1)["reason"])


if __name__ == "__main__":
    unittest.main()
