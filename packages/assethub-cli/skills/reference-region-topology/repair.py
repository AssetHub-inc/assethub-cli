"""Transfer a native face patch through a common disk parameterization in Blender."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import tessellate_polygon


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_obj(path, group=None):
    require(path.stat().st_size <= 32_000_000, "OBJ exceeds 32 MB")
    vertices, faces, selection = [], [], []
    active_groups = []
    for line in path.read_text().splitlines():
        fields = line.split("#", 1)[0].split()
        if not fields:
            continue
        kind, *values = fields
        if kind == "v" and len(values) == 3:
            vertices.append(list(map(float, values)))
        elif kind == "f" and 3 <= len(values) <= 32:
            face = [int(i) - 1 for i in values]
            require(
                min(face) >= 0
                and max(face) < len(vertices)
                and len(set(face)) == len(face),
                "Invalid face",
            )
            if group in active_groups:
                selection.append(len(faces))
            faces.append(face)
        elif kind == "g":
            active_groups = values
        else:
            require(
                kind in ("o", "g", "s"),
                "Geometry-only OBJ required; retain the authored scene separately",
            )
    points = np.array(vertices)
    require(len(faces) and np.isfinite(points).all(), "Empty or nonfinite mesh")
    return points, faces, selection


def disk(points, faces, selection, boundary):
    require(
        0 < len(selection) <= 4096 and len(set(selection)) == len(selection),
        "Invalid patch size or duplicate faces",
    )
    require(
        all(type(i) is int and 0 <= i < len(faces) for i in selection),
        "Invalid face selection",
    )
    patch = [faces[i] for i in selection]
    ids = sorted({v for face in patch for v in face})
    local = {v: i for i, v in enumerate(ids)}
    polygons = [[local[v] for v in face] for face in patch]
    require(len(ids) <= 1500, "Patch exceeds parameterization budget")
    directed = Counter((a, b) for f in polygons for a, b in zip(f, f[1:] + f[:1]))
    require(max(directed.values()) == 1, "Nonmanifold or inconsistent winding")
    rim = {(a, b) for a, b in directed if (b, a) not in directed}
    if isinstance(boundary, int):
        start = local[boundary]
        following = dict(rim)
        require(
            len(following) == len(rim) and start in following,
            "Anchor must be on a simple patch boundary",
        )
        ring = [start]
        seen = {start}
        while following[ring[-1]] not in seen:
            ring.append(following[ring[-1]])
            seen.add(ring[-1])
        require(following[ring[-1]] == start, "Boundary does not close")
    else:
        ring = [local[i] for i in boundary]
    require(
        len(set(ring)) == len(ring) >= 3 and set(zip(ring, ring[1:] + ring[:1])) == rim,
        "Supply the entire oriented boundary, starting at corresponding landmarks",
    )
    reached = {ring[0]}
    adjacency = defaultdict(set)
    for a, b in directed:
        adjacency[a].add(b)
        adjacency[b].add(a)
    todo = list(reached)
    while todo:
        unseen = adjacency[todo.pop()] - reached
        reached.update(unseen)
        todo.extend(unseen)
    require(len(reached) == len(ids), "Disconnected patch")
    edges = {tuple(sorted(edge)) for edge in directed}
    require(len(ids) - len(edges) + len(polygons) == 1, "Expected one disk")
    p = points[ids]
    tris = []
    for face in polygons:
        triangles = tessellate_polygon([[Vector(p[v]) for v in face]])
        require(len(triangles) == len(face) - 2, "Cannot tessellate face")
        tris.extend([[face[i] for i in t] for t in triangles])
    triangles = np.array(tris)
    neighbors = defaultdict(set)
    for a, b, c in triangles:
        for u, v in ((a, b), (b, c), (c, a)):
            neighbors[u].add(v)
            neighbors[v].add(u)
    uv = np.zeros((len(ids), 2))
    angle = np.arange(len(ring)) * 2 * np.pi / len(ring)
    uv[ring] = np.column_stack((np.cos(angle), np.sin(angle)))
    inside = sorted(set(range(len(ids))) - set(ring))
    if inside:
        equation = np.eye(len(ids))
        for i in inside:
            equation[i, list(neighbors[i])] = -1 / len(neighbors[i])
        uv[inside] = np.linalg.solve(
            equation[np.ix_(inside, inside)], -equation[np.ix_(inside, ring)] @ uv[ring]
        )
    a, b, c = uv[triangles].transpose(1, 0, 2)
    signed = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (
        c[:, 0] - a[:, 0]
    )
    require(np.all(signed > 1e-10), "Folded or degenerate disk parameterization")
    return ids, polygons, triangles, uv, inside, [ids[v] for v in ring]


def samples(points, tris):
    t = points[tris]
    return np.vstack(
        (
            points,
            t.mean(axis=1),
            (t[:, 0] + t[:, 1]) / 2,
            (t[:, 1] + t[:, 2]) / 2,
            (t[:, 2] + t[:, 0]) / 2,
        )
    )


def deviations(points, triangles, other_points, other_triangles):
    tree = BVHTree.FromPolygons(
        other_points.tolist(), other_triangles.tolist(), all_triangles=True
    )
    distances = [tree.find_nearest(p)[3] for p in samples(points, triangles)]
    return {"p95": float(np.percentile(distances, 95)), "max": float(max(distances))}


def transfer(job, base, out):
    meshes = []
    for key in ("reference", "target"):
        spec = job[key]
        path = base / spec["file"]
        require(sha(path) == spec["sha256"], key + " hash mismatch")
        require(
            ("group" in spec) != ("faces" in spec),
            "Supply either a named face group or face indices",
        )
        require(
            ("anchor" in spec) != ("boundary" in spec),
            "Supply a boundary anchor or the full ordered boundary",
        )
        points, faces, group_faces = read_obj(path, spec.get("group"))
        selected = spec.get("faces", group_faces)
        patch = disk(points, faces, selected, spec.get("boundary", spec.get("anchor")))
        meshes.append((points, faces, patch))
        spec["faces"] = selected
        spec["boundary"] = patch[-1]
    _, _, (ri, rf, rt, ru, interior, _) = meshes[0]
    target, faces, (ti, tf, tt, tu, old_interior, _) = meshes[1]
    ref, dst = job["reference"], job["target"]
    require(
        len(ref["boundary"]) == len(dst["boundary"]),
        "Boundary correspondence count differs",
    )
    tolerance = job["maxSurfaceDeviation"]
    require(
        type(tolerance) in (float, int) and np.isfinite(tolerance) and tolerance >= 0,
        "Invalid surface tolerance",
    )
    removed = set(dst["faces"])
    outside = [f for i, f in enumerate(faces) if i not in removed]
    deleted = {ti[i] for i in old_interior}
    require(
        not any(deleted.intersection(f) for f in outside),
        "Patch interior touches a protected face",
    )
    uv3 = np.column_stack((tu, np.zeros(len(tu))))
    tree = BVHTree.FromPolygons(uv3.tolist(), tt.tolist(), all_triangles=True)
    candidate = np.zeros((len(ri), 3))
    dest_points = target[ti]
    source_local = {v: i for i, v in enumerate(ri)}
    vertex_map = {}
    for u, v in zip(ref["boundary"], dst["boundary"]):
        i = source_local[u]
        candidate[i] = target[v]
        vertex_map[i] = v
    for k, i in enumerate(interior):
        hit, _, idx, distance = tree.find_nearest((*ru[i], 0))
        require(
            hit is not None and distance < 1e-5, "No target point for reference vertex"
        )
        tri = tt[idx]
        weights = np.linalg.solve(np.vstack((tu[tri].T, np.ones(3))), [*ru[i], 1])
        require(min(weights) > -1e-5, "Point outside target triangle")
        candidate[i] = weights @ dest_points[tri]
        vertex_map[i] = len(target) + k

    # Keep landmarks and face cycles fixed. Try nearby points on the target and
    # retain a step only if neither direction's P95 or maximum regresses.
    def score(coords):
        triangles = []
        for face in rf:
            local_tris = tessellate_polygon([[Vector(coords[v]) for v in face]])
            if len(local_tris) != len(face) - 2:
                return None
            triangles.extend([[face[k] for k in tri] for tri in local_tris])
        ot = np.asarray(triangles)
        old_normals = np.cross(
            candidate[ot[:, 1]] - candidate[ot[:, 0]],
            candidate[ot[:, 2]] - candidate[ot[:, 0]],
        )
        normals = np.cross(
            coords[ot[:, 1]] - coords[ot[:, 0]], coords[ot[:, 2]] - coords[ot[:, 0]]
        )
        if np.any((old_normals * normals).sum(axis=1) <= 0):
            return None
        a = deviations(dest_points, tt, coords, ot)
        b = deviations(coords, ot, dest_points, tt)
        return np.array([a["max"], b["max"], a["p95"], b["p95"]])

    history = []
    best = score(candidate)
    require(best is not None, "Initial candidate is degenerate")
    history.append(best.tolist())
    if (
        max(best[:2]) > tolerance
        and len(interior) <= 8
        and len(tf) <= 64
        and len(rf) <= 64
    ):
        target_tree = BVHTree.FromPolygons(
            dest_points.tolist(), tt.tolist(), all_triangles=True
        )
        for fraction in (0.25, 0.125, 0.0625):
            for i in interior:
                origin = candidate[i].copy()
                adjacent = sorted(
                    {v for face in rf if i in face for v in face if v != i}
                )
                for v in adjacent:
                    trial = candidate.copy()
                    hit = target_tree.find_nearest(
                        origin + fraction * (candidate[v] - origin)
                    )[0]
                    trial[i] = list(hit)
                    scores = score(trial)
                    if (
                        scores is not None
                        and np.all(scores <= best + 1e-9)
                        and max(scores[:2]) < max(best[:2]) - 1e-8
                    ):
                        candidate, best = trial, scores
                        history.append(best.tolist())
                if max(best[:2]) <= tolerance:
                    break
            if max(best[:2]) <= tolerance:
                break
    # Measure the actual output polygon triangulation; a curved quad can choose another diagonal.
    new_faces = [[vertex_map[v] for v in f] for f in rf]
    # Seam edges may be shared with the protected mesh, patch diagonals may not.
    def edge_counts(polygons):
        return Counter(tuple(sorted((a, b))) for face in polygons for a, b in zip(face, face[1:] + face[:1]))

    protected_edges = edge_counts(outside)
    for edge, uses in edge_counts(new_faces).items():
        require(uses + protected_edges[edge] <= 2, "Patch would create a nonmanifold edge on the protected mesh")
    vertices = np.vstack((target, candidate[interior]))
    all_faces = outside + new_faces
    used = sorted(set(range(len(vertices))) - deleted)
    renumber = {v: i for i, v in enumerate(used)}
    all_faces = [[renumber[v] for v in f] for f in all_faces]
    path = out / "candidate.obj"
    with path.open("x") as stream:
        for p in vertices[used]:
            print("v", *p.tolist(), file=stream)
        for f in all_faces:
            print("f", *[v + 1 for v in f], file=stream)
    q, g, _ = read_obj(path)
    require(
        g == all_faces and np.array_equal(q, vertices[used]),
        "Geometry changed on reload",
    )
    output_boundary = [renumber[v] for v in dst["boundary"]]
    oi, of, ot, _, _, _ = disk(q, g, list(range(len(outside), len(g))), output_boundary)
    new = q[oi]
    require(
        all(
            np.linalg.norm(np.cross(new[b] - new[a], new[c] - new[a])) > 1e-12
            for a, b, c in ot
        ),
        "Collapsed output triangle",
    )
    forward = deviations(dest_points, tt, new, ot)
    reverse = deviations(new, ot, dest_points, tt)
    return dict(
        region=job["region"],
        referenceFaces=len(rf),
        beforeFaces=len(tf),
        afterFaces=len(of),
        copiedFaceCycles=len(rf),
        boundaryVertices=len(output_boundary),
        boundaryMaxDisplacement=0,
        protectedFaces=len(outside),
        units=job["units"],
        trialScores=[
            dict(
                zip(
                    (
                        "targetToCandidateMax",
                        "candidateToTargetMax",
                        "targetToCandidateP95",
                        "candidateToTargetP95",
                    ),
                    row,
                )
            )
            for row in history
        ],
        targetToCandidate=forward,
        candidateToTarget=reverse,
        maxSurfaceDeviation=tolerance,
        surfaceWithinTolerance=max(forward["max"], reverse["max"]) <= tolerance,
        referenceSha256=ref["sha256"],
        targetSha256=dst["sha256"],
        candidateSha256=sha(path),
        status="needs_review",
        handoffAllowed=False,
    )


def main(args):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    options = parser.parse_args(args)
    job = json.loads(options.manifest.read_text())
    options.output.mkdir(parents=True, exist_ok=False)
    try:
        mode = job.get("method", "transfer_patch")
        if mode == "joint_ring_spacing":
            import runpy

            helper = Path(__file__).with_name("joint_rings.py")
            report = runpy.run_path(str(helper))["repair"](
                job, options.manifest.parent, options.output, read_obj, sha
            )
            report["ringMethodSha256"] = sha(helper)
        else:
            require(mode == "transfer_patch", "Unknown repair method")
            report = transfer(job, options.manifest.parent, options.output)
        if report.get("surfaceWithinTolerance") is False:
            (options.output / "candidate.obj").unlink()
            report["reason"] = (
                "Surface deviation exceeded the requested tolerance; trial discarded"
            )
    except (
        ValueError,
        KeyError,
        IndexError,
        OSError,
        TypeError,
        np.linalg.LinAlgError,
    ) as e:
        (options.output / "candidate.obj").unlink(missing_ok=True)
        report = dict(status="needs_review", handoffAllowed=False, reason=str(e))
    report["methodSha256"] = sha(Path(__file__))
    report["manifestSha256"] = sha(options.manifest)
    (options.output / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1 :])
